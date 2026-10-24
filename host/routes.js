/**
 * HTTP surface.
 *
 * Every route the Client and the agent tools speak to. `index.js` is then only
 * wiring: constants, factory calls and `apply`.
 *
 * The injection list is not hand-written - it is the exact set TypeScript reports
 * as "Cannot find name" for this file in isolation, with everything the shared
 * module already owns imported directly instead. Earlier attempts failed because
 * a hand-rolled regex guessed that list.
 *
 * @module @local/dsh-device-mirror/host/routes
 */
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { sleep, simctlCurrentState, simctlFirstError, run, clamp, runBuffer, note, diagnostics } from './shared.js';

/**
 * @param {object} deps - the entry file's wiring.
 * @returns {{handleRequest: Function}} the dispatcher `apply` registers.
 */
export function createRoutes(deps) {
  const {
    AVD_BOOT_TIMEOUT_MS,
    BOUNDARY,
    EMULATOR_BIN,
    FIRST_FRAME_TIMEOUT_MS,
    PLUGIN_VERSION,
    ROUTE_PREFIX,
    acquire,
    bootArgs,
    clientReports,
    countAttachedDevices,
    createAndroidAvd,
    emulatorGrpc,
    injectAndroid,
    injectIos,
    inputGeometry,
    invalidateGeometry,
    listAndroid,
    listAvds,
    listDeviceProfiles,
    listIos,
    listSystemImages,
    pickGrpcPort,
    producers,
    resolveDevice,
    runningAvds,
    streamDebug,
    waitForAvdBoot,
    waitForSimulatorBoot,
  } = deps;

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(text);
}

function sameOriginOnly(req) {
  const host = req.headers?.host;
  if (!host) return false;
  for (const header of ['origin', 'referer']) {
    const value = req.headers[header];
    if (!value) continue;
    try {
      if (new URL(value).host !== host) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(new Error(`invalid JSON body: ${error.message}`));
      }
    });
    req.on('error', reject);
  });
}

async function handleStream(req, res, url) {
  const platform = url.searchParams.get('platform') || '';
  const device = url.searchParams.get('device') || '';
  const resolved = await resolveDevice(platform, device);
  if (!resolved.ok) {
    sendJson(res, resolved.status, { ok: false, error: resolved.error });
    return;
  }
  const options = {
    fps: url.searchParams.get('fps'),
    width: url.searchParams.get('width'),
    quality: url.searchParams.get('quality'),
  };
  const producer = acquire(resolved.device, platform, options);
  // Start before waiting: no first frame can exist until the capture children run.
  producer.ensureStarted();

  const first = await producer.frames.first(FIRST_FRAME_TIMEOUT_MS);

  /**
   * The producer was started before anyone subscribed, so both failure paths
   * below have to hand it a way to stop: otherwise its capture children run
   * forever. Deliberately NOT armed at start time - the first-frame budget is
   * 20 s and the idle grace is 15 s, so an early timer would stop a producer
   * that is merely slow to produce its first frame.
   */
  const abandon = () => {
    if (producer.subscribers.size === 0) producer.armIdleStop();
  };

  // The browser may have navigated away or switched device during the wait.
  // Writing to a destroyed socket is harmless but pointless.
  if (res.destroyed) {
    abandon();
    return;
  }
  if (!first) {
    abandon();
    sendJson(res, 504, {
      ok: false,
      error: producer.lastError || 'no frame captured yet',
      hint: platform === 'ios' ? 'the simulator must be Booted and awake' : 'check adb devices -l',
    });
    return;
  }

  res.writeHead(200, {
    'content-type': `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
    'cache-control': 'no-store, no-transform',
    'x-accel-buffering': 'no',
    connection: 'keep-alive',
  });

  const writeFrame = (buffer) => {
    // Drop rather than queue for a stalled reader: a mirror that lags 30s
    // behind is worse than one that skips frames.
    if (res.writableLength > buffer.length * 4 + 65536) return;
    // cork/uncork coalesces the three writes into one syscall without copying
    // the frame into a new buffer.
    res.cork();
    res.write(
      `--${BOUNDARY}\r\ncontent-type: image/jpeg\r\ncontent-length: ${buffer.length}\r\n\r\n`,
      'ascii',
    );
    res.write(buffer);
    res.write('\r\n');
    res.uncork();
  };

  // Send the newest frame immediately. A static screen produces no further
  // frames at all (both platforms are change-driven), so waiting for the
  // throttle would leave the panel blank forever.
  writeFrame(producer.frames.frame ?? first);

  /**
   * Trailing-edge throttle, driven by frame arrivals.
   *
   * A fixed sampler (`setInterval`) was measured delivering 5.2 fps from a
   * 15.4 fps producer: the simulator emits frames in bursts of three, so most
   * ticks found no new frame and the rest arrived just after a tick. Scheduling
   * the next write at `lastWrite + minGap` whenever a frame lands keeps the
   * cadence without missing arrivals.
   */
  let lastSentVersion = producer.frames.version;
  let lastWriteAt = Date.now();
  const minGap = Math.max(20, Math.round(1000 / producer.fps));
  streamDebug.minGap = minGap;
  streamDebug.fps = producer.fps;
  let scheduled = null;
  let closed = false;

  const flush = () => {
    streamDebug.flushed += 1;
    if (due) streamDebug.maxLagMs = Math.max(streamDebug.maxLagMs, Date.now() - due);
    scheduled = null;
    if (closed) return;
    const frame = producer.frames.frame;
    if (!frame) return;
    if (producer.frames.version === lastSentVersion) { streamDebug.skipped += 1; return; }
    lastSentVersion = producer.frames.version;
    lastWriteAt = Date.now();
    const before = res.writableLength;
    writeFrame(frame);
    streamDebug.written += 1;
    if (before > 65536) streamDebug.dropped += 1;
    // Frames that land during the next gap are picked up by their own schedule()
    // call, which the subscription already fires on every publish.
  };

  let due = 0;
  const schedule = () => {
    streamDebug.scheduled += 1;
    if (closed || scheduled) return;
    const wait = Math.max(0, lastWriteAt + minGap - Date.now());
    due = Date.now() + wait;
    streamDebug.lastWait = wait;
    scheduled = setTimeout(flush, wait);
  };

  // Subscribing keeps the producer alive (reference count) AND is the write
  // trigger, so the delivered cadence follows what the device actually emits.
  const unsubscribe = producer.subscribe(schedule);

  const cleanup = () => {
    closed = true;
    if (scheduled) clearTimeout(scheduled);
    scheduled = null;
    unsubscribe();
  };
  res.on('close', cleanup);
  res.on('error', cleanup);
}

/**
 * Input geometry cache.
 *
 * `POST /input` needs only the device's coordinate space, but resolving it used
 * to run `adb devices -l` + `wm size` (+ the AVD probes) on EVERY tap - measured
 * 190-230 ms per tap against 100 ms of actual `adb input`. The geometry does not
 * change while a device stays up, so it is cached and invalidated on any
 * lifecycle transition.
 */



async function handleInput(req, res, url) {
  const body = await readBody(req);
  const platform = String(body.platform ?? '');
  const device = String(body.device ?? '');
  const kind = String(body.kind ?? '');
  if (!kind) {
    sendJson(res, 400, { ok: false, error: 'missing kind' });
    return;
  }
  const resolved = await inputGeometry(platform, device);
  if (!resolved.ok) {
    sendJson(res, resolved.status ?? 404, { ok: false, error: resolved.error });
    return;
  }

  // The Client always speaks normalised coordinates (0..1 of the rendered
  // frame); scaling to the platform's own space happens here, once, so the UI
  // never has to know whether it is talking to points or pixels.
  const action = { kind };
  const inputWidth = resolved.inputWidth;
  const inputHeight = resolved.inputHeight;
  const toX = (value) => (inputWidth ? Math.round(Math.min(1, Math.max(0, Number(value))) * inputWidth) : null);
  const toY = (value) => (inputHeight ? Math.round(Math.min(1, Math.max(0, Number(value))) * inputHeight) : null);
  if (kind === 'tap' || kind === 'swipe') {
    if (!inputWidth || !inputHeight) {
      sendJson(res, 409, { ok: false, error: 'device geometry unknown; open the stream first' });
      return;
    }
    action.x = toX(body.x);
    action.y = toY(body.y);
    if (kind === 'swipe') {
      action.x2 = toX(body.x2);
      action.y2 = toY(body.y2);
      action.duration = Number(body.duration) || 250;
    }
  }
  // Real time touch (Android emulator only): the Client streams down/move/up so
  // the drag follows the pointer, instead of being replayed as one swipe.
  if (kind === 'touch') {
    if (platform !== 'android') {
      sendJson(res, 400, { ok: false, unsupported: true, realtime: false, error: 'realtime touch is Android-emulator only' });
      return;
    }
    const phase = String(body.phase ?? '');
    if (!['down', 'move', 'up'].includes(phase)) {
      sendJson(res, 400, { ok: false, error: 'phase must be down, move or up' });
      return;
    }
    if (!inputWidth || !inputHeight) {
      sendJson(res, 409, { ok: false, error: 'device geometry unknown; open the stream first' });
      return;
    }
    // Adopt a bridge the plugin did not start itself, but only when the choice
    // is unambiguous: the bridge carries no serial.
    const attached = await countAttachedDevices();
    const port = await emulatorGrpc.adopt(device, attached);
    if (!port) {
      sendJson(res, 409, { ok: false, realtime: false, error: 'no emulator gRPC bridge; restart the emulator from this panel' });
      return;
    }
    const result = await emulatorGrpc.touch(device, {
      x: toX(body.x),
      y: toY(body.y),
      pressure: phase === 'up' ? 0 : 1,
    });
    if (!result.ok) {
      note(`android:${device} realtime touch ${phase} failed: ${result.reason}`);
      sendJson(res, 502, { ok: false, realtime: false, error: result.reason });
      return;
    }
    sendJson(res, 200, { ok: true, realtime: true, phase });
    return;
  }

  if (kind === 'text') action.text = String(body.text ?? '').slice(0, 400);
  if (kind === 'key') action.key = String(body.key ?? '');

  const result = platform === 'android'
    ? await injectAndroid(device, action)
    : await injectIos(device, action);

  if (!result.ok) {
    const detail = result.timedOut
      ? `${kind} timed out — the device or this machine is too busy to answer`
      : (result.stderr || result.stdout || 'input injection failed').trim().split('\n').slice(-2).join(' ');
    note(`${platform}:${device} input ${kind} failed: ${detail}`);
    sendJson(res, result.unsupported ? 400 : result.timedOut ? 504 : 502, {
      ok: false,
      error: detail,
      unsupported: result.unsupported === true,
      timedOut: result.timedOut === true,
      action,
    });
    return;
  }
  sendJson(res, 200, { ok: true, action });
}

// ---------------------------------------------------------------------------
// Simulator lifecycle
// ---------------------------------------------------------------------------


/** Shared front half: POST body → validated fields, or a response already sent. */
async function readLifecycleBody(req, res, action) {
  // A JSON body of `null` parses to null, which would throw on `body.platform`.
  const body = (await readBody(req)) ?? {};
  const platform = String(body.platform ?? '');
  const device = String(body.device ?? '');
  if (!platform) {
    sendJson(res, 400, { ok: false, error: 'missing platform' });
    return null;
  }
  if (!device) {
    sendJson(res, 400, { ok: false, error: 'missing device' });
    return null;
  }
  if (platform !== 'ios') {
    sendJson(res, 400, { ok: false, error: `${action} is only supported for ios simulators` });
    return null;
  }
  return { device };
}


async function handleBoot(req, res) {
  invalidateGeometry('ios');
  const parsed = await readLifecycleBody(req, res, 'boot');
  if (!parsed) return;
  const { device } = parsed;

  // Idempotency first: an already-Booted simulator costs one `simctl list` and
  // no boot subprocess at all.
  const resolved = await resolveDevice('ios', device);
  if (resolved.ok) {
    sendJson(res, 200, { ok: true, device, state: 'Booted', bootedInMs: 0 });
    return;
  }
  // resolveDevice refuses a known simulator in any non-Booted state with a 409
  // ("... boot it first"). That is precisely the case this route exists for, so
  // a 409 means "the udid exists, keep going"; every other status is a real
  // rejection (404 for an unknown udid) and is passed through unchanged.
  if (resolved.status !== 409) {
    note(`ios:${device} boot rejected: ${resolved.error}`);
    sendJson(res, resolved.status, { ok: false, error: resolved.error });
    return;
  }

  const startedAt = Date.now();
  const booted = await run('xcrun', ['simctl', 'boot', device], 30_000);
  if (!booted.ok) {
    const reported = simctlCurrentState(`${booted.stdout}\n${booted.stderr}`);
    if (!reported || reported.toLowerCase() !== 'booted') {
      const error = simctlFirstError(booted, 'simctl boot failed');
      note(`ios:${device} boot failed: ${error}`);
      sendJson(res, 502, { ok: false, error });
      return;
    }
  }

  const outcome = await waitForSimulatorBoot(device);
  if (!outcome.booted) {
    const error = 'simulator did not reach Booted within 60s';
    note(`ios:${device} boot timed out, last state: ${outcome.state}`);
    sendJson(res, 409, { ok: false, error, state: outcome.state });
    return;
  }
  sendJson(res, 200, { ok: true, device, state: 'Booted', bootedInMs: Date.now() - startedAt });
}

async function handleShutdown(req, res) {
  invalidateGeometry('ios');
  const parsed = await readLifecycleBody(req, res, 'shutdown');
  if (!parsed) return;
  const { device } = parsed;

  const resolved = await resolveDevice('ios', device);
  // A 409 means "exists, but is not Booted" - for shutdown that is already the
  // goal, so the command still runs and reports the state itself. Anything else
  // (404 for an unknown udid) is a real rejection.
  if (!resolved.ok && resolved.status !== 409) {
    note(`ios:${device} shutdown rejected: ${resolved.error}`);
    sendJson(res, resolved.status, { ok: false, error: resolved.error });
    return;
  }

  const stopped = await run('xcrun', ['simctl', 'shutdown', device], 30_000);
  if (!stopped.ok) {
    const reported = simctlCurrentState(`${stopped.stdout}\n${stopped.stderr}`);
    if (!reported || reported.toLowerCase() !== 'shutdown') {
      const error = simctlFirstError(stopped, 'simctl shutdown failed');
      note(`ios:${device} shutdown failed: ${error}`);
      sendJson(res, 502, { ok: false, error });
      return;
    }
  }
  sendJson(res, 200, { ok: true, device, state: 'Shutdown' });
}

// ---------------------------------------------------------------------------
// Simulator catalogue + creation
// ---------------------------------------------------------------------------

/** Runaway guard only: a healthy Xcode reports 124 device types, not thousands. */
const CATALOG_MAX_DEVICE_TYPES = 200;
/** `simctl create` takes a human label; the picker shows it, so keep it short. */
const CREATE_NAME_MAX = 60;
const CREATE_TIMEOUT_MS = 30_000;

/**
 * One `simctl` read that both routes share. Parsing the catalogue here rather
 * than per-route is what keeps `/create` from spawning a second probe whose
 * answer could disagree with the list the user just picked from.
 */
async function readCatalog() {
  const [typeList, runtimeList] = await Promise.all([
    run('xcrun', ['simctl', 'list', 'devicetypes', '--json'], 10_000),
    run('xcrun', ['simctl', 'list', 'runtimes', '--json'], 10_000),
  ]);
  if (!typeList.ok) return { ok: false, error: simctlFirstError(typeList, 'simctl list devicetypes failed') };
  if (!runtimeList.ok) return { ok: false, error: simctlFirstError(runtimeList, 'simctl list runtimes failed') };
  let typeDoc;
  let runtimeDoc;
  try {
    typeDoc = JSON.parse(typeList.stdout);
    runtimeDoc = JSON.parse(runtimeList.stdout);
  } catch {
    return { ok: false, error: 'simctl returned unparsable JSON' };
  }

  const deviceTypes = [];
  for (const row of Array.isArray(typeDoc?.devicetypes) ? typeDoc.devicetypes : []) {
    const identifier = String(row?.identifier ?? '');
    const name = String(row?.name ?? '');
    // Both halves are required to create anything: the identifier is the
    // argument, the name is the label. A row missing either is unusable here.
    if (!identifier || !name) continue;
    deviceTypes.push({ identifier, name, productFamily: String(row?.productFamily ?? '') });
  }
  deviceTypes.sort(
    (a, b) => a.productFamily.localeCompare(b.productFamily) || a.name.localeCompare(b.name),
  );

  const runtimes = [];
  for (const row of Array.isArray(runtimeDoc?.runtimes) ? runtimeDoc.runtimes : []) {
    const identifier = String(row?.identifier ?? '');
    if (!identifier) continue;
    runtimes.push({
      identifier,
      name: String(row?.name ?? ''),
      version: String(row?.version ?? ''),
      // `isAvailable` is absent on some builds; only an explicit false is
      // treated as unavailable, so a missing flag does not hide a usable runtime.
      available: row?.isAvailable !== false,
    });
  }
  // Newest first: a picker should default to the runtime a new device wants.
  // `numeric` matters - plain string order puts "9.0" above "26.5".
  runtimes.sort((a, b) => b.version.localeCompare(a.version, 'en', { numeric: true }));

  return { ok: true, deviceTypes: deviceTypes.slice(0, CATALOG_MAX_DEVICE_TYPES), runtimes };
}

/** A device name is a single line: simctl folds a newline into an invalid name. */
function normalizeDeviceName(value) {
  return String(value ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, CREATE_NAME_MAX).trim();
}

async function handleCatalog(req, res) {
  const catalog = await readCatalog();
  if (!catalog.ok) {
    note(`catalog failed: ${catalog.error}`);
    sendJson(res, 502, { ok: false, error: catalog.error });
    return;
  }
  sendJson(res, 200, { ok: true, deviceTypes: catalog.deviceTypes, runtimes: catalog.runtimes });
}

async function handleCreate(req, res) {
  invalidateGeometry('ios');
  // A JSON body of `null` parses to null, which would throw on `body.name`.
  const body = (await readBody(req)) ?? {};
  const deviceTypeIdentifier = String(body.deviceTypeIdentifier ?? '').trim();
  const runtimeIdentifier = String(body.runtimeIdentifier ?? '').trim();
  if (!deviceTypeIdentifier) {
    note('create rejected: missing deviceTypeIdentifier');
    sendJson(res, 400, { ok: false, error: 'missing deviceTypeIdentifier' });
    return;
  }
  if (!runtimeIdentifier) {
    note('create rejected: missing runtimeIdentifier');
    sendJson(res, 400, { ok: false, error: 'missing runtimeIdentifier' });
    return;
  }

  const catalog = await readCatalog();
  if (!catalog.ok) {
    note(`create rejected: catalog unavailable: ${catalog.error}`);
    sendJson(res, 502, { ok: false, error: catalog.error });
    return;
  }
  const deviceType = catalog.deviceTypes.find((row) => row.identifier === deviceTypeIdentifier);
  if (!deviceType) {
    note(`create rejected: unknown deviceTypeIdentifier ${deviceTypeIdentifier}`);
    sendJson(res, 400, { ok: false, error: 'unknown deviceTypeIdentifier' });
    return;
  }
  const runtime = catalog.runtimes.find((row) => row.identifier === runtimeIdentifier);
  if (!runtime) {
    note(`create rejected: unknown runtimeIdentifier ${runtimeIdentifier}`);
    sendJson(res, 400, { ok: false, error: 'unknown runtimeIdentifier' });
    return;
  }
  if (runtime.available === false) {
    note(`create rejected: runtime ${runtime.name || runtimeIdentifier} is not available`);
    sendJson(res, 409, { ok: false, error: 'runtime is not available' });
    return;
  }

  // An explicit blank name is treated as absent: "" is not a legal label, and
  // the default is strictly more useful than a simulator named nothing.
  const requested = normalizeDeviceName(body.name);
  const name = requested || normalizeDeviceName(`DSH Mirror ${deviceType.name} ${runtime.name}`);

  const created = await run('xcrun', ['simctl', 'create', name, deviceTypeIdentifier, runtimeIdentifier], CREATE_TIMEOUT_MS);
  if (!created.ok) {
    const error = simctlFirstError(created, 'simctl create failed');
    note(`create failed (${name}): ${error}`);
    sendJson(res, 502, { ok: false, error });
    return;
  }
  // `simctl create` prints the new udid and nothing else, with a trailing
  // newline; taking stdout verbatim would ship a udid that no later call accepts.
  const device = created.stdout.split('\n').map((line) => line.trim()).filter(Boolean).pop() ?? '';
  if (!device) {
    note(`create failed (${name}): simctl printed no udid`);
    sendJson(res, 502, { ok: false, error: 'simctl create returned no udid' });
    return;
  }
  // Success is audited too: the point of this route is that it leaves a new
  // device behind, so "who made this" must be answerable from /state.
  note(`created simulator ${device} (${name} · ${deviceType.name} · ${runtime.name || runtimeIdentifier})`);
  sendJson(res, 200, { ok: true, device, name, state: 'Shutdown' });
}

// ---------------------------------------------------------------------------
// Android AVD catalogue, creation and boot
// ---------------------------------------------------------------------------
// The Android tooling is deliberately not assumed to be on PATH: a GUI-launched
// process inherits neither ANDROID_HOME nor a shell profile, so the SDK's own
// binaries are addressed absolutely, under the current user's home.



async function handleAndroidCatalog(req, res) {
  const [images, profiles] = await Promise.all([listSystemImages(), listDeviceProfiles()]);
  if (!profiles.ok) {
    note(`android catalog failed: ${profiles.error}`);
    sendJson(res, 502, { ok: false, error: profiles.error });
    return;
  }
  sendJson(res, 200, { ok: true, images, devices: profiles.devices });
}

/**
 * Create an AVD. Shared by the HTTP route and the `device_mirror_avd` tool, so
 * the validation and the delete-then-create dance exist once.
 *
 * @returns {Promise<{ok: true, avd: string} | {ok: false, status: number, error: string}>}
 */
async function handleAndroidCreate(req, res) {
  invalidateGeometry('android');
  // A JSON body of `null` parses to null, which would throw on `body.imageId`.
  const body = (await readBody(req)) ?? {};
  const imageId = String(body.imageId ?? '').trim();
  const deviceId = String(body.deviceId ?? '').trim();
  if (!imageId) {
    note('android create rejected: missing imageId');
    sendJson(res, 400, { ok: false, error: 'missing imageId' });
    return;
  }

  const result = await createAndroidAvd({ name: body.name, imageId, deviceId });
  if (!result.ok) {
    sendJson(res, result.status, { ok: false, error: result.error });
    return;
  }
  sendJson(res, 200, { ok: true, avd: result.avd });
}

/**
 * Two phases, because they fail differently: adb sees `emulator-5556` about 12s
 * after the process starts while the framework is still down (`wm size` answers
 * "Can't find service: window"). Only `sys.boot_completed` on the right serial
 * is a truthful readiness signal.
 */
async function handleAndroidBoot(req, res) {
  invalidateGeometry('android');
  const body = (await readBody(req)) ?? {};
  const name = String(body.name ?? '').trim();
  if (!name) {
    sendJson(res, 400, { ok: false, error: 'missing name' });
    return;
  }
  const avds = await listAvds();
  if (!avds || !avds.includes(name)) {
    note(`android:${name} boot rejected: no such avd`);
    sendJson(res, 404, { ok: false, error: `unknown avd ${name}` });
    return;
  }

  // Idempotency first: an already-running emulator costs one adb call and no spawn.
  const running = (await runningAvds()).get(name);
  if (running) {
    sendJson(res, 200, { ok: true, device: running, bootedInMs: 0 });
    return;
  }

  // Ask for a gRPC bridge: it is what lets a drag follow the pointer instead of
  // being replayed as one `input swipe`. A null port means every candidate was
  // taken, and the emulator then simply has no realtime touch.
  const grpcPort = await pickGrpcPort();
  // detached: this emulator belongs to the user's machine. A plugin reload must
  // not kill a device the user is working in, so it outlives this process.
  let child;
  try {
    child = spawn(
      EMULATOR_BIN,
      bootArgs(name, grpcPort),
      { detached: true, stdio: 'ignore' },
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    note(`android:${name} emulator spawn failed: ${detail}`);
    sendJson(res, 502, { ok: false, error: detail });
    return;
  }
  child.on('error', (error) => note(`android:${name} emulator error: ${error.message}`));
  child.unref();
  note(`booting android avd ${name}`);

  const outcome = await waitForAvdBoot(name);
  if (!outcome.booted) {
    const error = `avd did not finish booting within ${AVD_BOOT_TIMEOUT_MS / 1000}s`;
    note(`android:${name} boot timed out (phase ${outcome.phase})`);
    sendJson(res, 409, { ok: false, error, phase: outcome.phase });
    return;
  }
  note(`android:${name} booted as ${outcome.serial} in ${outcome.bootedInMs}ms`);
  if (outcome.serial && grpcPort) emulatorGrpc.register(outcome.serial, grpcPort);
  sendJson(res, 200, { ok: true, device: outcome.serial, bootedInMs: outcome.bootedInMs, realtime: Boolean(grpcPort) });
}

function describeProducers() {
  return Array.from(producers.values()).map((producer) => producer.describe());
}

async function handleRequest(req, res) {
  if (!sameOriginOnly(req)) {
    sendJson(res, 403, { ok: false, error: 'cross-origin-request-rejected' });
    return;
  }
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const pathname = url.pathname;

  try {
    if (pathname === `${ROUTE_PREFIX}/devices`) {
      const [android, ios] = await Promise.all([listAndroid(), listIos()]);
      sendJson(res, 200, { ok: true, android, ios, producers: describeProducers() });
      return;
    }
    if (pathname === `${ROUTE_PREFIX}/state`) {
      sendJson(res, 200, {
        ok: true,
        version: PLUGIN_VERSION,
        uptimeMs: Math.round(process.uptime() * 1000),
        producers: describeProducers(),
        throttle: { ...streamDebug },
        diagnostics,
        clientReports,
      });
      return;
    }
    if (pathname === `${ROUTE_PREFIX}/report`) {
      clientReports.push({
        at: Date.now(),
        boot: url.searchParams.get('boot') || null,
        stage: url.searchParams.get('stage') || null,
        service: url.searchParams.get('service') === '1',
        surfaces: (url.searchParams.get('surfaces') || '').split(',').filter(Boolean).slice(0, 8),
        detail: (url.searchParams.get('detail') || '').slice(0, 200),
      });
      while (clientReports.length > 20) clientReports.shift();
      sendJson(res, 200, { ok: true });
      return;
    }
    if (pathname === `${ROUTE_PREFIX}/stream`) {
      await handleStream(req, res, url);
      return;
    }
    if (pathname === `${ROUTE_PREFIX}/input`) {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'method-not-allowed' });
        return;
      }
      await handleInput(req, res, url);
      return;
    }
    if (pathname === `${ROUTE_PREFIX}/boot`) {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'method-not-allowed' });
        return;
      }
      await handleBoot(req, res);
      return;
    }
    if (pathname === `${ROUTE_PREFIX}/shutdown`) {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'method-not-allowed' });
        return;
      }
      await handleShutdown(req, res);
      return;
    }
    if (pathname === `${ROUTE_PREFIX}/catalog`) {
      if (req.method !== 'GET') {
        sendJson(res, 405, { ok: false, error: 'method-not-allowed' });
        return;
      }
      await handleCatalog(req, res);
      return;
    }
    if (pathname === `${ROUTE_PREFIX}/create`) {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'method-not-allowed' });
        return;
      }
      await handleCreate(req, res);
      return;
    }
    if (pathname === `${ROUTE_PREFIX}/android/catalog`) {
      if (req.method !== 'GET') {
        sendJson(res, 405, { ok: false, error: 'method-not-allowed' });
        return;
      }
      await handleAndroidCatalog(req, res);
      return;
    }
    if (pathname === `${ROUTE_PREFIX}/android/create`) {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'method-not-allowed' });
        return;
      }
      await handleAndroidCreate(req, res);
      return;
    }
    if (pathname === `${ROUTE_PREFIX}/android/boot`) {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'method-not-allowed' });
        return;
      }
      await handleAndroidBoot(req, res);
      return;
    }
    sendJson(res, 404, { ok: false, error: 'not-found' });
  } catch (error) {
    note(`route ${pathname}: ${error instanceof Error ? error.message : String(error)}`);
    if (!res.headersSent) {
      sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
    } else {
      res.end();
    }
  }
}
  return { handleRequest };
}

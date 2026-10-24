/**
 * Device discovery and input injection.
 *
 * Both platforms are addressed the same way here, and the difference between
 * "points" (iOS) and "pixels" (Android) is settled once, inside this module, so
 * callers only ever deal with normalised 0..1 coordinates.
 *
 * @module @local/dsh-device-mirror/host/devices
 */
import { promises as fsp } from 'node:fs';

import { sleep } from './shared.js';
import os from 'node:os';
import path from 'node:path';

/**
 * @param {object} deps - the Host helpers this module reaches into.
 * @returns {object} the device surface used by the routes and the tools.
 */
export function createDevices({ run, listAvds, runningAvds, sleep, BOOT_POLL_INTERVAL_MS, BOOT_TIMEOUT_MS, BOOT_MAX_POLLS }) {
const GEOMETRY_TTL_MS = 60_000;
const geometryCache = new Map();

function invalidateGeometry(platform, device) {
  if (!platform) {
    geometryCache.clear();
    return;
  }
  if (!device) {
    for (const key of [...geometryCache.keys()]) {
      if (key.startsWith(`${platform}:`)) geometryCache.delete(key);
    }
    return;
  }
  geometryCache.delete(`${platform}:${device}`);
}

async function inputGeometry(platform, device) {
  const key = `${platform}:${device}`;
  const hit = geometryCache.get(key);
  if (hit && Date.now() - hit.at < GEOMETRY_TTL_MS) return hit;
  const resolved = await resolveDevice(platform, device);
  if (!resolved.ok) return resolved;
  const entry = {
    ok: true,
    inputWidth: resolved.device.inputWidth,
    inputHeight: resolved.device.inputHeight,
    at: Date.now(),
  };
  geometryCache.set(key, entry);
  return entry;
}

async function waitForSimulatorBoot(udid) {
  const startedAt = Date.now();
  let state = 'Unknown';
  for (let poll = 0; poll < BOOT_MAX_POLLS && Date.now() - startedAt < BOOT_TIMEOUT_MS; poll += 1) {
    const listed = await listIos();
    const row = listed.available ? listed.devices.find((entry) => entry.device === udid) : null;
    if (row?.state) state = row.state;
    if (state === 'Booted') return { booted: true, state };
    if (poll + 1 < BOOT_MAX_POLLS) await sleep(BOOT_POLL_INTERVAL_MS);
  }
  return { booted: false, state };
}

// ---------------------------------------------------------------------------
// Device discovery
// ---------------------------------------------------------------------------

async function listAndroid() {
  const result = await run('adb', ['devices', '-l'], 6000);
  if (!result.ok) {
    return { available: false, reason: (result.stderr || 'adb not found').trim().split('\n')[0], devices: [] };
  }
  const devices = [];
  for (const line of result.stdout.split('\n').slice(1)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [serial, state, ...rest] = trimmed.split(/\s+/);
    if (!serial || state !== 'device') continue;
    const meta = {};
    for (const part of rest.join(' ').split(/\s+/)) {
      const at = part.indexOf(':');
      if (at > 0) meta[part.slice(0, at)] = part.slice(at + 1);
    }
    // `wm size` is the only reliable pixel size; it also proves the device
    // answers, so a half-dead emulator is filtered out here rather than at the
    // first stream request.
    // Two emulators booting at once make `wm size` slow (measured >5s, which
    // silently produced a device row with no resolution). Retry once rather
    // than reporting null geometry for a device that is perfectly fine.
    let size = await run('adb', ['-s', serial, 'shell', 'wm', 'size'], 9000);
    if (!/(\d+)\s*x\s*(\d+)/.test(size.stdout)) {
      size = await run('adb', ['-s', serial, 'shell', 'wm', 'size'], 9000);
    }
    let nativeWidth = null;
    let nativeHeight = null;
    const match = /(\d+)\s*x\s*(\d+)/.exec(size.stdout);
    if (match) {
      nativeWidth = Number(match[1]);
      nativeHeight = Number(match[2]);
    }
    // `adb devices -l` often reports model and product as the same string
    // ("sdk_gphone64_arm64 (sdk_gphone64_arm64)"); the parenthesis only earns
    // its place when the product actually distinguishes the device.
    const model = meta.model || '';
    const product = meta.product || '';
    const label = model && product && model !== product ? `${model} (${product})` : model || serial;
    devices.push({
      platform: 'android',
      device: serial,
      serial,
      model: model || null,
      label,
      state,
      // Tells a connected device (which has a serial, and can be streamed right
      // now) apart from a bootable AVD that is merely defined.
      kind: 'adb',
      nativeWidth,
      nativeHeight,
      inputWidth: nativeWidth,
      inputHeight: nativeHeight,
    });
  }
  // A stopped AVD has no adb serial at all, so without this merge the picker
  // could never offer the thing a new Android target usually is: created but
  // not booted. `emulator -list-avds` failing (no emulator installed) must not
  // take /devices down with it - it only means there are no AVD rows to add.
  const [running, avds] = await Promise.all([runningAvds(), listAvds()]);
  for (const name of avds ?? []) {
    // An AVD that is already running reaches the picker through adb above;
    // appending it again would offer the same screen twice.
    if (running.has(name)) continue;
    devices.push({
      platform: 'android',
      device: name,
      label: name,
      state: 'Stopped',
      kind: 'avd',
      nativeWidth: null,
      nativeHeight: null,
    });
  }
  return { available: true, reason: null, devices };
}

/**
 * `idb describe` costs ~200ms, and the picker refreshes on every open, so the
 * geometry of a booted simulator is cached for the life of the process. A
 * re-boot changes nothing about the screen size, so the key is the udid alone.
 */
const iosGeometryCache = new Map();

async function cachedIosGeometry(udid) {
  if (iosGeometryCache.has(udid)) return iosGeometryCache.get(udid);
  const geometry = await resolveIosGeometry(udid);
  if (geometry) iosGeometryCache.set(udid, geometry);
  return geometry;
}

async function listIos() {
  const result = await run('xcrun', ['simctl', 'list', 'devices', '--json'], 8000);
  if (!result.ok) {
    return { available: false, reason: (result.stderr || 'simctl not found').trim().split('\n')[0], devices: [] };
  }
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return { available: false, reason: 'simctl returned unparsable JSON', devices: [] };
  }
  const devices = [];
  for (const [runtime, rows] of Object.entries(parsed.devices ?? {})) {
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      // Only a Booted simulator can be captured; listing the rest as
      // unavailable keeps the picker honest without a probe per device.
      const state = row.state ?? 'Unknown';
      devices.push({
        platform: 'ios',
        device: row.udid,
        label: `${row.name}${state === 'Booted' ? '' : ` · ${state}`}`,
        state,
        runtime: runtime.replace('com.apple.CoreSimulator.SimRuntime.', ''),
      });
    }
  }
  // Booted simulators also report their two coordinate spaces, so the picker can
  // show the user which space a tap will be scaled into.
  await Promise.all(
    devices
      .filter((row) => row.state === 'Booted')
      .map(async (row) => {
        const geometry = await cachedIosGeometry(row.device);
        if (!geometry) return;
        row.nativeWidth = geometry.nativeWidth;
        row.nativeHeight = geometry.nativeHeight;
        row.inputWidth = geometry.inputWidth;
        row.inputHeight = geometry.inputHeight;
      }),
  );
  devices.sort((a, b) => (a.state === 'Booted' ? -1 : 0) - (b.state === 'Booted' ? -1 : 0));
  return { available: true, reason: null, devices };
}

/**
 * The iOS Simulator's logical point size, which is what `idb ui tap` consumes.
 * Derived by halving a real screenshot until it matches idb's reported
 * application frame; falls back to the @3x assumption when idb cannot answer.
 */
/** Boot state of one simulator. Cheap: one `simctl list --json`, no geometry probe. */
async function simulatorState(udid) {
  const result = await run('xcrun', ['simctl', 'list', 'devices', '--json'], 8000);
  if (!result.ok) return null;
  try {
    const parsed = JSON.parse(result.stdout);
    for (const rows of Object.values(parsed.devices ?? {})) {
      if (!Array.isArray(rows)) continue;
      const row = rows.find((entry) => entry.udid === udid);
      if (row) return row.state ?? 'Unknown';
    }
  } catch {
    return null;
  }
  return null;
}

async function resolveIosGeometry(udid) {
  const described = await run('idb', ['describe', '--udid', udid, '--json'], 8000);
  if (described.ok) {
    try {
      const parsed = JSON.parse(described.stdout);
      const dims = parsed?.screen_dimensions ?? {};
      // idb reports BOTH spaces: `width`/`height` are device pixels,
      // `width_points`/`height_points` are the logical points `idb ui tap`
      // consumes. Using the pixel values here makes every tap land off-screen
      // by the device scale factor, so the point fields win when present.
      const pointsWidth = Number(dims.width_points ?? NaN);
      const pointsHeight = Number(dims.height_points ?? NaN);
      const pixelWidth = Number(dims.width ?? NaN);
      const pixelHeight = Number(dims.height ?? NaN);
      const density = Number(dims.density ?? NaN);
      if (Number.isFinite(pointsWidth) && Number.isFinite(pointsHeight) && pointsWidth > 0 && pointsHeight > 0) {
        return {
          inputWidth: Math.round(pointsWidth),
          inputHeight: Math.round(pointsHeight),
          nativeWidth: Number.isFinite(pixelWidth) && pixelWidth > 0
            ? Math.round(pixelWidth)
            : Number.isFinite(density) && density > 0 ? Math.round(pointsWidth * density) : null,
          nativeHeight: Number.isFinite(pixelHeight) && pixelHeight > 0
            ? Math.round(pixelHeight)
            : Number.isFinite(density) && density > 0 ? Math.round(pointsHeight * density) : null,
          assumedScale: null,
        };
      }
    } catch {
      // idb's JSON shape is not contractual; fall through to the screenshot probe.
    }
  }
  const file = path.join(os.tmpdir(), `dsh-device-mirror-probe-${udid.slice(0, 8)}.jpg`);
  const shot = await run('xcrun', ['simctl', 'io', udid, 'screenshot', '--type=jpeg', file], 8000);
  if (!shot.ok) return null;
  const bytes = await fsp.readFile(file).catch(() => null);
  await fsp.unlink(file).catch(() => {});
  if (!bytes) return null;
  const size = jpegSize(bytes);
  if (!size) return null;
  // iPhone Simulators are @3x; that is the only assumption here and it is
  // reported to the client as `assumedScale` so a wrong guess is visible.
  const scale = 3;

  return {
    nativeWidth: size.width,
    nativeHeight: size.height,
    inputWidth: Math.round(size.width / scale),
    inputHeight: Math.round(size.height / scale),
    assumedScale: scale,
  };
}

/** Reads width/height out of a JPEG's SOF segment. */
function jpegSize(buffer) {
  if (!buffer || buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const length = buffer.readUInt16BE(offset + 2);
    // SOF0..SOF15 except DHT(C4), JPG(C8) and DAC(CC) carry the dimensions.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
    }
    offset += 2 + length;
  }
  return null;
}

async function resolveDevice(platform, device) {
  if (platform === 'android') {
    const listed = await listAndroid();
    // Only a serial that adb reports can be streamed or driven; a defined but
    // stopped AVD has to be booted first (POST /android/boot), exactly like a
    // Shutdown iOS simulator.
    const found = listed.devices.find((row) => row.kind === 'adb' && row.device === device);
    if (!found) return { ok: false, status: 404, error: `android device ${device} is not connected` };
    return { ok: true, device: found };
  }
  if (platform === 'ios') {
    const listed = await listIos();
    const found = listed.devices.find((row) => row.device === device);
    if (!found) return { ok: false, status: 404, error: `simulator ${device} is not known` };
    if (found.state !== 'Booted') return { ok: false, status: 409, error: `simulator ${device} is ${found.state}, boot it first` };
    const geometry = await cachedIosGeometry(device);
    return {
      ok: true,
      device: {
        ...found,
        nativeWidth: geometry?.nativeWidth ?? null,
        nativeHeight: geometry?.nativeHeight ?? null,
        inputWidth: geometry?.inputWidth ?? null,
        inputHeight: geometry?.inputHeight ?? null,
        assumedScale: geometry?.assumedScale ?? null,
      },
    };
  }
  return { ok: false, status: 400, error: `unknown platform ${platform}` };
}

// ---------------------------------------------------------------------------
// Input injection
// ---------------------------------------------------------------------------

const ANDROID_KEYS = new Set([
  'BACK', 'HOME', 'APP_SWITCH', 'MENU', 'ENTER', 'DEL', 'TAB', 'SEARCH',
  'POWER', 'VOLUME_UP', 'VOLUME_DOWN', 'WAKEUP', 'SLEEP',
]);

/** `adb shell input text` needs shell-safe quoting; %s encodes a space. */
function androidTextArg(text) {
  return String(text).replace(/%/g, '\\%').replace(/ /g, '%s');
}

async function injectAndroid(device, action) {
  const shell = (...args) => run('adb', ['-s', device, 'shell', 'input', ...args], 8000);
  if (action.kind === 'tap') {
    return shell('tap', String(action.x), String(action.y));
  }
  if (action.kind === 'swipe') {
    return shell('swipe', String(action.x), String(action.y), String(action.x2), String(action.y2), String(action.duration ?? 250));
  }
  if (action.kind === 'text') {
    return shell('text', androidTextArg(action.text ?? ''));
  }
  if (action.kind === 'key') {
    const key = String(action.key ?? '').toUpperCase();
    if (!ANDROID_KEYS.has(key)) return { ok: false, stderr: `unsupported key ${key}`, stdout: '' };
    return shell('keyevent', `KEYCODE_${key}`);
  }
  return { ok: false, stderr: `unsupported action ${action.kind}`, stdout: '' };
}

/**
 * iOS input through idb. Argument order matters: every option goes BEFORE the
 * positional coordinates, which is the order idb's own docs and the verified
 * recipe use.
 *
 * `--duration` is not cosmetic. A default idb tap is far too short for UISwitch
 * and is dropped silently - measured 1/10 flips at default versus 15/15 at
 * 0.05-0.2s, with exit code 0 in both cases. Every tap therefore carries an
 * explicit press duration; the cost is ~100ms, and the alternative is a control
 * that reports success and does nothing.
 */
const IOS_TAP_DURATION_S = 0.1;

/**
 * iOS navigation.
 *
 * The Simulator exposes hardware buttons (`idb ui button HOME|LOCK|SIRI|...`)
 * but has no `BACK`, no `APP_SWITCH`, and no key-event channel that reaches the
 * UI. Measured:
 *   - `idb ui button HOME`  → works, and it still works when the compositor is
 *     wedged mid-transition (verified: 91% of the screen changed).
 *   - `idb ui key <code>`   → exits 0 and does nothing.
 *   - left-edge back swipe  → unreliable, and a wedged simulator ignores it.
 *
 * `BACK` is therefore resolved by asking the accessibility tree for the nav
 * bar's back button: it is a Button whose label is the PREVIOUS screen's title,
 * pinned to the top-left (`16,62 44x44` on a 402x874pt screen). Tapping its
 * centre returned to the parent screen in testing (36% of pixels changed).
 */
async function iosBack(device) {
  const described = await run('idb', ['ui', 'describe-all', '--udid', device], 8000);
  let screenHeight = 874;
  if (described.ok) {
    try {
      const rows = JSON.parse(described.stdout);
      if (Array.isArray(rows)) {
        const application = rows.find((row) => row?.type === 'Application');
        if (Number(application?.frame?.height) > 0) screenHeight = Number(application.frame.height);
        const back = rows.find((row) => {
          const frame = row?.frame ?? {};
          const x = Number(frame.x);
          const y = Number(frame.y);
          const width = Number(frame.width);
          // Nav-bar back control: a small Button in the top-left corner.
          return row?.type === 'Button'
            && Number.isFinite(x) && Number.isFinite(y)
            && x < 90 && y < 130 && width > 0 && width <= 80;
        });
        if (back) {
          const frame = back.frame;
          const x = Math.round(Number(frame.x) + Number(frame.width) / 2);
          const y = Math.round(Number(frame.y) + Number(frame.height) / 2);
          const tapped = await run(
            'idb',
            ['ui', 'tap', '--duration', String(IOS_TAP_DURATION_S), '--udid', device, String(x), String(y)],
            10_000,
          );
          if (tapped.ok) return tapped;
        }
      }
    } catch {
      // Accessibility JSON is not contractual; fall through to the gesture.
    }
  }
  // Fallback: the system edge-back gesture, which some screens (and older
  // runtimes) accept where an explicit control is absent.
  const mid = Math.round(screenHeight / 2);
  return run(
    'idb',
    ['ui', 'swipe', '--duration', '0.3', '--udid', device, '3', String(mid), '330', String(mid)],
    10_000,
  );
}

async function injectIos(device, action) {
  const ui = (args) => run('idb', ['ui', ...args, '--udid', device], 10_000);
  if (action.kind === 'tap') {
    return ui(['tap', '--duration', String(IOS_TAP_DURATION_S), String(action.x), String(action.y)]);
  }
  if (action.kind === 'swipe') {
    const seconds = Math.min(3, Math.max(0.05, (Number(action.duration) || 250) / 1000));
    return ui([
      'swipe', '--duration', String(seconds),
      String(action.x), String(action.y), String(action.x2), String(action.y2),
    ]);
  }
  if (action.kind === 'text') {
    return ui(['text', String(action.text ?? '')]);
  }
  if (action.kind === 'key') {
    const key = String(action.key ?? '').toUpperCase();
    if (key === 'HOME') return ui(['button', 'HOME']);
    if (key === 'BACK') return iosBack(device);
    if (key === 'LOCK') return ui(['button', 'LOCK']);
    if (key === 'APP_SWITCH') {
      return {
        ok: false,
        stderr: 'the iOS Simulator has no app-switcher API; use Android for that key',
        stdout: '',
        unsupported: true,
      };
    }
    return { ok: false, stderr: `iOS does not support the ${key} key`, stdout: '', unsupported: true };
  }
  return { ok: false, stderr: `unsupported action ${action.kind}`, stdout: '' };
}

// ---------------------------------------------------------------------------
  return {
    listAndroid, listIos, resolveDevice, resolveIosGeometry, simulatorState,
    injectAndroid, injectIos, iosBack, jpegSize, androidTextArg,
    inputGeometry, invalidateGeometry, waitForSimulatorBoot,
    ANDROID_KEYS, IOS_TAP_DURATION_S,
  };
}

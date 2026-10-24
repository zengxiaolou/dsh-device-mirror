/**
 * Android AVD catalogue, creation and boot.
 *
 * Shared by the HTTP routes and the agent tools, which is why it is its own
 * module rather than part of either: both need to list system images, create an
 * AVD, and wait for one to finish booting.
 *
 * @module @local/dsh-device-mirror/host/android-avd
 */
import { promises as fsp } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { GRPC_PORT_BASE } from './emulator-grpc.js';

/**
 * @param {{note: Function, run: Function, sleep: Function}} deps
 * @returns {object} everything the routes and tools use.
 */
export function createAvdTools({ note, run, sleep }) {
const ANDROID_SDK_DIR = path.join(os.homedir(), 'Library', 'Android', 'sdk');
const AVDMANAGER_BIN = path.join(ANDROID_SDK_DIR, 'cmdline-tools', 'latest', 'bin', 'avdmanager');
const EMULATOR_BIN = path.join(ANDROID_SDK_DIR, 'emulator', 'emulator');
const SYSTEM_IMAGES_DIR = path.join(ANDROID_SDK_DIR, 'system-images');

/** Runaway guard only: a healthy SDK reports a few dozen device definitions. */
const AVD_CATALOG_MAX_DEVICES = 120;
/** AVD names are directory names; a pasted sentence must not become one. */
const AVD_NAME_MAX = 48;
/** `avdmanager create` writes the AVD to disk; slower than a list, still local. */
const AVDMANAGER_TIMEOUT_MS = 60_000;
/** A cold boot with no snapshot measured well past a minute on this machine. */
const AVD_BOOT_TIMEOUT_MS = 180_000;
const AVD_BOOT_POLL_MS = 1_000;

/**
 * `run` with a one-shot stdin write. `avdmanager create avd` asks whether to
 * define a custom hardware profile, and the documented answer is a piped "no".
 * Feeding it through a pipe keeps the AVD name out of any shell quoting path.
 */
function runFeeding(command, args, input, timeout = AVDMANAGER_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let child = null;
    const finish = (ok, code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok, stdout, stderr, code });
    };
    const timer = setTimeout(() => {
      try {
        child?.kill('SIGKILL');
      } catch {
        // Already gone.
      }
      finish(false, -1);
    }, timeout);
    try {
      child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) {
      stderr = String(error instanceof Error ? error.message : error);
      finish(false, -1);
      return;
    }
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (error) => {
      stderr += String(error instanceof Error ? error.message : error);
      finish(false, -1);
    });
    child.on('exit', (code) => finish(code === 0, typeof code === 'number' ? code : -1));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

/**
 * First line that actually reports a failure. `avdmanager` prefixes real
 * failures with chatter - the SDK-XML version warning and "Auto-selecting
 * single ABI arm64-v8a" - and reporting either of those as the error hides the
 * cause. An explicit "Error:" line wins; only when there is none does the first
 * line that is not known chatter stand in.
 */
const AVD_CHATTER = /^(warning|info|auto-selecting)\b[:\s|]/i;

function avdFirstError(result, fallback) {
  const lines = `${result.stderr || ''}\n${result.stdout || ''}`
    .split('\n')
    .map((row) => row.trim())
    .filter(Boolean);
  const reported = lines.find((row) => /^\[?error\]?\b[:\s]/i.test(row));
  if (reported) return reported;
  const meaningful = lines.find((row) => !AVD_CHATTER.test(row));
  return meaningful || fallback;
}

/** Defined AVD names, one per line; null when the emulator binary cannot answer. */
async function listAvds() {
  const result = await run(EMULATOR_BIN, ['-list-avds'], 10_000);
  if (!result.ok) return null;
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    // A name cannot contain whitespace, so a chattier build's banner lines drop out.
    .filter((line) => line && !/\s/.test(line));
}

/**
 * Which AVDs are running, as name -> adb serial; a physical device cannot
 * answer the identity probe and is simply skipped.
 */
/** How many Android devices are attached; used to disambiguate the gRPC bridge. */
async function countAttachedDevices() {
  const listed = await run('adb', ['devices'], 6000);
  if (!listed.ok) return 0;
  return listed.stdout
    .split('\n')
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => line.endsWith('device')).length;
}

async function runningAvds() {
  const listed = await run('adb', ['devices'], 6000);
  if (!listed.ok) return new Map();
  const serials = [];
  for (const line of listed.stdout.split('\n').slice(1)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [serial, state] = trimmed.split(/\s+/);
    if (!serial || state !== 'device') continue;
    serials.push(serial);
  }
  // Probed in parallel: the console can stall for seconds under load, and a
  // sequential list would multiply that wait by the number of devices - which
  // is exactly when the user is opening the picker to watch a boot.
  const names = await Promise.all(serials.map((serial) => avdNameForSerial(serial)));
  const map = new Map();
  for (let index = 0; index < serials.length; index += 1) {
    const name = names[index];
    if (name) map.set(name, serials[index]);
  }
  return map;
}

/**
 * The AVD one online device is running, or null for a physical device.
 *
 * The emulator console is the primary source, but it stalls under load -
 * measured 1 in 4 calls timing out with empty stdout while the guest was
 * healthy - and a miss here makes a running AVD reappear as a second
 * "Stopped" row in the picker. The guest property `ro.boot.qemu.avd_name`
 * carries the same answer and is only consulted when the console says nothing,
 * so the console stays authoritative. A device whose guest never came up
 * cannot answer either probe; the callers retry, and boot detects readiness by
 * polling rather than trusting one sample.
 */
async function avdNameForSerial(serial) {
  // Same pressure as `wm size`: under load this timed out, and a missing
  // mapping makes a RUNNING avd show up as a second, "Stopped" row - inviting
  // the user to start a machine that is already up.
  let answered = await run('adb', ['-s', serial, 'emu', 'avd', 'name'], 8000);
  if (!answered.ok) {
    answered = await run('adb', ['-s', serial, 'emu', 'avd', 'name'], 8000);
  }
  if (answered.ok) {
    // The console prints the name first, then an "OK" line.
    const name = answered.stdout.split('\n').map((row) => row.trim()).find(Boolean);
    if (name) return name;
  }
  const property = await run('adb', ['-s', serial, 'shell', 'getprop', 'ro.boot.qemu.avd_name'], 3000);
  if (!property.ok) return null;
  return property.stdout.split('\n').map((row) => row.trim()).find(Boolean) ?? null;
}

/**
 * Every installed system image, read from the SDK's own directory layout
 * (`system-images/<api>/<tag>/<abi>`). `sdkmanager --list` would reach the
 * network and describe what is installable rather than what is on disk.
 */
async function listSystemImages() {
  const images = [];
  const apis = await fsp.readdir(SYSTEM_IMAGES_DIR, { withFileTypes: true }).catch(() => []);
  for (const apiRow of apis) {
    if (!apiRow.isDirectory()) continue;
    const api = apiRow.name;
    const tags = await fsp.readdir(path.join(SYSTEM_IMAGES_DIR, api), { withFileTypes: true }).catch(() => []);
    for (const tagRow of tags) {
      if (!tagRow.isDirectory()) continue;
      const tag = tagRow.name;
      const abis = await fsp
        .readdir(path.join(SYSTEM_IMAGES_DIR, api, tag), { withFileTypes: true })
        .catch(() => []);
      for (const abiRow of abis) {
        if (!abiRow.isDirectory()) continue;
        const abi = abiRow.name;
        images.push({
          id: `system-images;${api};${tag};${abi}`,
          api,
          tag,
          abi,
          label: `Android ${api.replace(/^android-/, '')} · ${tag} · ${abi}`,
        });
      }
    }
  }
  // Newest API first - `numeric` matters, because plain string order puts
  // "android-9" above "android-35" - then a stable tag/abi order so the same
  // catalogue always renders in the same order.
  images.sort(
    (a, b) =>
      b.api.localeCompare(a.api, 'en', { numeric: true })
      || a.tag.localeCompare(b.tag)
      || a.abi.localeCompare(b.abi),
  );
  return images;
}

/** Non-phone definitions: car, TV, watch, XR headset and desktop form factors. */
const NON_PHONE_TAGS = ['automotive', 'tv', 'wear', 'xr', 'desktop'];

function isNonPhoneTag(tag) {
  if (!tag) return false;
  const kind = tag.replace(/^android-/, '');
  return NON_PHONE_TAGS.some((name) => kind === name || kind.startsWith(`${name}-`));
}

/**
 * `avdmanager list device` in text form. `-c` is cheaper but prints ids only,
 * and the picker needs the human "Name: Pixel 6" label. Definitions are
 * separated by a dashed rule, and one without a `Tag:` line is a plain phone.
 */
async function listDeviceProfiles() {
  const result = await run(AVDMANAGER_BIN, ['list', 'device'], 20_000);
  if (!result.ok) {
    return { ok: false, error: avdFirstError(result, 'avdmanager list device failed') };
  }
  const devices = [];
  for (const block of result.stdout.split(/^-{3,}\s*$/m)) {
    const id = /^\s*id:\s*\d+\s+or\s+"([^"]+)"/m.exec(block)?.[1]
      ?? /^\s*id:\s*(.+)$/m.exec(block)?.[1]?.trim().replace(/^"|"$/g, '');
    const name = /^\s*Name:[ \t]*(.+)$/m.exec(block)?.[1]?.trim();
    const tag = /^\s*Tag[ \t]*:[ \t]*(.+)$/m.exec(block)?.[1]?.trim() ?? '';
    if (!id || !name) continue;
    if (isNonPhoneTag(tag)) continue;
    devices.push({ id, name });
  }
  return { ok: true, devices: devices.slice(0, AVD_CATALOG_MAX_DEVICES) };
}

/**
 * AVD names are directory names and adb arguments: no spaces, no newlines, and
 * only the characters the Android tools accept.
 */
function sanitizeAvdName(value) {
  return String(value ?? '')
    .replace(/[\r\n]+/g, ' ')
    .trim()
    .slice(0, AVD_NAME_MAX)
    .replace(/[^A-Za-z0-9._-]/g, '-');
}
async function createAndroidAvd({ name: requestedName, imageId, deviceId }) {
  // The image list is a local directory scan, so an unknown image is decidable
  // without spawning avdmanager at all.
  const images = await listSystemImages();
  const image = images.find((row) => row.id === imageId);
  if (!image) {
    note(`android create rejected: unknown imageId ${imageId}`);
    return { ok: false, status: 400, error: 'unknown imageId' };
  }

  if (deviceId) {
    const profiles = await listDeviceProfiles();
    if (!profiles.ok) {
      note(`android create rejected: device catalogue unavailable: ${profiles.error}`);
      return { ok: false, status: 502, error: profiles.error };
    }
    if (!profiles.devices.some((row) => row.id === deviceId)) {
      note(`android create rejected: unknown deviceId ${deviceId}`);
      return { ok: false, status: 400, error: 'unknown deviceId' };
    }
  }

  // An explicit blank name is treated as absent, like the iOS route: "" is not
  // a legal AVD name, and the default is strictly more useful than a nameless AVD.
  const requested = sanitizeAvdName(requestedName);
  const name = requested || sanitizeAvdName(`DSH Mirror ${image.api} ${image.tag}`);

  // `--force` does not reliably replace an existing AVD, so a same-name AVD is
  // deleted first. A failed delete is not fatal: create's own error is the one
  // worth reporting, and it is what the caller acts on.
  const existing = await listAvds();
  if (existing?.includes(name)) {
    const deleted = await run(AVDMANAGER_BIN, ['delete', 'avd', '-n', name], AVDMANAGER_TIMEOUT_MS);
    if (!deleted.ok) {
      note(`android create: delete of existing avd ${name} failed: ${avdFirstError(deleted, 'delete failed')}`);
    }
  }

  const args = ['create', 'avd', '-n', name, '-k', imageId];
  if (deviceId) args.push('-d', deviceId);
  args.push('--force');
  // Exit 0 is the only success signal; the SDK-XML version warning on stderr is
  // harmless and must not be read as a failure.
  const created = await runFeeding(AVDMANAGER_BIN, args, 'no\n');
  if (!created.ok) {
    const error = avdFirstError(created, 'avdmanager create avd failed');
    note(`android create failed (${name}): ${error}`);
    return { ok: false, status: 502, error };
  }
  // Success is audited too: this leaves a new AVD behind, so "who made this"
  // has to be answerable from /state. Booting is the caller's next step.
  note(`created android avd ${name} (${imageId}${deviceId ? ` · ${deviceId}` : ''})`);
  return { ok: true, avd: name };
}

async function waitForAvdBoot(name) {
  const startedAt = Date.now();
  let serial = null;
  for (;;) {
    if (!serial) serial = (await runningAvds()).get(name) ?? null;
    if (serial) {
      const completed = await run('adb', ['-s', serial, 'shell', 'getprop', 'sys.boot_completed'], 5000);
      if (completed.ok && String(completed.stdout).trim().includes('1')) {
        return { booted: true, serial, bootedInMs: Date.now() - startedAt };
      }
    }
    if (Date.now() - startedAt >= AVD_BOOT_TIMEOUT_MS) {
      return { booted: false, serial, phase: serial ? 'boot_completed' : 'adb' };
    }
    await sleep(AVD_BOOT_POLL_MS);
  }
}

/** Port the emulator should open its gRPC bridge on, or null when none is free. */
async function pickGrpcPort() {
  for (let offset = 0; offset < 6; offset += 1) {
    const port = GRPC_PORT_BASE + offset;
    const free = await new Promise((resolve) => {
      const probe = net.createServer();
      probe.once('error', () => resolve(false));
      probe.once('listening', () => probe.close(() => resolve(true)));
      probe.listen(port, '127.0.0.1');
    });
    if (free) return port;
  }
  return null;
}

/** Emulator argv. `-grpc` is only added when a port was actually reserved. */
function bootArgs(name, grpcPort) {
  const args = ['-avd', name, '-no-window', '-no-audio', '-no-boot-anim', '-no-snapshot'];
  if (grpcPort) args.push('-grpc', String(grpcPort));
  return args;
}

  return {
    ANDROID_SDK_DIR,
    AVDMANAGER_BIN,
    AVDMANAGER_TIMEOUT_MS,
    AVD_BOOT_POLL_MS,
    AVD_BOOT_TIMEOUT_MS,
    AVD_CATALOG_MAX_DEVICES,
    AVD_CHATTER,
    AVD_NAME_MAX,
    EMULATOR_BIN,
    NON_PHONE_TAGS,
    SYSTEM_IMAGES_DIR,
    avdFirstError,
    avdNameForSerial,
    bootArgs,
    countAttachedDevices,
    createAndroidAvd,
    isNonPhoneTag,
    listAvds,
    listDeviceProfiles,
    listSystemImages,
    pickGrpcPort,
    runFeeding,
    runningAvds,
    sanitizeAvdName,
    waitForAvdBoot,
  };
}

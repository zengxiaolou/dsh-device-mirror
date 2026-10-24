/**
 * Device Mirror — host half.
 *
 * Serves a live, throttled MJPEG view of one iOS Simulator or Android emulator,
 * plus a touch/key back-channel, to the two Client surfaces (right-sidebar tab
 * and a floating overlay). Everything here is an adapter: nothing is cached on
 * disk, nothing is written outside /tmp, and every child process is owned by the
 * producer that spawned it so a stopped stream leaves no orphan.
 *
 *   GET  /api/device-mirror/devices          discovered devices + capture state
 *   GET  /api/device-mirror/stream?...       multipart/x-mixed-replace JPEG body
 *   POST /api/device-mirror/input            tap / swipe / text / key
 *   POST /api/device-mirror/boot             boot (or no-op) an iOS simulator
 *   POST /api/device-mirror/shutdown         shut down (or no-op) an iOS simulator
 *   GET  /api/device-mirror/catalog          device types + runtimes a new device may use
 *   POST /api/device-mirror/create           create a Shutdown simulator (never boots it)
 *   GET  /api/device-mirror/android/catalog  system images + device definitions for a new AVD
 *   POST /api/device-mirror/android/create   define an AVD (never boots it)
 *   POST /api/device-mirror/android/boot     boot a defined AVD, wait for sys.boot_completed
 *   GET  /api/device-mirror/state            producers, subscribers, last errors
 *   GET  /api/device-mirror/report           Client boot beacon (diagnostics only)
 *
 * Why MJPEG and not h264: the two platforms have wildly asymmetric capture
 * primitives (Android streams h264 through `screenrecord`; the iOS Simulator
 * only hands back a PNG/JPEG per `simctl io screenshot`), so the one shared
 * representation both can produce cheaply is a JPEG frame. h264 is still what
 * Android captures in - ffmpeg converts it - because that is 19 fps versus
 * 3.7 fps for pixel polling.
 */
import { execFile, spawn } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';

export const PLUGIN_ID = '@local/dsh-device-mirror';
const PLUGIN_VERSION = '0.4.1';
const ROUTE_PREFIX = '/api/device-mirror';
const BOUNDARY = 'dshdevicemirrorframe';

/** Frame pacing: producers may run faster, but a browser does not need more. */
const DEFAULT_FPS = 10;
const MIN_FPS = 1;
const MAX_FPS = 30;
/** Rendered frame width in CSS pixels; the sidebar tab is ~400px wide. */
const DEFAULT_WIDTH = 380;
const MIN_WIDTH = 180;
const MAX_WIDTH = 900;
const DEFAULT_QUALITY = 12;

/** A producer with no subscriber is stopped, but surviving this grace makes tab switches cheap. */
const IDLE_STOP_MS = 15_000;
/**
 * How long a first frame may take before the stream route answers 504.
 * A simulator that was booted seconds ago needs boot + launch + a cold
 * screenshot; measured stretches of 6s+ make a 12s budget report errors that
 * resolve themselves, which trains the user to ignore the panel.
 */
const FIRST_FRAME_TIMEOUT_MS = 20_000;
/** `screenrecord --time-limit` cannot exceed 180s on most builds; restart well before. */
const ANDROID_SEGMENT_SECONDS = 170;
/** Parallel `simctl io screenshot` workers. 4 measured 13.1 fps versus 5.5 serial. */
const IOS_WORKERS = 3;
/** Spacing between worker starts, so captures interleave instead of bursting. */
const IOS_WORKER_STAGGER_MS = 60;
/** `simctl boot` is asynchronous: poll the device list until the state settles. */
const BOOT_POLL_INTERVAL_MS = 500;
const BOOT_TIMEOUT_MS = 60_000;
const BOOT_MAX_POLLS = 120;

/** Bounded diagnostic log: the panel and `/state` read it, nothing else. */



/**
 * Binary-safe sibling of `run`. `execFile` decodes stdout as utf8 by default,
 * which silently mangles a PNG; the snapshot primer needs the raw bytes.
 */

/**
 * One-shot PNG (or any image2pipe-decodable frame) to a scaled JPEG.
 *
 * Android's `screenrecord` is change-driven: a still screen emits nothing, so a
 * freshly opened mirror would sit blank until something moved. One `screencap`
 * snapshot becomes the first frame, and h264 takes over the moment the screen
 * changes.
 */
function encodeSingleFrame(imageBytes, width, quality) {
  if (!imageBytes || imageBytes.length < 1024) return Promise.resolve(null);
  return new Promise((resolve) => {
    const child = spawn(
      'ffmpeg',
      [
        '-hide_banner', '-loglevel', 'error',
        '-f', 'png_pipe', '-i', 'pipe:0',
        '-vf', `scale=${width}:-1:flags=lanczos`,
        '-pix_fmt', 'yuvj420p', '-strict', 'unofficial',
        '-q:v', String(quality),
        '-frames:v', '1', '-f', 'mjpeg', 'pipe:1',
      ],
      { stdio: ['pipe', 'pipe', 'ignore'] },
    );
    const chunks = [];
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.on('error', () => finish(null));
    child.on('exit', () => {
      const buffer = chunks.length ? Buffer.concat(chunks) : null;
      finish(buffer && buffer.length > 512 && buffer[0] === 0xff && buffer[1] === 0xd8 ? buffer : null);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(imageBytes);
  });
}

/**
 * Reassembles JPEG images from a byte stream. JPEG entropy-coded data
 * byte-stuffs every 0xFF, so 0xFFD9 can only be a real EOI marker - scanning
 * for it is safe and needs no full parser.
 */class JpegSplitter {
  constructor(onFrame) {
    this.onFrame = onFrame;
    this.buffer = Buffer.alloc(0);
    this.soi = Buffer.from([0xff, 0xd8, 0xff]);
    this.eoi = Buffer.from([0xff, 0xd9]);
  }

  push(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    for (;;) {
      const start = this.buffer.indexOf(this.soi);
      if (start < 0) {
        // Keep the tail: a marker split across two chunks is normal.
        if (this.buffer.length > 2) this.buffer = this.buffer.subarray(this.buffer.length - 2);
        return;
      }
      if (start > 0) this.buffer = this.buffer.subarray(start);
      const end = this.buffer.indexOf(this.eoi, 3);
      if (end < 0) return;
      const frame = this.buffer.subarray(0, end + 2);
      this.buffer = this.buffer.subarray(end + 2);
      if (frame.length > 512) this.onFrame(frame);
    }
  }
}

/**
 * Holds exactly one frame: producers overwrite it, a timer flushes it at the
 * requested cadence. "Latest frame wins" is what keeps a slow browser from
 * building a backlog of stale images - the thing that makes naive polling feel
 * seconds behind.
 */
class LatestFrame {
  constructor() {
    this.frame = null;
    this.at = 0;
    this.version = 0;
    this.waiters = new Set();
  }

  set(buffer) {
    this.frame = buffer;
    this.at = Date.now();
    this.version += 1;
    for (const waiter of this.waiters) waiter(buffer);
    this.waiters.clear();
  }

  /** Resolves with the current frame, or the next one, or null on timeout. */
  first(timeoutMs) {
    if (this.frame) return Promise.resolve(this.frame);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(settle);
        resolve(null);
      }, timeoutMs);
      const settle = (buffer) => {
        clearTimeout(timer);
        resolve(buffer);
      };
      this.waiters.add(settle);
    });
  }
}

import { createProducers } from './host/producers.js';
import { createEmulatorGrpc, GRPC_PORT_BASE } from './host/emulator-grpc.js';
import { sleep, simctlFirstError, run, runBuffer, clamp, note, diagnostics } from './host/shared.js';

// Android AVD lifecycle lives in its own module: the routes and the agent
// tools both need it, so it belongs to neither.
import { createAvdTools } from './host/android-avd.js';

const {
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
} = createAvdTools({ note, run, sleep });

import { createDevices } from './host/devices.js';

const {
  listAndroid, listIos, resolveDevice, resolveIosGeometry, simulatorState,
  injectAndroid, injectIos, iosBack, jpegSize, androidTextArg,
  inputGeometry, invalidateGeometry, waitForSimulatorBoot,
  ANDROID_KEYS, IOS_TAP_DURATION_S,
} = createDevices({ run, listAvds, runningAvds, sleep, BOOT_POLL_INTERVAL_MS, BOOT_TIMEOUT_MS, BOOT_MAX_POLLS });

const { acquire, producers, producerSpec } = createProducers({
  run, runBuffer, note, clamp, JpegSplitter,
  IOS_WORKERS, IOS_WORKER_STAGGER_MS, IDLE_STOP_MS,
  MIN_FPS, MAX_FPS, DEFAULT_FPS,
  MIN_WIDTH, MAX_WIDTH, DEFAULT_WIDTH, DEFAULT_QUALITY,
  ANDROID_SEGMENT_SECONDS,
  LatestFrame, encodeSingleFrame, simctlFirstError, simulatorState,
});



// HTTP
// ---------------------------------------------------------------------------


/** Bounded in-memory record of the Client halves that actually booted. */
const clientReports = [];

/** Emulator gRPC bridge: gives Android real time touch instead of a replay. */
const emulatorGrpc = createEmulatorGrpc({ note });

/** Temporary counters for the stream throttle (surfaced in /state). */
const streamDebug = { scheduled: 0, flushed: 0, skipped: 0, written: 0, dropped: 0, maxLagMs: 0, minGap: 0, lastWait: 0, fps: 0 };

/** Tool names this module instance has already published. */
const registeredToolNames = new Set();

// The tool surface lives in its own module; the Host hands it its helpers.
import { createToolDefinitions } from './host/tools.js';

const buildToolDefinitions = () => createToolDefinitions({
  run, runBuffer, note, spawn,
  listAndroid, listIos, listAvds, runningAvds,
  waitForAvdBoot, waitForSimulatorBoot,
  injectAndroid, injectIos,
  inputGeometry, invalidateGeometry, simctlFirstError,
  EMULATOR_BIN, createAndroidAvd,
});

export const inject = ['webServer'];

import { createRoutes } from './host/routes.js';

const { handleRequest } = createRoutes({
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
});

export function apply(ctx) {
  ctx.effect(() => () => emulatorGrpc.close());
  // Model-facing tools. Definitions already contain JSON Schema parameters;
  // registration does not depend on a host-only package being resolvable from
  // this local linked package.
  (async () => {
    let tools;
    try {
      tools = ctx.get('tools');
    } catch {
      tools = undefined;
    }
    if (!tools || typeof tools.register !== 'function') {
      note('tools service unavailable: agent tools not registered');
      return;
    }
    for (const definition of buildToolDefinitions()) {
      // `apply` can run more than once on one module instance (toggling the
      // entry re-applies it without reloading the file), and a settings toggle
      // did exactly that: the diagnostics showed each tool published twice.
      // Only the first publication of a name counts.
      if (registeredToolNames.has(definition.name)) continue;
      try {
        tools.register(definition);
        registeredToolNames.add(definition.name);
        note(`tool registered: ${definition.name}`);
      } catch (error) {
        note(`tool ${definition.name} not registered: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  })().catch((error) => note(`tool registration failed: ${error instanceof Error ? error.message : String(error)}`));

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'prefix',
      path: ROUTE_PREFIX,
      handler: (req, res) => {
        handleRequest(req, res);
      },
    }),
  );
  // Producers own OS child processes; a plugin reload must not leave ffmpeg and
  // adb running behind the new instance.
  ctx.effect(() => () => {
    for (const producer of producers.values()) producer.stop();
    producers.clear();
  });
}

/** Exported for the unit tests: the JPEG framer is the only tricky pure part. */
export const __test = { JpegSplitter, jpegSize, androidTextArg, clamp, buildToolDefinitions, producerSpec };

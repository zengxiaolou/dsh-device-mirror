/**
 * Capture producers.
 *
 * One producer per `platform:device`, reference-counted by the HTTP streams that
 * subscribe to it. Given its helpers as an argument instead of importing the
 * Host entry, so the capture pipeline can be read and changed without touching
 * the route table, and without an import cycle.
 *
 * @module @local/dsh-device-mirror/host/producers
 */
import { spawn } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * @param {object} deps - the Host helpers the producers reach into.
 * @returns {{Producer: Function, AndroidProducer: Function, IosProducer: Function, acquire: Function, producers: Map<string, object>}}
 */
export function createProducers(deps) {
  const {
    run, runBuffer, note, clamp, JpegSplitter,
    IOS_WORKERS, IOS_WORKER_STAGGER_MS, IDLE_STOP_MS,
    MIN_FPS, MAX_FPS, DEFAULT_FPS,
    MIN_WIDTH, MAX_WIDTH, DEFAULT_WIDTH, DEFAULT_QUALITY,
    ANDROID_SEGMENT_SECONDS,
    LatestFrame, encodeSingleFrame, simctlFirstError, simulatorState,
  } = deps;

/** Shared plumbing: own child processes, restart with backoff, publish frames. */
class Producer {
  constructor(spec) {
    this.key = `${spec.platform}:${spec.device}`;
    this.platform = spec.platform;
    this.device = spec.device;
    this.label = spec.label || spec.device;
    this.fps = spec.fps;
    this.width = spec.width;
    this.quality = spec.quality;
    /** Device pixel size of the full screen (what the tap must be scaled to). */
    this.nativeWidth = spec.nativeWidth || null;
    this.nativeHeight = spec.nativeHeight || null;
    /** Coordinate space the platform's input injector expects. */
    this.inputWidth = spec.inputWidth || this.nativeWidth;
    this.inputHeight = spec.inputHeight || this.nativeHeight;
    this.frames = new LatestFrame();
    this.children = new Set();
    this.timers = new Set();
    this.subscribers = new Set();
    this.started = false;
    this.stopped = false;
    this.lastError = null;
    this.lastFrameAt = 0;
    this.frameCount = 0;
    this.restarts = 0;
    this.idleTimer = null;
  }

  track(child) {
    this.children.add(child);
    child.on('exit', () => this.children.delete(child));
    child.on('error', (error) => this.fail(error));
    return child;
  }

  fail(error) {
    this.lastError = error instanceof Error ? error.message : String(error);
    note(`${this.key}: ${this.lastError}`);
  }

  schedule(fn, ms) {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (!this.stopped) fn();
    }, ms);
    this.timers.add(timer);
    return timer;
  }

  publish(frame) {
    this.frameCount += 1;
    this.lastFrameAt = Date.now();
    this.frames.set(frame);
    // Notify subscribers too. `subscribers` used to be a pure reference count,
    // so a handler registered through subscribe() never saw a frame - which is
    // why an arrival-driven writer would have stalled at the first frame.
    for (const handler of this.subscribers) {
      try {
        handler(frame);
      } catch {
        // One broken client must not take the producer down with it.
      }
    }
  }

  /**
   * Idempotent start. The stream route needs the children running before it can
   * wait for a first frame, which happens before any subscriber exists.
   */
  ensureStarted() {
    if (this.started) return;
    this.started = true;
    this.stopped = false;
    try {
      this.start();
    } catch (error) {
      this.fail(error);
    }
  }

  subscribe(handler) {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    this.subscribers.add(handler);
    this.ensureStarted();
    // Emit the newest frame immediately so a new subscriber never stares at a
    // blank box while it waits for the screen to change.
    if (this.frames.frame) handler(this.frames.frame);
    return () => {
      this.subscribers.delete(handler);
      if (this.subscribers.size === 0) this.armIdleStop();
    };
  }

  armIdleStop() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.subscribers.size === 0) this.stop();
    }, IDLE_STOP_MS);
  }

  stop() {
    this.stopped = true;
    this.started = false;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    for (const child of this.children) {
      try {
        child.kill('SIGKILL');
      } catch {
        // A child that is already gone is the normal case at stop time.
      }
    }
    this.children.clear();
    // Killing the local `adb exec-out` client does not reliably end the
    // `screenrecord` it started on the device: the recorder keeps encoding and
    // holds the device encoder. Only sent when this producer owned a capture.
    const owned = this.capture;
    this.capture = null;
    if (owned && this.platform === 'android') {
      run('adb', ['-s', this.device, 'shell', 'pkill', '-INT', 'screenrecord'], 4000).catch(() => {});
    }
    this.frames.frame = null;
  }

  /** Dedicated temp path per producer+worker, cleaned by the OS on /tmp reset. */
  tempPath(worker) {
    const safe = this.device.replace(/[^a-zA-Z0-9]/g, '').slice(0, 40) || 'device';
    return path.join(os.tmpdir(), `dsh-device-mirror-${safe}-${worker}.jpg`);
  }

  describe() {
    return {
      key: this.key,
      platform: this.platform,
      device: this.device,
      label: this.label,
      streaming: this.subscribers.size > 0,
      subscribers: this.subscribers.size,
      started: this.started,
      fps: this.fps,
      width: this.width,
      nativeWidth: this.nativeWidth,
      nativeHeight: this.nativeHeight,
      inputWidth: this.inputWidth,
      inputHeight: this.inputHeight,
      frameCount: this.frameCount,
      lastFrameAt: this.lastFrameAt || null,
      restarts: this.restarts,
      lastError: this.lastError,
    };
  }
}

/**
 * Android: `screenrecord` emits h264 into ffmpeg, which scales and re-encodes
 * to JPEG. `screenrecord` is change-driven, so a still screen produces no
 * frames at all - the last JPEG simply stays on screen, which is the behaviour
 * a mirror wants. Segments are restarted before `--time-limit` cuts them.
 */
class AndroidProducer extends Producer {
  constructor(spec) {
    super(spec);
    const even = (value) => Math.max(2, value & ~1);
    // Capture at the resolution we deliver (a 540-wide capture used to be
    // upscaled), but never above 720: the emulator encoder collapses past that.
    // Measured over 3 s with motion: 900x2000 → 2 frames, 720x1600 → 19,
    // 540x1200 → 21. Asking for more does not get sharper, it gets frozen.
    const native = this.nativeWidth || 1080;
    const ANDROID_CAPTURE_CEILING = 720;
    const captureWidth = even(Math.min(native, ANDROID_CAPTURE_CEILING, Math.max(540, Math.round(this.width))));
    // Never upscale the output past what was captured.
    this.outputWidth = Math.min(this.width, captureWidth);
    const ratio = this.nativeWidth && this.nativeHeight ? this.nativeHeight / this.nativeWidth : 2.2222;
    this.captureSize = `${captureWidth}x${even(Math.round(captureWidth * ratio))}`;
  }

  start() {
    // A still snapshot goes out first: `screenrecord` emits nothing until the
    // screen changes, and "blank panel for 12s then 504" is not an acceptable
    // answer to "show me this device".
    this.prime().catch((error) => this.fail(error));
    this.spawnSegment();
  }

  async prime() {
    const png = await runBuffer('adb', ['-s', this.device, 'exec-out', 'screencap', '-p'], 20_000);
    if (this.stopped) return;
    if (!png) {
      this.fail('screencap produced no bytes');
      return;
    }
    // Same width as the live frames, or the first picture is a different
    // resolution than everything that follows it.
    const jpeg = await encodeSingleFrame(png, this.outputWidth, this.quality);
    if (this.stopped) return;
    if (jpeg) this.publish(jpeg);
    else this.fail('could not encode the priming screenshot');
  }

  spawnSegment() {
    if (this.stopped) return;
    const ffmpegArgs = [
      '-hide_banner',
      '-loglevel', 'error',
      '-f', 'h264',
      '-i', 'pipe:0',
      '-vf', `scale=${this.outputWidth}:-1:flags=lanczos`,
      '-pix_fmt', 'yuvj420p',
      // The mjpeg encoder rejects the tv-range yuv420p that h264 decodes to,
      // and its frame-threading init fails with it; yuvj420p is the full-range
      // form it expects, and `unofficial` silences the strict-compliance gate.
      '-strict', 'unofficial',
      '-q:v', String(this.quality),
      '-f', 'mjpeg',
      'pipe:1',
    ];

    const capture = this.track(
      spawn(
        'adb',
        [
          '-s', this.device,
          'exec-out', 'screenrecord',
          '--output-format=h264',
          '--time-limit', String(ANDROID_SEGMENT_SECONDS),
          '--bit-rate', '4000000',
          '--size', this.captureSize,
          '-',
        ],
        { stdio: ['ignore', 'pipe', 'ignore'] },
      ),
    );

    this.capture = capture;
    const encoder = this.track(spawn('ffmpeg', ffmpegArgs, { stdio: ['pipe', 'pipe', 'pipe'] }));

    capture.stdout.pipe(encoder.stdin);
    capture.stdout.on('error', () => {});
    encoder.stdin.on('error', () => {});
    // `adb exec-out` reports "device not found" on stderr only; surface it.
    capture.on('exit', () => {
      if (this.capture === capture) this.capture = null;
      try {
        encoder.stdin.end();
      } catch {
        // Already closed.
      }
    });

    const splitter = new JpegSplitter((frame) => this.publish(frame));
    encoder.stdout.on('data', (chunk) => splitter.push(chunk));
    let stderrTail = '';
    encoder.stderr.on('data', (chunk) => {
      stderrTail = (stderrTail + String(chunk)).slice(-400);
    });

    encoder.on('exit', (code) => {
      if (this.stopped) return;
      if (stderrTail.trim()) this.fail(stderrTail.trim().split('\n').slice(-2).join(' '));
      // --time-limit ended the segment normally (code 0) or adb/ffmpeg died;
      // both need a fresh segment. Back off so a missing emulator does not spin.
      this.restarts += 1;
      const delay = code === 0 ? 120 : Math.min(5000, 500 * Math.min(10, this.restarts));
      this.schedule(() => this.spawnSegment(), delay);
    });
  }
}

/**
 * iOS Simulator: `simctl io screenshot` is the only capture primitive that
 * works (recordVideo cannot render to stdout, and idb's video stream was broken
 * on the machine this was written against). Workers run in parallel because each
 * capture is latency-bound, not throughput-bound: 5.5 fps serial, 13.1 fps at 4.
 */
class IosProducer extends Producer {
  start() {
    this.ready().catch((error) => this.fail(error));
  }

  /**
   * Refuse to capture a simulator that is not running. `simctl io screenshot`
   * against a shutdown device blocks for a full minute before failing, so a
   * retry loop would otherwise hold four processes open and say nothing useful.
   */
  async ready() {
    const state = await simulatorState(this.device);
    if (this.stopped) return;
    if (state && state !== 'Booted') {
      this.fail(`simulator is ${state} — boot it from the device picker`);
      this.stop();
      return;
    }
    this.startEncoder();
    for (let worker = 0; worker < IOS_WORKERS; worker += 1) this.startWorker(worker);
  }

  startEncoder() {
    if (this.stopped) return;
    const encoder = this.track(
      spawn(
        'ffmpeg',
        [
          '-hide_banner',
          '-loglevel', 'error',
          '-f', 'mjpeg',
          '-i', 'pipe:0',
          '-vf', `scale=${this.width}:-1:flags=lanczos`,
          '-pix_fmt', 'yuvj420p',
          '-strict', 'unofficial',
          '-q:v', String(this.quality),
          '-f', 'mjpeg',
          'pipe:1',
        ],
        { stdio: ['pipe', 'pipe', 'pipe'] },
      ),
    );
    this.encoder = encoder;
    const splitter = new JpegSplitter((frame) => this.publish(frame));
    encoder.stdout.on('data', (chunk) => splitter.push(chunk));
    encoder.stdin.on('error', () => {});
    encoder.stdout.on('error', () => {});
    let stderrTail = '';
    encoder.stderr.on('data', (chunk) => {
      stderrTail = (stderrTail + String(chunk)).slice(-400);
    });
    encoder.on('exit', () => {
      this.encoder = null;
      if (this.stopped) return;
      if (stderrTail.trim()) this.fail(stderrTail.trim().split('\n').slice(-2).join(' '));
      this.restarts += 1;
      this.schedule(() => this.startEncoder(), 400);
    });
  }

  /**
   * One capture loop. simctl can only write to a path, so each worker owns a
   * temp file; the read-back is what lets a single ffmpeg stay fed.
   */
  startWorker(worker) {
    const file = this.tempPath(worker);
    const loop = async () => {
      if (this.stopped) return;
      const result = await run('xcrun', ['simctl', 'io', this.device, 'screenshot', '--type=jpeg', file], 8000);
      if (this.stopped) return;
      if (!result.ok) {
        this.restarts += 1;
        // The simulator can be shut down while a stream is live. Re-checking the
        // state turns a silent retry loop into one actionable message.
        const state = await simulatorState(this.device);
        if (this.stopped) return;
        if (state && state !== 'Booted') {
          this.fail(`simulator is ${state} — boot it from the device picker`);
          this.stop();
          return;
        }
        this.fail(simctlFirstError(result, 'simctl screenshot failed'));
        this.schedule(loop, 1200);
        return;
      }
      const bytes = await fsp.readFile(file).catch(() => null);
      if (!bytes || bytes.length < 1024) {
        this.schedule(loop, 400);
        return;
      }
      const encoder = this.encoder;
      if (encoder && encoder.stdin.writable) {
        try {
          encoder.stdin.write(bytes);
        } catch {
          // A dead encoder is restarted by its own exit handler.
        }
      }
      // No delay: the capture call itself paces the loop (~180-260ms).
      this.schedule(loop, 0);
    };
    // Stagger the workers. Without this all IOS_WORKERS captures land within a
    // few milliseconds of each other, the frames arrive in bursts of three, and
    // an arrival-driven writer can only deliver ~1 frame per burst (measured
    // 5-7 fps from a 15.6 fps producer). Spacing them keeps a steady cadence.
    this.schedule(() => loop().catch((error) => this.fail(error)), worker * IOS_WORKER_STAGGER_MS);
  }
}

/** Keyed, reference-counted registry so a tab and the overlay share one capture. */
const producers = new Map();

function producerSpec(device, platform, options) {
  const fps = clamp(options.fps, MIN_FPS, MAX_FPS, DEFAULT_FPS);
  const width = clamp(options.width, MIN_WIDTH, MAX_WIDTH, DEFAULT_WIDTH);
  const quality = clamp(options.quality, 2, 25, DEFAULT_QUALITY);
  return { ...device, platform, fps, width, quality };
}

function acquire(device, platform, options) {
  const key = `${platform}:${device.device}`;
  const existing = producers.get(key);
  const spec = producerSpec(device, platform, options);
  if (existing) {
    // A width/quality change is a different encoder; rebuild rather than lie.
    if (existing.width !== spec.width || existing.quality !== spec.quality) {
      existing.stop();
      producers.delete(key);
    } else {
      return existing;
    }
  }
  const producer = platform === 'android' ? new AndroidProducer(spec) : new IosProducer(spec);
  producers.set(key, producer);
  return producer;
}
  return { Producer, AndroidProducer, IosProducer, acquire, producers, producerSpec };
}

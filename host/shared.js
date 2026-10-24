import { execFile } from 'node:child_process';

/**
 * Helpers shared by more than one Host module.
 *
 * Both had exactly one home and two or three callers, and moving a consumer (the
 * routes, most recently) dragged them along and broke the others. They live here
 * now so a consumer can move without taking them hostage.
 *
 * @module @local/dsh-device-mirror/host/shared
 */

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * `simctl` answers a no-op boot/shutdown with a non-zero exit that names the
 * current state ("Unable to boot device in current state: Booted") instead of
 * failing. Reading that state back is what makes both routes idempotent.
 */
export function simctlCurrentState(text) {
  const match = /current state:\s*([A-Za-z][A-Za-z ]*)/i.exec(String(text ?? ''));
  return match ? match[1].trim() : null;
}

/**
 * First meaningful stderr line. simctl prefixes real messages with its own
 * chatter ("Note: No display specified..."), and taking the first line verbatim
 * makes an informational note look like the failure - which then hides the
 * actual error in the diagnostics log.
 */
export function simctlFirstError(result, fallback) {
  const text = (result.stderr || '').trim() || (result.stdout || '').trim();
  const lines = text.split('\n').map((row) => row.trim()).filter(Boolean);
  const meaningful = lines.find((row) => !/^note[:\s]/i.test(row));
  // When the only thing captured is simctl's own chatter, reporting it as the
  // failure is worse than reporting nothing specific.
  return meaningful || fallback;
}

/**
 * Polls until the udid reports Booted. Bounded by both the poll count and the
 * wall clock, so a slow `simctl list` cannot stretch the 60s promise either.
 */

export function run(command, args, timeout = 10_000) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? ''),
        code: error && typeof error.code === 'number' ? error.code : error ? -1 : 0,
        // `killed` is how execFile reports its own timeout. Without carrying it
        // out, a busy machine turned every tap into the same opaque "injection
        // failed" as a real bug.
        timedOut: Boolean(error && error.killed),
      });
    });
  });
}

export function clamp(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

export function runBuffer(command, args, timeout = 20_000) {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { timeout, encoding: 'buffer', maxBuffer: 32 * 1024 * 1024, windowsHide: true },
      (error, stdout) => {
        if (stdout && stdout.length) resolve(stdout);
        else resolve(null);
      },
    );
  });
}

/** Bounded ring of recent Host events, read by GET /state. */
export const diagnostics = [];

export function note(message) {
  const text = String(message).slice(0, 400);
  const last = diagnostics[diagnostics.length - 1];
  // A retry loop can repeat one failure hundreds of times; collapsing it keeps
  // the 60-slot buffer useful instead of filling it with one line.
  if (last && last.message === text) {
    last.repeat = (last.repeat ?? 1) + 1;
    last.at = Date.now();
    return;
  }
  diagnostics.push({ at: Date.now(), message: text, repeat: 1 });
  while (diagnostics.length > 60) diagnostics.shift();
}

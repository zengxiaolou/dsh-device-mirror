/**
 * Android emulator touch injection over its gRPC bridge.
 *
 * `adb shell input` injects one event from a throwaway process, so a drag has to
 * be replayed as a single `input swipe` with a fixed duration - the mirror can
 * never follow the finger, it can only replay it after release. The emulator
 * exposes `EmulatorController/sendTouch`, which accepts a touch stream, so a
 * drag can be forwarded as it happens.
 *
 * No dependency is added: gRPC is HTTP/2 with a 5-byte length prefix and these
 * messages are three varints each, so the wire format is written by hand and
 * the transport is Node's built-in `http2`. Verified against `grpcurl` on
 * message shape, and against the device on effect (a drag opens the drawer).
 *
 * @module @local/dsh-device-mirror/host/emulator-grpc
 */
import http2 from 'node:http2';

const SERVICE = '/android.emulation.control.EmulatorController/sendTouch';
/** Ports the emulator is willing to use; the plugin asks for one of these. */
const PORT_BASE = 8554;
const PORT_SPAN = 6;

const varint = (value) => {
  const out = [];
  let v = value >>> 0;
  while (v > 0x7f) {
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  out.push(v);
  return Buffer.from(out);
};
const tag = (field, wire) => varint((field << 3) | wire);

/** Encode `TouchEvent { repeated Touch touches = 1 }` for one pointer. */
export function encodeTouchEvent({ x, y, pressure }) {
  const touch = Buffer.concat([
    tag(1, 0), varint(x),        // int32 x
    tag(2, 0), varint(y),        // int32 y
    tag(4, 0), varint(pressure), // int32 pressure (0 lifts the finger)
    tag(7, 0), varint(1),        // expiration = NEVER_EXPIRE
  ]);
  return Buffer.concat([tag(1, 2), varint(touch.length), touch]);
}

/** gRPC frame: one compression byte, then a big-endian length. */
function grpcFrame(message) {
  const head = Buffer.alloc(5);
  head[0] = 0;
  head.writeUInt32BE(message.length, 1);
  return Buffer.concat([head, message]);
}

/**
 * @param {{note: (message: string) => void}} deps
 */
export function createEmulatorGrpc({ note }) {
  /** serial -> { port, session, ready } */
  const links = new Map();
  /** Cache of the probe, so a foreign emulator is not re-probed per touch. */
  let probedAt = 0;
  let probeResult = null;

  const connect = (port) =>
    new Promise((resolve, reject) => {
      const session = http2.connect(`http://127.0.0.1:${port}`);
      const timer = setTimeout(() => {
        session.destroy();
        reject(new Error('connect timeout'));
      }, 1500);
      session.once('connect', () => {
        clearTimeout(timer);
        resolve(session);
      });
      session.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });

  /** Send one touch sample; resolves true when the emulator accepted it. */
  const send = (link, point) =>
    new Promise((resolve) => {
      if (!link.session || link.session.closed || link.session.destroyed) {
        resolve(false);
        return;
      }
      let failed = false;
      const req = link.session.request({
        ':method': 'POST',
        ':path': SERVICE,
        'content-type': 'application/grpc',
        te: 'trailers',
      });
      req.on('response', (headers) => {
        if (headers[':status'] !== 200) failed = true;
      });
      req.on('trailers', (trailers) => {
        const status = trailers['grpc-status'];
        if (status !== undefined && String(status) !== '0') failed = true;
      });
      req.on('data', () => {});
      req.on('error', () => {
        failed = true;
      });
      req.on('end', () => resolve(!failed));
      req.end(grpcFrame(encodeTouchEvent(point)));
    });

  return {
    /** Remember the port an emulator was started with. */
    register(serial, port) {
      if (!serial || !port) return;
      links.set(serial, { port: Number(port), session: null, ready: null });
    },

    registeredPort(serial) {
      return links.get(serial)?.port ?? null;
    },

    /**
     * Find a bridge for a serial the plugin did not start.
     *
     * Only safe when exactly one device is attached: the bridge does not carry a
     * serial, so adopting it with two emulators could drive the wrong one.
     */
    async adopt(serial, attachedCount) {
      if (links.has(serial)) return links.get(serial).port;
      if (attachedCount !== 1) return null;
      if (probeResult && Date.now() - probedAt < 30_000) return probeResult;
      let found = null;
      for (let offset = 0; offset < PORT_SPAN; offset += 1) {
        const port = PORT_BASE + offset;
        try {
          const session = await connect(port);
          session.close();
          found = port;
          break;
        } catch {
          // Nothing listening on this port; try the next.
        }
      }
      probedAt = Date.now();
      probeResult = found;
      if (found) {
        note(`android:grpc bridge adopted on port ${found}`);
        links.set(serial, { port: found, session: null, ready: null });
      }
      return found;
    },

    has(serial) {
      return links.has(serial);
    },

    /** Ensure a live session, then forward one touch sample. */
    async touch(serial, point) {
      const link = links.get(serial);
      if (!link) return { ok: false, reason: 'no bridge' };
      if (!link.session || link.session.closed || link.session.destroyed) {
        link.session = null;
        try {
          link.session = await connect(link.port);
        } catch (error) {
          return { ok: false, reason: error instanceof Error ? error.message : String(error) };
        }
        link.session.on('error', () => {
          link.session = null;
        });
        link.session.on('close', () => {
          link.session = null;
        });
      }
      const ok = await send(link, point);
      return ok ? { ok: true } : { ok: false, reason: 'sendTouch rejected' };
    },

    close() {
      for (const link of links.values()) {
        try {
          link.session?.close();
        } catch {
          // Already gone.
        }
      }
      links.clear();
    },
  };
}

export const GRPC_PORT_BASE = PORT_BASE;

/**
 * Host-half tests. Two things are worth pinning down here:
 *   1. the JPEG framer, because a bad frame boundary shows up as a torn image
 *      only at runtime, and
 *   2. the route surface, because a plugin that fails to register is otherwise
 *      indistinguishable from one whose client never loaded.
 *
 * The route tests run a real http.Server against the handler the plugin hands
 * to `webServer.register`, so no DSH host is needed.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { __test, apply } from '../index.js';

const { JpegSplitter, jpegSize, androidTextArg, clamp, buildToolDefinitions, producerSpec } = __test;

let passed = 0;
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1;
      console.log(`  ok  ${name}`);
    })
    .catch((error) => {
      console.error(`  FAIL ${name}\n       ${error.message}`);
      process.exitCode = 1;
    });
}

// --- a minimal, structurally valid JPEG so jpegSize has real bytes to read ---
function fakeJpeg(width, height, payload = 4096) {
  const sof = Buffer.alloc(19);
  sof.writeUInt16BE(0xffc0, 0);
  sof.writeUInt16BE(17, 2);
  sof.writeUInt8(8, 4);
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  sof.writeUInt8(3, 9);
  for (let i = 0; i < 3; i += 1) {
    sof.writeUInt8(1 + i, 10 + i * 3);
    sof.writeUInt8(0x11, 11 + i * 3);
    sof.writeUInt8(0, 12 + i * 3);
  }
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    sof,
    Buffer.alloc(payload, 0x5a),
    Buffer.from([0xff, 0xd9]),
  ]);
}

await check('JpegSplitter reassembles frames split across chunks', () => {
  const frames = [];
  const splitter = new JpegSplitter((frame) => frames.push(frame));
  const a = fakeJpeg(360, 780, 2000);
  const b = fakeJpeg(360, 780, 1500);
  const stream = Buffer.concat([a, b]);
  // Feed one byte at a time: the worst case for a boundary split.
  for (let i = 0; i < stream.length; i += 1) splitter.push(stream.subarray(i, i + 1));
  assert.equal(frames.length, 2, `expected 2 frames, got ${frames.length}`);
  assert.equal(frames[0].length, a.length);
  assert.equal(frames[1].length, b.length);
});

await check('JpegSplitter ignores a truncated trailing frame', () => {
  const frames = [];
  const splitter = new JpegSplitter((frame) => frames.push(frame));
  const a = fakeJpeg(360, 780, 1200);
  splitter.push(a);
  splitter.push(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]));
  assert.equal(frames.length, 1);
});

await check('jpegSize reads SOF dimensions', () => {
  assert.deepEqual(jpegSize(fakeJpeg(380, 823)), { width: 380, height: 823 });
  assert.equal(jpegSize(Buffer.from([0, 1, 2, 3])), null);
  assert.equal(jpegSize(null), null);
});

await check('androidTextArg encodes spaces and escapes percent', () => {
  assert.equal(androidTextArg('hello world'), 'hello%sworld');
  assert.equal(androidTextArg('50%'), '50\\%');
});

await check('clamp rejects non-finite input and honours bounds', () => {
  assert.equal(clamp('12', 1, 30, 10), 12);
  assert.equal(clamp(undefined, 1, 30, 10), 10);
  assert.equal(clamp(0, 1, 30, 10), 1);
  assert.equal(clamp(999, 1, 30, 10), 30);
  assert.equal(clamp('abc', 1, 30, 10), 10);
});

await check('split modules reference no undeclared host symbol', async () => {
  // The producers and tools modules receive their helpers as arguments, so a
  // forgotten dependency is invisible until the first request that touches it:
  // this exact gap shipped twice (MIN_FPS, then LatestFrame) before a runtime
  // 500 caught it. This walks the files and cross-checks every identifier
  // against the entry module's declarations.
  const { readFile, readdir } = await import('node:fs/promises');
  const entry = await readFile(new URL('../index.js', import.meta.url), 'utf8');
  const declared = new Set();
  for (const re of [
    /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm,
    /^(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/gm,
    /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm,
  ]) {
    for (const m of entry.matchAll(re)) declared.add(m[1]);
  }
  // The entry file also owns symbols via `import` (fsp, GRPC_PORT_BASE ...).
  // Leaving those out let a moved block reference `fsp` without anyone noticing
  // until the route answered 500 at runtime.
  for (const m of entry.matchAll(/^import\s+(?:\{(?<named>[^}]*)\}|(?<star>\w+))\s+from/gm)) {
    for (const definition of (m.groups.named ?? '').split(',')) {
      const name = definition.split(' as ').pop().trim();
      if (name) declared.add(name);
    }
    if (m.groups.star) declared.add(m.groups.star);
  }
  const globals = new Set(('Number String Boolean Array Object JSON Math Date Error Promise Map Set Symbol ' +
    'Infinity NaN undefined globalThis console process Buffer URL URLSearchParams setTimeout ' +
    'clearTimeout setInterval clearInterval fetch structuredClone Intl RegExp Function BigInt').split(' '));

  const dir = new URL('../host/', import.meta.url);
  const files = (await readdir(dir)).filter((f) => f.endsWith('.js'));
  assert.ok(files.length > 0, 'expected split modules under host/');

  const offenders = [];
  for (const file of files) {
    const src = await readFile(new URL(file, dir), 'utf8');
    const local = new Set();
    for (const re of [
      /(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g,
      /class\s+([A-Za-z_$][\w$]*)/g,
      /(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g,
    ]) {
      for (const m of src.matchAll(re)) local.add(m[1]);
    }
    const injected = new Set();
    // Two accepted shapes: `createX(deps) { const { a } = deps; }` and the
    // shorter `createX({ a, b })` parameter destructuring.
    const patterns = [
      /export function create\w*\(deps\) \{\s*const \{([^}]*)\} = deps;/s,
      /export function create\w*\(\{([^}]*)\}\)/s,
    ];
    for (const pattern of patterns) {
      const found = pattern.exec(src);
      if (!found) continue;
      for (const part of found[1].split(',')) {
        const name = part.split(':')[0].split('=')[0].trim();
        if (name) injected.add(name);
      }
    }
    const imported = new Set();
    for (const m of src.matchAll(/^import\s+(?:(\w+)|\{([^}]*)\})\s+from/gm)) {
      if (m[1]) imported.add(m[1]);
      if (m[2]) for (const part of m[2].split(',')) {
        const name = part.split(' as ').pop().trim();
        if (name) imported.add(name);
      }
    }
    // Strip string and template literals first: `':path'` is an HTTP/2 header
    // name, not a reference to a `path` helper, and quoting alone produced a
    // false positive here.
    // Strip comments, regex literals, then string literals. Without the first
    // two, a comment ("an informational note") or a pattern such as
    // `/^note[:\s]/i` reads as a reference to a `note` helper that does not exist.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
      .replace(/\/(?![*/])(?:\.|[^/\\\n])*[\^\[\\$][^/\n]*\/[gimsuy]*/g, ' ') 
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
      .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
      .replace(/`(?:[^`\\]|\\.)*`/g, '``');
    const used = new Set(code.match(/(?<![\w$.])[A-Za-z_$][\w$]*/g) ?? []);
    for (const name of used) {
      if (declared.has(name) && !local.has(name) && !injected.has(name) && !imported.has(name)) {
        offenders.push(`${file}: ${name}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `undeclared host symbols: ${offenders.join(', ')}`);
});

await check('the emulator touch encoder emits the bytes the bridge accepts', async () => {
  // Hand-rolled protobuf is the one place a silent typo costs an afternoon: a
  // wrong tag parses into nonsense and the emulator simply ignores it. These
  // bytes are the ones that opened the app drawer in a real drag.
  const { encodeTouchEvent } = await import('../host/emulator-grpc.js');
  // 0a 0a  = touches(1), length-delimited, 10 bytes
  // 08 9c 04 = x(1) = 540          10 b0 09 = y(2) = 1200
  // 20 01    = pressure(4) = 1     38 01     = expiration(7) = NEVER_EXPIRE
  assert.equal(
    encodeTouchEvent({ x: 540, y: 1200, pressure: 1 }).toString('hex'),
    '0a0a089c0410b00920013801',
  );
  // A lift carries pressure 0 explicitly, which is what ends the gesture.
  assert.equal(
    encodeTouchEvent({ x: 540, y: 900, pressure: 0 }).toString('hex'),
    '0a0a089c0410840720003801',
  );
});

await check('producerSpec clamps options and resolves every constant it needs', () => {
  // Guard for the module split: moving the producers out of the entry file means
  // their constants arrive as arguments, and a forgotten one only shows up as a
  // ReferenceError on the first stream request. This asserts the clamp path runs.
  const spec = producerSpec(
    { platform: 'ios', device: 'UDID', label: 'iPhone', state: 'Booted' },
    'ios',
    { fps: '999', width: '9999', quality: '99' },
  );
  assert.equal(spec.fps, 30, 'fps must clamp to the upper bound');
  assert.equal(spec.width, 900, 'width must clamp to the upper bound');
  assert.equal(spec.quality, 25, 'quality must clamp to the JPEG ceiling');
  assert.equal(spec.platform, 'ios');
  assert.equal(spec.device, 'UDID');
});

await check('agent tools expose object-root JSON schemas', () => {
  const tools = buildToolDefinitions();
  assert.ok(tools.length >= 8, `expected device tools, got ${tools.length}`);
  for (const tool of tools) {
    assert.equal(tool.parameters.type, 'object', `${tool.name} schema root is not object`);
    assert.equal(typeof tool.parameters.properties, 'object', `${tool.name} properties missing`);
    if (tool.parameters.required) {
      assert.ok(Array.isArray(tool.parameters.required), `${tool.name} required is not an array`);
      for (const name of tool.parameters.required) {
        assert.ok(Object.hasOwn(tool.parameters.properties, name), `${tool.name} requires undeclared ${name}`);
      }
    }
  }
  const boot = tools.find((tool) => tool.name === 'device_mirror_boot');
  assert.deepEqual(boot.parameters.required, ['platform', 'device']);
  assert.equal(boot.parameters.properties.platform.required, undefined);
});

await check('apply registers a prefix route on webServer', () => {
  let registered = null;
  const ctx = {
    effect: (fn) => {
      const disposer = fn();
      return disposer;
    },
    webServer: {
      register: (spec) => {
        registered = spec;
        return () => {};
      },
    },
  };
  apply(ctx);
  assert.ok(registered, 'webServer.register was never called');
  assert.equal(registered.kind, 'prefix');
  assert.equal(registered.path, '/api/device-mirror');
  assert.equal(typeof registered.handler, 'function');
});

// --- live route surface -----------------------------------------------------
let handler = null;
const ctx = {
  effect: (fn) => {
    fn();
  },
  webServer: { register: (spec) => { handler = spec.handler; return () => {}; } },
};
apply(ctx);

const server = http.createServer((req, res) => handler(req, res));
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

await check('GET /devices answers with both platform buckets', async () => {
  const response = await fetch(`${base}/api/device-mirror/devices`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.ok(body.android && Array.isArray(body.android.devices), 'android bucket missing');
  assert.ok(body.ios && Array.isArray(body.ios.devices), 'ios bucket missing');
});

await check('cross-origin request is rejected', async () => {
  const response = await fetch(`${base}/api/device-mirror/devices`, {
    headers: { origin: 'https://evil.example.com' },
  });
  assert.equal(response.status, 403);
});

await check('unknown route is a 404 with the plugin error shape', async () => {
  const response = await fetch(`${base}/api/device-mirror/nope`);
  assert.equal(response.status, 404);
  const body = await response.json();
  assert.equal(body.ok, false);
});

await check('POST /input without kind is rejected', async () => {
  const response = await fetch(`${base}/api/device-mirror/input`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ platform: 'android', device: 'nope' }),
  });
  assert.ok([400, 404].includes(response.status), `unexpected status ${response.status}`);
});

await check('stream for an unknown device is a 404, not a hang', async () => {
  const response = await fetch(`${base}/api/device-mirror/stream?platform=android&device=does-not-exist`);
  assert.equal(response.status, 404);
  const body = await response.json();
  assert.equal(body.ok, false);
});

// --- simulator lifecycle routes ---------------------------------------------
// None of these may reach a real boot: the only ios udid used is a value no
// simulator can have, so `simctl boot` is never spawned.
await check('POST /boot without platform or device is rejected', async () => {
  const response = await fetch(`${base}/api/device-mirror/boot`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.ok(response.status >= 400 && response.status < 500, `unexpected status ${response.status}`);
  const body = await response.json();
  assert.equal(body.ok, false);
});

await check('POST /boot rejects a non-ios platform', async () => {
  const response = await fetch(`${base}/api/device-mirror/boot`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ platform: 'android', device: 'emulator-5554' }),
  });
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.match(body.error, /only supported/);
});

await check('POST /boot for an unknown udid is a 404', async () => {
  const response = await fetch(`${base}/api/device-mirror/boot`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ platform: 'ios', device: '00000000-0000-0000-0000-000000000000' }),
  });
  assert.equal(response.status, 404);
  const body = await response.json();
  assert.equal(body.ok, false);
});

await check('POST /shutdown rejects a non-ios platform', async () => {
  const response = await fetch(`${base}/api/device-mirror/shutdown`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ platform: 'android', device: 'emulator-5554' }),
  });
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.match(body.error, /only supported/);
});

// --- simulator catalogue + creation -----------------------------------------
// The create route is only exercised on its rejection branches. Every case here
// is decided before `simctl create` is spawned, so this suite never creates or
// deletes a simulator: the unknown identifiers are values no runtime has.
let catalogBody = null;

await check('GET /catalog answers with device types and runtimes', async () => {
  const response = await fetch(`${base}/api/device-mirror/catalog`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.ok(Array.isArray(body.deviceTypes), 'deviceTypes is not an array');
  assert.ok(Array.isArray(body.runtimes), 'runtimes is not an array');
  for (const row of body.deviceTypes) {
    assert.ok(row.identifier && row.name, 'a device type is missing its identifier or name');
  }
  // Both halves are optional on a machine without runtimes installed, but any
  // row that is present must carry the identifier the create route validates.
  if (body.runtimes.length > 0) {
    assert.ok(
      body.runtimes.every((row) => typeof row.identifier === 'string' && row.identifier.length > 0),
      'a runtime is missing its identifier',
    );
  }
  catalogBody = body;
});

await check('POST /create without identifiers is rejected', async () => {
  const response = await fetch(`${base}/api/device-mirror/create`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.match(body.error, /missing/);
});

await check('POST /create with an unknown device type is rejected', async () => {
  const response = await fetch(`${base}/api/device-mirror/create`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.__nope__',
      runtimeIdentifier: 'com.apple.CoreSimulator.SimRuntime.__nope__',
    }),
  });
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.equal(body.error, 'unknown deviceTypeIdentifier');
});

await check('POST /create with an unknown runtime is rejected', async () => {
  const deviceType = catalogBody?.deviceTypes?.[0];
  assert.ok(deviceType, 'the catalogue returned no device type to validate against');
  const response = await fetch(`${base}/api/device-mirror/create`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      deviceTypeIdentifier: deviceType.identifier,
      runtimeIdentifier: 'com.apple.CoreSimulator.SimRuntime.__nope__',
    }),
  });
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.equal(body.error, 'unknown runtimeIdentifier');
});

await check('GET /create is a 405', async () => {
  const response = await fetch(`${base}/api/device-mirror/create`);
  assert.equal(response.status, 405);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.equal(body.error, 'method-not-allowed');
});

// --- android AVD catalogue + creation ---------------------------------------
// Same rule as the iOS routes: only reads and rejection branches. Nothing here
// creates, boots or deletes an AVD, so the suite is safe to run against a real
// SDK - every case is decided before `avdmanager` is spawned.
await check('GET /android/catalog answers with system images and device definitions', async () => {
  const response = await fetch(`${base}/api/device-mirror/android/catalog`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.ok(Array.isArray(body.images), 'images is not an array');
  assert.ok(Array.isArray(body.devices), 'devices is not an array');
  for (const row of body.images) {
    assert.ok(row.id && row.api && row.tag && row.abi, 'an image row is missing a field');
  }
  for (const row of body.devices) {
    assert.ok(row.id && row.name, 'a device definition is missing its id or name');
  }
});

await check('POST /android/create without imageId is rejected', async () => {
  const response = await fetch(`${base}/api/device-mirror/android/create`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.match(body.error, /missing imageId/);
});

await check('POST /android/create with an unknown image is rejected', async () => {
  const response = await fetch(`${base}/api/device-mirror/android/create`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ imageId: 'system-images;android-99;nope;x86' }),
  });
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.equal(body.error, 'unknown imageId');
});

await check('POST /android/boot for an unknown AVD is a 404', async () => {
  const response = await fetch(`${base}/api/device-mirror/android/boot`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: '__no_such_avd__' }),
  });
  assert.equal(response.status, 404);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.match(body.error, /unknown avd/);
});

await check('GET /android/boot is a 405', async () => {
  const response = await fetch(`${base}/api/device-mirror/android/boot`);
  assert.equal(response.status, 405);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.equal(body.error, 'method-not-allowed');
});

server.close();
console.log(`\n${passed} checks passed${process.exitCode ? ' (with failures)' : ''}`);

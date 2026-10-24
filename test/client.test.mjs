/**
 * Client-half tests.
 *
 * What is worth pinning down without a browser:
 *   1. the multipart reader agrees with the byte format the Host writes;
 *   2. `apply()` registers one overlay on one slot and touches no other service;
 *   3. the multi-window model behaves — every "add" gets its own device, panels
 *      move and close independently, and the persisted shape round-trips;
 *   4. a window with a live frame keeps its device box free of controls.
 *
 * The factory is loaded under a stub `window.__ModuleLoader__` with a stub React
 * module table and an in-memory localStorage — the same handoff the page does.
 */
import assert from 'node:assert/strict';

// --- stubs the module expects to find already installed ---------------------
const storage = new Map();
globalThis.window = {
  __ModuleLoader__: {
    load({ id, factory }) {
      assert.equal(id, 'dsh-device-mirror', 'client module id must equal the package name');
      factoryResult = factory((name) => {
        if (name === 'react') return stubReact();
        throw new Error(`unexpected require("${name}")`);
      });
    },
  },
  localStorage: {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
  },
  innerWidth: 1280,
  innerHeight: 900,
};

/**
 * Per-component hook overrides, indexed by the flat useState call order.
 * `useStore()` itself calls useState first, so a component's own first state is
 * index 1. This is what lets a test render "a live frame" without a browser.
 */
let hookOverrides = {};
let currentComponent = '';
let hookIndex = 0;
let hookCalls = [];

function setHookOverrides(next) {
  hookOverrides = next ?? {};
  currentComponent = '';
  hookIndex = 0;
  hookCalls = [];
}

function stubReact() {
  const noop = () => {};
  return {
    createElement: (type, props, ...children) => ({ type, props: { ...(props || {}), children: children.flat(Infinity) } }),
    useState(initial) {
      const index = hookIndex++;
      const table = hookOverrides[currentComponent] ?? {};
      const value = Object.prototype.hasOwnProperty.call(table, index)
        ? table[index]
        : typeof initial === 'function' ? initial() : initial;
      // Recording setter: lets a test assert that a click actually reached a
      // state transition, instead of only asserting that a handler exists.
      const setter = (next) => { hookCalls.push({ component: currentComponent, index, value: next }); };
      return [value, setter];
    },
    useRef: (initial) => ({ current: initial }),
    useEffect: noop,
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
  };
}

let factoryResult = null;
await import('../client.js');

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

/** Renders one component with the hook overrides set for it. */
function render(component, overrides, props = {}) {
  setHookOverrides(overrides);
  currentComponent = component.name;
  hookIndex = 0;
  try {
    return component(props);
  } finally {
    setHookOverrides({});
  }
}

function shallowRender(node, depth = 0) {
  if (node === null || node === undefined || typeof node === 'boolean') return 0;
  if (typeof node === 'string' || typeof node === 'number') return 0;
  if (Array.isArray(node)) return node.reduce((count, child) => count + shallowRender(child, depth), 0);
  if (typeof node.type === 'function') {
    if (depth > 6) return 0;
    const previousName = currentComponent;
    const previousIndex = hookIndex;
    currentComponent = node.type.name || 'anonymous';
    hookIndex = 0;
    try {
      return 1 + shallowRender(node.type(node.props), depth + 1);
    } finally {
      currentComponent = previousName;
      hookIndex = previousIndex;
    }
  }
  return shallowRender(node.props?.children, depth);
}

function withStore(patch, run) {
  const { store } = factoryResult.__test;
  const before = store.get();
  store.set(patch);
  try {
    return run();
  } finally {
    store.set(before);
  }
}

const DEVICES = [
  { platform: 'android', device: 'emulator-5554', label: 'Pixel 7', state: 'device', nativeWidth: 1080, nativeHeight: 2400 },
  { platform: 'ios', device: 'AAAA-1111', label: 'iPhone 16 Pro', state: 'Booted', runtime: 'iOS-26-5', nativeWidth: 1206, nativeHeight: 2622 },
  { platform: 'ios', device: 'BBBB-2222', label: 'iPhone SE', state: 'Shutdown', runtime: 'iOS-18-3' },
];

function resetStore(patch = {}) {
  const { store } = factoryResult.__test;
  store.set({ devices: DEVICES, panels: [], loading: false, devicesError: null, booting: '', bootError: null, ...patch });
}

/**
 * One part, byte-for-byte what index.js writes.
 */
function part(jpeg) {
  return Buffer.concat([
    Buffer.from(`--dshdevicemirrorframe\r\ncontent-type: image/jpeg\r\ncontent-length: ${jpeg.length}\r\n\r\n`, 'ascii'),
    jpeg,
    Buffer.from('\r\n', 'ascii'),
  ]);
}

const frameBytes = (seed, size = 1024) => {
  const buffer = Buffer.alloc(size);
  buffer[0] = 0xff;
  buffer[1] = 0xd8;
  buffer[2] = 0xff;
  for (let i = 3; i < size - 2; i += 1) buffer[i] = (seed + i) & 0xff;
  buffer[size - 2] = 0xff;
  buffer[size - 1] = 0xd9;
  return buffer;
};

// ---------------------------------------------------------------------------
// module + wire format
// ---------------------------------------------------------------------------

await check('factory registers the module under the package name', () => {
  assert.ok(factoryResult, '__ModuleLoader__.load was never called');
  assert.deepEqual(factoryResult.inject, ['slots']);
  assert.equal(typeof factoryResult.apply, 'function');
});

await check('multipart reader recovers every frame from the Host byte format', () => {
  const { createMultipartParser } = factoryResult.__test;
  const frames = [];
  const parse = createMultipartParser((bytes) => frames.push(Buffer.from(bytes)));
  const source = [frameBytes(1, 900), frameBytes(2, 1500), frameBytes(3, 700)];
  const body = Buffer.concat(source.map(part));
  for (let i = 0; i < body.length; i += 7) parse(new Uint8Array(body.subarray(i, i + 7)));
  assert.equal(frames.length, 3, `expected 3 frames, got ${frames.length}`);
  for (let i = 0; i < source.length; i += 1) assert.deepEqual(frames[i], source[i], `frame ${i} did not round-trip`);
});

await check('multipart reader keeps an incomplete header buffered', () => {
  const { createMultipartParser } = factoryResult.__test;
  const frames = [];
  const parse = createMultipartParser((bytes) => frames.push(bytes.length));
  const body = part(frameBytes(9, 800));
  parse(new Uint8Array(body.subarray(0, 12)));
  assert.equal(frames.length, 0);
  parse(new Uint8Array(body.subarray(12)));
  assert.deepEqual(frames, [800]);
});

// ---------------------------------------------------------------------------
// apply surface
// ---------------------------------------------------------------------------

await check('apply registers the floating layer and nothing else', () => {
  const slots = [];
  const registered = [];
  const fakeCtx = {
    get: () => undefined,
    effect: (fn) => {
      const disposer = fn();
      return typeof disposer === 'function' ? disposer : () => {};
    },
    inject: () => {
      throw new Error('apply must not inject any service: the overlay needs none');
    },
    slots: {
      inject: (slot, fn) => {
        slots.push(slot);
        fn();
      },
      register: (options, component) => {
        registered.push({ name: options.name, id: options.id });
        assert.equal(typeof component, 'function', 'overlay needs a React component');
        assert.equal(typeof options.label, 'function', 'label should be a thunk so it follows the locale');
        return () => {};
      },
    },
  };

  factoryResult.apply(fakeCtx);
  assert.deepEqual(slots, ['shell.overlay'], 'the only slot touched must be the frame-wide overlay');
  assert.equal(registered.length, 1, `expected exactly one registration, got ${registered.length}`);
  assert.equal(registered[0].id, 'device-mirror-float');
});

await check('apply works on a ctx with no betterSidebar service at all', () => {
  const registered = [];
  const fakeCtx = {
    get: (name) => {
      assert.notEqual(name, 'betterSidebar', 'the float must not look up a sidebar service');
      return undefined;
    },
    effect: (fn) => {
      const disposer = fn();
      return typeof disposer === 'function' ? disposer : () => {};
    },
    inject: () => {
      throw new Error('no service injection expected');
    },
    slots: {
      inject: (slot, fn) => fn(),
      register: (options) => {
        registered.push(options.id);
        return () => {};
      },
    },
  };
  assert.doesNotThrow(() => factoryResult.apply(fakeCtx));
  assert.deepEqual(registered, ['device-mirror-float']);
});

// ---------------------------------------------------------------------------
// multi-window model
// ---------------------------------------------------------------------------

await check('each "add" gets its own device, and never repeats one while a fresh one exists', () => {
  const { actions, store } = factoryResult.__test;
  resetStore();
  storage.clear();

  const first = actions.addPanel();
  const second = actions.addPanel();

  assert.equal(store.get().panels.length, 2, 'two adds must produce two windows');
  assert.notEqual(
    `${first.platform}:${first.device}`,
    `${second.platform}:${second.device}`,
    'the second window must not reuse the first window device while an unused one exists',
  );
  assert.equal(first.device, 'emulator-5554', 'the already-running Android device is the first pick');
  assert.equal(second.device, 'AAAA-1111', 'the next fresh device is the booted simulator');

  // A third add has nothing fresh left and must still produce a window.
  const third = actions.addPanel();
  assert.equal(store.get().panels.length, 3);
  assert.ok(third.device, 'a third window must bind to something rather than stay empty');
});

await check('windows cascade so a new one does not land exactly on top of the last', () => {
  const { actions, store } = factoryResult.__test;
  resetStore();
  const a = actions.addPanel();
  const b = actions.addPanel();
  assert.ok(b.y > a.y, 'a new window should step down');
  assert.ok(b.x <= a.x, 'and step left');
  assert.equal(store.get().panels.length, 2);
});

await check('move and re-bind touch only their own window', () => {
  const { actions, store } = factoryResult.__test;
  resetStore();
  const a = actions.addPanel();
  const b = actions.addPanel();

  actions.movePanel(a.id, 400, 300);
  let panels = store.get().panels;
  assert.deepEqual(
    { x: panels.find((p) => p.id === a.id).x, y: panels.find((p) => p.id === a.id).y },
    { x: 400, y: 300 },
  );
  assert.deepEqual(
    { x: panels.find((p) => p.id === b.id).x, y: panels.find((p) => p.id === b.id).y },
    { x: b.x, y: b.y },
    'moving one window must not move the other',
  );

  actions.setPanelDevice(b.id, 'ios', 'BBBB-2222');
  panels = store.get().panels;
  assert.equal(panels.find((p) => p.id === b.id).device, 'BBBB-2222');
  assert.equal(panels.find((p) => p.id === a.id).device, a.device, 're-binding must not touch the neighbour');
});

await check('closing one window leaves the rest alone', () => {
  const { actions, store } = factoryResult.__test;
  resetStore();
  const a = actions.addPanel();
  const b = actions.addPanel();
  actions.removePanel(a.id);
  const panels = store.get().panels;
  assert.equal(panels.length, 1);
  assert.equal(panels[0].id, b.id, 'the surviving window is the one that was not closed');
});

await check('the window set round-trips through storage', () => {
  const { actions, store } = factoryResult.__test;
  resetStore();
  storage.clear();
  const a = actions.addPanel();
  const b = actions.addPanel();
  actions.movePanel(a.id, 111, 222);
  actions.setPanelDevice(b.id, 'ios', 'BBBB-2222');

  // Persistence is always keyed by a conversation now; there is no global slot.
  actions.persistPanels('S-round', store.get().panels);
  const restored = actions.readPanels('S-round');
  assert.ok(Array.isArray(restored), 'saved panels must be readable back');
  assert.equal(restored.length, 2);
  const ra = restored.find((p) => p.id === a.id);
  assert.deepEqual({ x: ra.x, y: ra.y }, { x: 111, y: 222 });
  assert.equal(restored.find((p) => p.id === b.id).device, 'BBBB-2222');
});

await check('"never saved" and "user closed them all" are distinguishable', () => {
  const { actions } = factoryResult.__test;
  storage.clear();
  assert.equal(actions.readPanels('S-fresh'), null, 'a missing key means first run');

  storage.set('dsh-device-mirror:panels:S-fresh', '[]');
  const empty = actions.readPanels('S-fresh');
  assert.deepEqual(empty, [], 'an empty array must stay empty instead of re-creating a window');
});

await check('a conversation with no id neither reads nor writes the global slot', () => {
  // The regression: falling back to the bare key when the session id was not
  // known made every such conversation share one window set, so a mirror opened
  // in one chat appeared in another the user never opened it in.
  const { actions, store } = factoryResult.__test;
  resetStore();
  storage.clear();
  storage.set('dsh-device-mirror:panels', JSON.stringify([
    { id: 'leaked', platform: 'ios', device: 'X', x: 10, y: 10, minimized: false },
  ]));

  assert.deepEqual(actions.readPanels(null), [], 'no id must not read the global slot');
  actions.persistPanels(null, [{ id: 'mine', platform: 'ios', device: 'Y', x: 0, y: 0 }]);
  assert.equal(
    JSON.parse(storage.get('dsh-device-mirror:panels'))[0].id,
    'leaked',
    'no id must not overwrite the global slot either',
  );
});

await check('corrupt stored panels fall back to first-run instead of throwing', () => {
  const { actions } = factoryResult.__test;
  storage.set('dsh-device-mirror:panels:S-bad', '{not json');
  assert.equal(actions.readPanels('S-bad'), null);
});

// ---------------------------------------------------------------------------
// per-session scoping
// ---------------------------------------------------------------------------

await check('windows are namespaced per session and never leak across', () => {
  const { actions, store } = factoryResult.__test;
  storage.clear();
  resetStore();

  // Session A: one window, then move it.
  assert.equal(actions.activateSession('session-A'), null, 'first visit to A has nothing saved');
  const a = actions.addPanel();
  actions.movePanel(a.id, 42, 43);
  assert.deepEqual(
    (({ x, y }) => ({ x, y }))(actions.readPanels('session-A').find((p) => p.id === a.id)),
    { x: 42, y: 43 },
  );

  // Session B: must start empty, not inherit A's window.
  assert.equal(actions.activateSession('session-B'), null, 'first visit to B has nothing saved');
  assert.deepEqual(store.get().panels, [], 'switching sessions must clear the visible windows');
  const b = actions.addPanel();
  assert.equal(actions.readPanels('session-B').length, 1);

  // Neither key sees the other session's window.
  assert.deepEqual(actions.readPanels('session-A').map((p) => p.id), [a.id]);
  assert.deepEqual(actions.readPanels('session-B').map((p) => p.id), [b.id]);
  assert.notEqual(a.id, b.id);

  // Switching back restores A exactly, geometry included.
  actions.activateSession('session-A');
  assert.deepEqual(store.get().panels.map((p) => p.id), [a.id]);
  assert.deepEqual(
    (({ x, y }) => ({ x, y }))(store.get().panels[0]),
    { x: 42, y: 43 },
    'geometry must survive the round trip',
  );
  // And B is untouched by that.
  assert.equal(actions.readPanels('session-B').find((p) => p.id === b.id).x, b.x);
  actions.activateSession(null);
});

await check('closing every window in a session stays closed for that session only', () => {
  const { actions, store } = factoryResult.__test;
  storage.clear();
  resetStore();

  actions.activateSession('s1');
  const first = actions.addPanel();
  actions.removePanel(first.id);
  assert.deepEqual(actions.readPanels('s1'), [], 'an emptied session must be saved as []');

  actions.activateSession('s2');
  assert.equal(actions.readPanels('s2'), null, 'the other session is still a first visit');
  actions.addPanel();
  assert.equal(store.get().panels.length, 1);
  actions.activateSession(null);
});

await check('a session with no id keeps its windows in memory but does not persist them', () => {
  // Previously this fell back to an unscoped key, which is what leaked a window
  // from one conversation into another. Windows still work for the session that
  // is open; they just do not outlive it when the id is unknown.
  const { actions, helpers } = factoryResult.__test;
  storage.clear();
  resetStore();
  actions.activateSession(null);
  const panel = actions.addPanel();
  assert.equal(helpers.panelsKey(null), null, 'there is no unscoped key any more');
  assert.deepEqual(actions.readPanels(null), [], 'nothing is read back');
  assert.equal(actions.readPanels('some-session'), null, 'and the scoped keys stay untouched');
  assert.equal(panel.id.length > 0, true, 'the window itself still exists in the session');
});

await check('the active session is read from either snapshot shape', () => {
  const { helpers } = factoryResult.__test;
  assert.equal(helpers.readSessionId({ current: 's1' }), 's1');
  assert.equal(helpers.readSessionId({ current: { id: 's2' } }), 's2');
  assert.equal(
    helpers.readSessionId({ byId: { a: { id: 'a', retainedBy: { mainView: 0 } }, b: { id: 'b', retainedBy: { mainView: 2 } } } }),
    'b',
    'a session retaining the main view is the active one',
  );
  assert.equal(helpers.readSessionId(null), null);
  assert.equal(helpers.readSessionId({}), null);
  assert.equal(helpers.readSessionId({ byId: {} }), null);
});

await check('the storage key is namespaced, and absent when unscoped', () => {
  const { helpers } = factoryResult.__test;
  assert.equal(helpers.panelsKey('abc'), 'dsh-device-mirror:panels:abc');
  assert.equal(helpers.panelsKey(null), null);
  assert.equal(helpers.panelsKey(''), null);
});

// ---------------------------------------------------------------------------
// Android AVD paths
// ---------------------------------------------------------------------------

/** Swaps in a fetch that records every call and answers with canned bodies. */
function withFetch(routes, run) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url);
    calls.push({ url: target, method: init.method ?? 'GET', body: init.body });
    const match = routes.find((route) => target.includes(route.match));
    const body = match ? match.body : { ok: true };
    return { ok: true, status: 200, json: async () => body };
  };
  return Promise.resolve()
    .then(run)
    .finally(() => { globalThis.fetch = original; })
    .then((value) => ({ value, calls }));
}

const AVD_ROW = {
  platform: 'android', device: 'wallet_face_capture_lab', label: 'wallet_face_capture_lab',
  state: 'Stopped', kind: 'avd', nativeWidth: null, nativeHeight: null,
};
const RUNNING_ROW = {
  platform: 'android', device: 'emulator-5554', label: 'Pixel 7', state: 'device',
  kind: 'adb', nativeWidth: 1080, nativeHeight: 2400,
};
// Declared here rather than reusing the later PANEL constant: this block runs
// before that `const` is initialised, and the TDZ error is not obvious.
const AVD_PANEL = { id: 'p-avd', platform: 'android', device: 'emulator-5554', x: 100, y: 100, minimized: false };

await check('booting a stopped AVD asks the Host by name and binds the returned serial', async () => {
  const { actions, store } = factoryResult.__test;
  resetStore();
  storage.clear();
  actions.activateSession('s-avd');
  store.set({ devices: [RUNNING_ROW, AVD_ROW] });

  const { value: serial, calls } = await withFetch([
    { match: '/android/boot', body: { ok: true, device: 'emulator-5599', bootedInMs: 42000 } },
    { match: '/devices', body: { ok: true, android: { available: true, devices: [RUNNING_ROW, { ...RUNNING_ROW, device: 'emulator-5599', label: 'Pixel AVD' }] }, ios: { available: true, devices: [] } } },
  ], () => actions.bootAvd('wallet_face_capture_lab'));

  assert.equal(serial, 'emulator-5599', 'the serial is what a window can bind to, not the AVD name');
  const bootCall = calls.find((call) => call.url.includes('/android/boot'));
  assert.ok(bootCall, 'the boot route must be called');
  assert.equal(bootCall.method, 'POST');
  assert.deepEqual(JSON.parse(bootCall.body), { name: 'wallet_face_capture_lab' });
  assert.equal(store.get().booting, '', 'the busy flag must be cleared');
  actions.activateSession(null);
});

await check('a failed AVD boot surfaces the Host error instead of hanging', async () => {
  const { actions, store } = factoryResult.__test;
  resetStore();
  actions.activateSession('s-avd-err');
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 409,
    json: async () => ({ ok: false, error: 'avd did not finish booting within 180s' }),
  });
  try {
    const serial = await actions.bootAvd('slow_avd');
    assert.equal(serial, null);
    assert.match(store.get().bootError ?? '', /did not finish booting/);
  } finally {
    globalThis.fetch = original;
  }
  actions.activateSession(null);
});

await check('a stopped AVD is offered a start action in the manager', () => {
  const { components } = factoryResult.__test;
  const tree = withStore({ devices: [RUNNING_ROW, AVD_ROW], panels: [AVD_PANEL] }, () =>
    render(components.DeviceManager, {}, { panel: AVD_PANEL }));

  const texts = [];
  const walk = (node) => {
    if (node === null || node === undefined || typeof node === 'boolean') return;
    if (typeof node === 'string' || typeof node === 'number') { texts.push(String(node)); return; }
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node.props) walk(node.props.children);
  };
  walk(tree);
  assert.ok(texts.some((text) => text.includes('wallet_face_capture_lab')), 'the stopped AVD must be listed');
  assert.ok(
    texts.some((text) => text === '启动' || text === 'Boot'),
    'a stopped AVD must carry a start action, not just a dimmed row',
  );
});

// ---------------------------------------------------------------------------
// rendering invariants
// ---------------------------------------------------------------------------

const findControl = (node) => {
  if (!node || typeof node !== 'object') return null;
  if (node.type === 'button' || node.type === 'input') return node.type;
  if (node.type === 'img') return null;
  for (const child of node.props?.children ?? []) {
    const hit = findControl(child);
    if (hit) return hit;
  }
  return null;
};

const screenBoxOf = (panelTree) => panelTree.props.children.filter(Boolean)
  .find((child) => child.props?.style?.aspectRatio);

const PANEL = { id: 'p1', platform: 'android', device: 'emulator-5554', x: 100, y: 100 };

await check('every component renders without throwing', () => {
  const { components } = factoryResult.__test;
  resetStore();
  const rendered = [
    render(components.DevicePanel, {}, { panel: PANEL }),
    render(components.DeviceManager, {}, { panel: PANEL }),
    render(components.FloatingLayer, {}),
  ];
  for (const tree of rendered) {
    assert.ok(tree && tree.type, 'a component rendered nothing');
    assert.doesNotThrow(() => shallowRender(tree), 'render must not throw');
  }
});

await check('a live frame leaves the device box free of controls', () => {
  const { components } = factoryResult.__test;
  // 1 = frameUrl, 6 = status (index 0 belongs to useStore).
  const tree = withStore({ devices: DEVICES, panels: [PANEL] }, () =>
    render(components.DevicePanel, { DevicePanel: { 1: 'blob:frame', 6: 'live' } }, { panel: PANEL }));
  const screen = screenBoxOf(tree);
  assert.ok(screen, 'screen box missing');
  assert.equal(findControl(screen), null, 'with a frame on screen, nothing interactive may sit inside the device box');
});

await check('a window with no frame explains itself and offers the next step', () => {
  const { components } = factoryResult.__test;
  const tree = withStore({ devices: DEVICES, panels: [PANEL] }, () =>
    render(components.DevicePanel, {}, { panel: PANEL }));
  const screen = screenBoxOf(tree);
  const placeholder = screen.props.children.filter(Boolean)
    .find((child) => child.type === 'div' && child.props.style?.inset === 0);
  assert.ok(placeholder, 'status placeholder missing');
  assert.ok(findControl(placeholder), 'placeholder must offer an action (pick / boot / retry)');
});

await check('the title bar is always visible, outside the screen, and is the drag handle', () => {
  const { components } = factoryResult.__test;
  const tree = withStore({ devices: DEVICES, panels: [PANEL] }, () =>
    render(components.DevicePanel, {}, { panel: PANEL }));
  const children = tree.props.children.flat(Infinity).filter(Boolean);
  const bar = children.find((child) => child.props?.onPointerDown && child.props?.onPointerUp && child.props?.onPointerMove);
  assert.ok(bar, 'title bar missing');
  assert.equal(bar.props.style.cursor, 'grab', 'the whole bar must read as a drag handle');
  // The fix for "the drag target is too small": no hover gating on the handle.
  assert.equal(bar.props.style.opacity, undefined, 'the title bar must not fade out at rest');
  const screen = screenBoxOf(tree);
  assert.ok(!(screen.props.children ?? []).includes(bar), 'the title bar must be a sibling of the screen, not over it');
});

const fakePointer = (x, y) => ({
  clientX: x, clientY: y, pointerId: 1,
  target: { closest: () => null },
  currentTarget: { setPointerCapture: () => {} },
  stopPropagation: () => {},
});

await check('dragging the title bar moves the window; a plain click opens the manager', async () => {
  const { components, actions, store } = factoryResult.__test;
  storage.clear();
  resetStore();
  actions.activateSession('s-drag');
  const panel = actions.addPanel();
  actions.movePanel(panel.id, 100, 100);

  const renderPanel = () => withStore({ devices: DEVICES, panels: [store.get().panels[0]] }, () =>
    render(components.DevicePanel, {}, { panel: store.get().panels[0] }));
  const barOf = (tree) => tree.props.children.flat(Infinity)
    .find((child) => child.props?.onPointerDown && child.props?.onPointerUp && child.props?.onPointerMove);

  // A real drag: down, move 60/50, up. The commit happens on release.
  let bar = barOf(renderPanel());
  setHookOverrides({});
  currentComponent = 'DevicePanel';
  hookIndex = 0;
  bar.props.onPointerDown(fakePointer(100, 100));
  bar.props.onPointerMove(fakePointer(160, 150));
  bar.props.onPointerUp(fakePointer(160, 150));
  const moved = store.get().panels[0];
  assert.deepEqual(
    { x: moved.x, y: moved.y },
    { x: 160, y: 150 },
    'releasing after a drag must commit the new position',
  );

  // A click with no movement must not move the window, and must open the manager.
  bar = barOf(renderPanel());
  setHookOverrides({});
  currentComponent = 'DevicePanel';
  hookIndex = 0;
  bar.props.onPointerDown(fakePointer(200, 200));
  bar.props.onPointerUp(fakePointer(200, 200));
  assert.equal(store.get().panels[0].x, 160, 'a click must not move the window');
  assert.ok(
    hookCalls.some((call) => call.index === 11 && call.value === true),
    'a click without movement must open the device manager',
  );
  actions.activateSession(null);
});

await check('back / home / recents are always visible, not behind the keyboard toggle', () => {
  const { components } = factoryResult.__test;
  const PANEL_ANDROID = { id: 'p-nav', platform: 'android', device: 'emulator-5554', x: 100, y: 100 };
  const tree = withStore({ devices: DEVICES, panels: [PANEL_ANDROID] }, () =>
    render(components.DevicePanel, { DevicePanel: { 1: 'blob:f', 6: 'live' } }, { panel: PANEL_ANDROID }));

  const texts = [];
  const buttons = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(walk);
    if (node.type === 'button') buttons.push(node);
    for (const child of node.props?.children ?? []) {
      if (typeof child === 'string' || typeof child === 'number') texts.push(String(child));
      else walk(child);
    }
  };
  walk(tree);

  // The nav row must render without textMode being on: three buttons whose
  // tooltips are the navigation labels.
  const titles = buttons.map((button) => button.props?.title).filter(Boolean);
  // The locale defaults to zh in this harness, so match the zh labels; the en
  // pair is covered by the same code path.
  for (const label of ['返回', '主屏']) {
    assert.ok(titles.includes(label), `expected a "${label}" control, got ${JSON.stringify(titles)}`);
  }
  assert.ok(titles.some((title) => /最近任务|Recents/.test(title)), 'recents control missing');
  // The keyboard row is NOT rendered (textMode off), so these are the always-on ones.
  assert.ok(!texts.includes('发给设备…'), 'the text row must stay collapsed');
});

await check('recents is disabled on iOS because the simulator has no API for it', () => {
  const { components } = factoryResult.__test;
  const panel = { id: 'p-ios', platform: 'ios', device: 'AAAA', x: 100, y: 100 };
  const tree = withStore({ devices: DEVICES, panels: [panel] }, () =>
    render(components.DevicePanel, { DevicePanel: { 1: 'blob:f', 6: 'live' } }, { panel }));

  const buttons = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(walk);
    if (node.type === 'button') buttons.push(node);
    for (const child of node.props?.children ?? []) walk(child);
  };
  walk(tree);
  const recents = buttons.find((button) => /最近任务|Recents/.test(button.props?.title ?? ''));
  assert.ok(recents, 'recents control missing on iOS');
  assert.equal(recents.props.disabled, true, 'recents must be disabled on iOS, not silently dead');
  const back = buttons.find((button) => button.props?.title === '返回');
  assert.equal(back.props.disabled, undefined, 'back must stay enabled on iOS');
});

await check('a broken stream is announced even though a stale frame still shows', () => {
  const { components } = factoryResult.__test;
  const panel = { id: 'p-err', platform: 'android', device: 'emulator-5554', x: 100, y: 100 };
  // 1 = frameUrl, 6 = status, 7 = streamError. A frame is present, which is the
  // case that used to look perfectly healthy while nothing was updating.
  const tree = withStore({ devices: DEVICES, panels: [panel] }, () => render(
    components.DevicePanel,
    { DevicePanel: { 1: 'blob:stale', 6: 'error', 7: 'device went away' } },
    { panel },
  ));

  const texts = [];
  const walk = (node) => {
    if (node === null || node === undefined || typeof node === 'boolean') return;
    if (typeof node === 'string' || typeof node === 'number') { texts.push(String(node)); return; }
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node.props) walk(node.props.children);
  };
  walk(tree);
  const joined = texts.join(' ');
  assert.match(joined, /连接中断|Disconnected/, 'a frozen picture must be labelled as disconnected');
  assert.match(joined, /device went away/, 'the reason must be shown');
  assert.ok(texts.some((text) => text === '重试' || text === 'Retry'), 'a retry action must be offered');
});

await check('a press, a drag and a release each draw local feedback immediately', () => {
  const { components } = factoryResult.__test;
  const tree = withStore({
    devices: DEVICES,
    panels: [{ id: 'p-touch', platform: 'android', device: 'emulator-5554', x: 100, y: 100 }],
  }, () => render(components.DevicePanel, { DevicePanel: { 1: 'blob:frame', 6: 'live' } }, {
    panel: { id: 'p-touch', platform: 'android', device: 'emulator-5554', x: 100, y: 100 },
  }));

  // The image is nested two levels down (shell > screen box > img), so walk.
  const findNode = (node, predicate) => {
    if (!node || typeof node !== 'object') return null;
    if (predicate(node)) return node;
    for (const child of node.props?.children ?? []) {
      const hit = findNode(child, predicate);
      if (hit) return hit;
    }
    return null;
  };
  const img = findNode(tree, (node) => node.type === 'img');
  assert.ok(img, 'screen image missing');
  assert.equal(typeof img.props.onPointerMove, 'function', 'the screen must track movement for the drag trail');

  // The device answers only after a round trip, so the echo is the whole point:
  // it must appear on press, follow the pointer, and linger on release.
  const at = (x, y) => ({
    clientX: x, clientY: y, pointerId: 1,
    currentTarget: {
      setPointerCapture: () => {},
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 200 }),
    },
  });
  const echoes = () => hookCalls.filter((call) => call.index === 12 && call.value).map((call) => call.value.kind);

  setHookOverrides({});
  currentComponent = 'DevicePanel';
  hookIndex = 0;
  img.props.onPointerDown(at(10, 10));
  assert.ok(echoes().includes('press'), 'a press must draw a marker immediately');

  hookCalls = [];
  img.props.onPointerMove(at(60, 60));
  assert.ok(echoes().includes('swipe'), 'dragging must switch the echo to a trail');

  hookCalls = [];
  img.props.onPointerUp(at(60, 60));
  assert.ok(echoes().includes('release'), 'release must leave a fading marker');
});

await check('a window can be hidden to a pill and restored', () => {
  const { actions, store, components } = factoryResult.__test;
  storage.clear();
  resetStore();
  actions.activateSession('s-hide');
  const panel = actions.addPanel();

  actions.setPanelMinimized(panel.id, true);
  assert.equal(store.get().panels[0].minimized, true);
  assert.equal(
    actions.readPanels('s-hide').find((row) => row.id === panel.id).minimized,
    true,
    'the hidden state must survive a reload',
  );
  const pill = withStore({ devices: DEVICES, panels: store.get().panels }, () =>
    render(components.DevicePanel, {}, { panel: store.get().panels[0] }));
  assert.equal(pill.type, 'button', 'a hidden window renders as a pill, not as a screen');

  actions.setPanelMinimized(panel.id, false);
  assert.equal(store.get().panels[0].minimized, false);
  actions.activateSession(null);
});

await check('the add control exists even with zero windows', () => {
  const { components } = factoryResult.__test;
  const tree = withStore({ devices: DEVICES, panels: [] }, () => render(components.FloatingLayer, {}));
  const nodes = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    nodes.push(node);
    for (const child of node.props?.children ?? []) walk(child);
  };
  walk(tree);
  const interactions = nodes.filter((node) => node.type === 'button' && typeof node.props?.onClick === 'function');
  assert.equal(interactions.length, 1, 'exactly one "add window" button must render when no window is open');
});

await check('each open window renders its own screen', () => {
  const { components } = factoryResult.__test;
  const panels = [PANEL, { ...PANEL, id: 'p2', device: 'AAAA-1111', platform: 'ios', y: 140 }];
  const tree = withStore({ devices: DEVICES, panels }, () => render(components.FloatingLayer, {}));
  const windows = tree.props.children.flat(Infinity).filter((child) => child && child.type?.name === 'DevicePanel');
  assert.equal(windows.length, 2, `expected two windows, got ${windows.length}`);
  assert.deepEqual(windows.map((child) => child.props.panel.id), ['p1', 'p2']);
});

console.log(`\n${passed} checks passed${process.exitCode ? ' (with failures)' : ''}`);

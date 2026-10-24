/**
 * Model-facing tools.
 *
 * Kept out of the Host entry file, and given its dependencies as an argument
 * rather than importing them, so there is no import cycle and no temporal-dead
 * -zone hazard: this module knows nothing about the HTTP routes or the capture
 * pipeline.
 *
 * @module @local/dsh-device-mirror/host/tools
 */
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Build the tool definitions against the Host's own helpers.
 *
 * @param {object} deps - everything the tools reach into.
 * @returns {Array<object>} tool definitions ready for `ctx.tools.register`.
 */
export function createToolDefinitions(deps) {
  const {
    run, runBuffer, note, spawn,
    listAndroid, listIos, listAvds, runningAvds,
    waitForAvdBoot, waitForSimulatorBoot,
    injectAndroid, injectIos,
    inputGeometry, invalidateGeometry, simctlFirstError,
    EMULATOR_BIN, createAndroidAvd,
  } = deps;

// ---------------------------------------------------------------------------
// Agent-facing tools
// ---------------------------------------------------------------------------
//
// Until now this plugin was UI-only: an agent driving a device had to reach for
// raw `adb`/`simctl` and had no idea which device the user was looking at. These
// tools make "prefer the mirror's way" physically possible, and they carry the
// one capability the simulator-helper plugins have that this one lacked:
// accessibility-driven location, so a tap can be expressed as "the Search row"
// instead of a guessed pixel.
//
/** Normalised (0..1) rect for an element, so callers never guess a space. */
function normalisedRect(frame, inputWidth, inputHeight) {
  const x = Number(frame?.x ?? 0);
  const y = Number(frame?.y ?? 0);
  const width = Number(frame?.width ?? 0);
  const height = Number(frame?.height ?? 0);
  const cx = x + width / 2;
  const cy = y + height / 2;
  return {
    x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height),
    centerX: Math.round(cx), centerY: Math.round(cy),
    nx: inputWidth ? Number((cx / inputWidth).toFixed(4)) : null,
    ny: inputHeight ? Number((cy / inputHeight).toFixed(4)) : null,
  };
}

/** Parse `uiautomator dump` XML into flat records with pixel bounds. */
function parseAndroidNodes(xml) {
  const nodes = [];
  const pattern = /<node\b([^>]*)\/?>/g;
  let match;
  while ((match = pattern.exec(xml))) {
    const attrs = match[1];
    const read = (name) => {
      const found = new RegExp(`${name}="([^"]*)"`).exec(attrs);
      return found ? found[1] : '';
    };
    const bounds = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(read('bounds'));
    if (!bounds) continue;
    const [, x1, y1, x2, y2] = bounds.map(Number);
    nodes.push({
      text: read('text'),
      label: read('content-desc'),
      className: read('class'),
      clickable: read('clickable') === 'true',
      frame: { x: x1, y: y1, width: x2 - x1, height: y2 - y1 },
    });
  }
  return nodes;
}

async function findElements(platform, device, query, inputWidth, inputHeight) {
  const needle = String(query ?? '').toLowerCase();
  if (!needle) return { ok: false, error: 'missing query' };

  if (platform === 'android') {
    const dump = await run('adb', ['-s', device, 'shell', 'uiautomator', 'dump', '/sdcard/dsh-mirror-ui.xml'], 12_000);
    if (!dump.ok) return { ok: false, error: (dump.stderr || 'uiautomator dump failed').trim().split('\n')[0] };
    const read = await run('adb', ['-s', device, 'shell', 'cat', '/sdcard/dsh-mirror-ui.xml'], 12_000);
    run('adb', ['-s', device, 'shell', 'rm', '-f', '/sdcard/dsh-mirror-ui.xml'], 5000).catch(() => {});
    if (!read.ok) return { ok: false, error: (read.stderr || 'could not read the dump').trim().split('\n')[0] };
    const nodes = parseAndroidNodes(read.stdout)
      .filter((node) => `${node.text} ${node.label}`.toLowerCase().includes(needle))
      .slice(0, 12)
      .map((node) => ({ text: node.text, label: node.label, className: node.className, clickable: node.clickable, ...normalisedRect(node.frame, inputWidth, inputHeight) }));
    return { ok: true, platform, device, query, count: nodes.length, matches: nodes };
  }

  if (platform === 'ios') {
    const described = await run('idb', ['ui', 'describe-all', '--udid', device], 12_000);
    if (!described.ok) return { ok: false, error: (described.stderr || 'describe-all failed').trim().split('\n')[0] };
    let rows;
    try {
      rows = JSON.parse(described.stdout);
    } catch {
      return { ok: false, error: 'describe-all returned unparsable JSON' };
    }
    const nodes = (Array.isArray(rows) ? rows : [])
      .filter((row) => String(row?.AXLabel ?? '').toLowerCase().includes(needle))
      .slice(0, 12)
      .map((row) => ({
        text: String(row.AXLabel ?? ''),
        label: String(row.AXIdentifier ?? ''),
        className: String(row.type ?? ''),
        clickable: row.type === 'Button' || row.type === 'Cell',
        ...normalisedRect(row.frame, inputWidth, inputHeight),
      }));
    return { ok: true, platform, device, query, count: nodes.length, matches: nodes };
  }

  return { ok: false, error: `unknown platform ${platform}` };
}

/** One PNG of the device's current screen, written where the agent can read it. */
async function snapshotPng(platform, device) {
  const file = path.join(os.tmpdir(), `dsh-mirror-${device.replace(/[^a-zA-Z0-9]/g, '')}-${Date.now()}.png`);
  if (platform === 'android') {
    const bytes = await runBuffer('adb', ['-s', device, 'exec-out', 'screencap', '-p'], 20_000);
    if (!bytes) return { ok: false, error: 'screencap produced no bytes' };
    await fsp.writeFile(file, bytes);
    return { ok: true, path: file, bytes: bytes.length };
  }
  if (platform === 'ios') {
    const shot = await run('xcrun', ['simctl', 'io', device, 'screenshot', '--type=jpeg', file], 12_000);
    if (!shot.ok) return { ok: false, error: (shot.stderr || 'screenshot failed').trim().split('\n').split('\n')[0] };
    const bytes = await fsp.readFile(file).catch(() => null);
    return { ok: true, path: file, bytes: bytes ? bytes.length : 0 };
  }
  return { ok: false, error: `unknown platform ${platform}` };
}

// ---------------------------------------------------------------------------
// Ported device operations (app lifecycle, logs, accessibility dump, AVD控制)
// ---------------------------------------------------------------------------
//
// Everything here was reconstructed from the installed `@zhz8888/dsh-*` helper
// plugins' own command lines, so the two plugins drive the devices the same way.
// Build (xcodebuild/gradle), project scaffolding and app install-by-scaffold
// stay with those plugins: they are the development loop, not device control.

const IOS_BUTTONS = ['APPLE_PAY', 'HOME', 'LOCK', 'SIDE_BUTTON', 'SIRI'];

/** Recent device logs, already truncated to whatever the model can use. */
async function readLogs(platform, device, { seconds = 60, lines = 200, filter = '' } = {}) {
  const clampedSeconds = Math.min(3600, Math.max(1, Math.round(Number(seconds) || 60)));
  const clampedLines = Math.min(2000, Math.max(1, Math.round(Number(lines) || 200)));

  if (platform === 'ios') {
    const result = await run(
      'xcrun',
      ['simctl', 'spawn', device, 'log', 'show', '--style', 'compact', '--last', `${clampedSeconds}s`],
      60_000,
    );
    if (!result.ok) return { ok: false, error: simctlFirstError(result, 'log show failed') };
    const rows = result.stdout.split('\n');
    const filtered = filter ? rows.filter((row) => row.toLowerCase().includes(String(filter).toLowerCase())) : rows;
    return {
      ok: true, platform, device, seconds: clampedSeconds,
      matched: filtered.length,
      text: filtered.slice(-clampedLines).join('\n'),
    };
  }

  if (platform === 'android') {
    const args = ['-s', device, 'logcat', '-d', '-v', 'time', '-t', String(clampedLines)];
    if (filter) args.push('-s', String(filter));
    const result = await run('adb', args, 30_000);
    if (!result.ok) return { ok: false, error: (result.stderr || 'logcat failed').trim().split('\n')[0] };
    return { ok: true, platform, device, lines: clampedLines, text: result.stdout };
  }

  return { ok: false, error: `unknown platform ${platform}` };
}

/** Install / launch / terminate / open a URL, per platform. */
async function deviceAppAction(platform, device, action, target, args = []) {
  const value = String(target ?? '').trim();
  if (!value) return { ok: false, error: 'missing target' };

  if (platform === 'ios') {
    if (action === 'install') {
      const result = await run('xcrun', ['simctl', 'install', device, value], 120_000);
      return result.ok ? { ok: true, action, target: value } : { ok: false, error: simctlFirstError(result, 'install failed') };
    }
    if (action === 'launch') {
      const result = await run('xcrun', ['simctl', 'launch', device, value, ...args.map(String)], 60_000);
      return result.ok ? { ok: true, action, target: value, output: result.stdout.trim() } : { ok: false, error: simctlFirstError(result, 'launch failed') };
    }
    if (action === 'terminate') {
      const result = await run('xcrun', ['simctl', 'terminate', device, value], 30_000);
      return result.ok ? { ok: true, action, target: value } : { ok: false, error: simctlFirstError(result, 'terminate failed') };
    }
    if (action === 'open_url') {
      const result = await run('xcrun', ['simctl', 'openurl', device, value], 30_000);
      return result.ok ? { ok: true, action, target: value } : { ok: false, error: simctlFirstError(result, 'openurl failed') };
    }
    return { ok: false, error: `unknown action ${action}` };
  }

  if (platform === 'android') {
    const shell = (...argv) => run('adb', ['-s', device, 'shell', ...argv], 60_000);
    if (action === 'install') {
      const result = await run('adb', ['-s', device, 'install', '-r', value], 180_000);
      return result.ok ? { ok: true, action, target: value, output: result.stdout.trim().split('\n').slice(-1)[0] } : { ok: false, error: (result.stderr || 'install failed').trim().split('\n')[0] };
    }
    if (action === 'launch') {
      // `monkey` resolves the launcher activity without the caller naming a
      // component, which is what the helper plugin does too.
      const result = await shell('monkey', '-p', value, '-c', 'android.intent.category.LAUNCHER', '1');
      return result.ok ? { ok: true, action, target: value } : { ok: false, error: (result.stderr || 'launch failed').trim().split('\n')[0] };
    }
    if (action === 'terminate') {
      const result = await shell('am', 'force-stop', value);
      return result.ok ? { ok: true, action, target: value } : { ok: false, error: (result.stderr || 'force-stop failed').trim().split('\n')[0] };
    }
    if (action === 'open_url') {
      const result = await shell('am', 'start', '-a', 'android.intent.action.VIEW', '-d', value);
      return result.ok ? { ok: true, action, target: value } : { ok: false, error: (result.stderr || 'open url failed').trim().split('\n')[0] };
    }
    return { ok: false, error: `unknown action ${action}` };
  }

  return { ok: false, error: `unknown platform ${platform}` };
}

/** Full accessibility tree, as flat records with pixel and normalised centres. */
async function describeUi(platform, device, inputWidth, inputHeight, limit = 80) {
  if (platform === 'android') {
    const dump = await run('adb', ['-s', device, 'shell', 'uiautomator', 'dump', '/sdcard/dsh-mirror-ui.xml'], 15_000);
    if (!dump.ok) return { ok: false, error: (dump.stderr || 'uiautomator dump failed').trim().split('\n')[0] };
    const read = await run('adb', ['-s', device, 'shell', 'cat', '/sdcard/dsh-mirror-ui.xml'], 15_000);
    run('adb', ['-s', device, 'shell', 'rm', '-f', '/sdcard/dsh-mirror-ui.xml'], 5000).catch(() => {});
    if (!read.ok) return { ok: false, error: (read.stderr || 'could not read the dump').trim().split('\n')[0] };
    const nodes = parseAndroidNodes(read.stdout)
      .filter((node) => node.text || node.label)
      .slice(0, limit)
      .map((node) => ({ text: node.text, label: node.label, className: node.className, clickable: node.clickable, ...normalisedRect(node.frame, inputWidth, inputHeight) }));
    return { ok: true, platform, device, count: nodes.length, elements: nodes };
  }

  if (platform === 'ios') {
    const described = await run('idb', ['ui', 'describe-all', '--udid', device], 15_000);
    if (!described.ok) return { ok: false, error: (described.stderr || 'describe-all failed').trim().split('\n')[0] };
    let rows;
    try {
      rows = JSON.parse(described.stdout);
    } catch {
      return { ok: false, error: 'describe-all returned unparsable JSON' };
    }
    const nodes = (Array.isArray(rows) ? rows : [])
      .filter((row) => row?.AXLabel)
      .slice(0, limit)
      .map((row) => ({
        text: String(row.AXLabel ?? ''),
        label: String(row.AXIdentifier ?? ''),
        className: String(row.type ?? ''),
        clickable: row.type === 'Button' || row.type === 'Cell',
        ...normalisedRect(row.frame, inputWidth, inputHeight),
      }));
    return { ok: true, platform, device, count: nodes.length, elements: nodes };
  }

  return { ok: false, error: `unknown platform ${platform}` };
}

/** Stop a running emulator by asking the device itself to exit. */
async function stopEmulator(serial) {
  const result = await run('adb', ['-s', serial, 'emu', 'kill'], 15_000);
  return result.ok ? { ok: true, stopped: serial } : { ok: false, error: (result.stderr || 'emu kill failed').trim().split('\n')[0] };
}

/**
 * The tool surface.
 *
 * Coordinates are normalised (0..1) exactly like the browser client sends them,
 * so an agent never has to know whether the platform speaks points or pixels.
 */
function buildToolDefinitions() {
  const TARGET = {
    platform: { type: 'string', required: true, description: "Either 'ios' or 'android'." },
    device: { type: 'string', required: true, description: 'iOS simulator UDID, or Android adb serial.' },
  };

  // The profile may load this local package outside the Harness module graph.
  // Keep the tool definitions self-contained instead of relying on the
  // host-only `@deepseek-ai/dsh-tools` compiler. The registry receives a real
  // JSON Schema object at registration time, so this remains valid in both the
  // desktop host and the standalone test/runtime loader.
  const parameterSchema = (spec) => {
    const properties = {};
    const required = [];
    for (const [name, declaration] of Object.entries(spec)) {
      const { required: isRequired, ...schema } = declaration;
      properties[name] = schema;
      if (isRequired === true) required.push(name);
    }
    return {
      type: 'object',
      properties,
      ...(required.length > 0 ? { required } : {}),
    };
  };

  const asJson = (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }];
  const output = { schema: { type: 'object' }, render: asJson };

  const inputTool = ({ name, description, parameters, kind }) => ({
    name,
    description,
    parameters: parameterSchema({ ...TARGET, ...parameters }),
    output,
    execute: async (args) => {
      const platform = String(args.platform);
      const device = String(args.device);
      const geometry = await inputGeometry(platform, device);
      if (!geometry.ok) throw new Error(geometry.error || 'device geometry unknown');
      const scale = (value) => Math.round(Math.min(1, Math.max(0, Number(value))) * 1000) / 1000;
      const action = { kind };

      if (kind === 'tap' || kind === 'swipe') {
        if (args.label) {
          const found = await findElements(platform, device, args.label, geometry.inputWidth, geometry.inputHeight);
          if (!found.ok) throw new Error(found.error);
          const hit = found.matches[0];
          if (!hit) throw new Error(`no element matching "${args.label}"`);
          action.x = hit.nx;
          action.y = hit.ny;
          if (kind === 'swipe') throw new Error('label targeting only supports tap');
        } else {
          action.x = scale(args.x);
          action.y = scale(args.y);
        }
        if (kind === 'swipe') {
          action.x2 = scale(args.x2);
          action.y2 = scale(args.y2);
          action.duration = Number(args.durationMs) || 250;
        }
      }
      if (kind === 'text') action.text = String(args.text ?? '').slice(0, 400);
      if (kind === 'key') action.key = String(args.key ?? '').toUpperCase();

      const pixel = {
        x: action.x === undefined ? undefined : Math.round(action.x * geometry.inputWidth),
        y: action.y === undefined ? undefined : Math.round(action.y * geometry.inputHeight),
        x2: action.x2 === undefined ? undefined : Math.round(action.x2 * geometry.inputWidth),
        y2: action.y2 === undefined ? undefined : Math.round(action.y2 * geometry.inputHeight),
      };

      const result = platform === 'android'
        ? await injectAndroid(device, action)
        : await injectIos(device, action);
      if (!result.ok) {
        const detail = (result.stderr || result.stdout || 'input failed').trim().split('\n').slice(-1)[0];
        throw new Error(detail);
      }
      return { ok: true, platform, device, kind, normalised: action, pixel };
    },
  });

  return [
    {
      name: 'device_mirror_devices',
      description: 'List iOS simulators and Android devices/AVDs known to the Device Mirror plugin, with run state and native size. Prefer this over raw adb/simctl when you need to know what exists.',
      parameters: parameterSchema({}),
      output,
      execute: async () => {
        const [android, ios] = await Promise.all([listAndroid(), listIos()]);
        return { ok: true, android, ios };
      },
    },
    {
      name: 'device_mirror_boot',
      description: 'Start a device: boots an iOS simulator (simctl boot) or starts an Android AVD (emulator -avd). Idempotent — a running device returns immediately. The emulator is detached and survives plugin reloads.',
      parameters: parameterSchema({
        platform: TARGET.platform,
        device: TARGET.device,
      }),
      output,
      execute: async (args) => {
        const platform = String(args.platform);
        const device = String(args.device);
        invalidateGeometry(platform, device);
        if (platform === 'ios') {
          const listed = await listIos();
          const row = listed.devices.find((entry) => entry.device === device);
          if (!row) throw new Error(`simulator ${device} is not known`);
          if (row.state === 'Booted') return { ok: true, device, state: 'Booted', bootedInMs: 0 };
          const booted = await run('xcrun', ['simctl', 'boot', device], 60_000);
          if (!booted.ok && !/current state:\s*Booted/i.test(`${booted.stdout}${booted.stderr}`)) {
            throw new Error(simctlFirstError(booted, 'simctl boot failed'));
          }
          const waited = await waitForSimulatorBoot(device);
          if (!waited.booted) throw new Error(`simulator did not reach Booted (state: ${waited.state})`);
          return { ok: true, device, state: 'Booted' };
        }
        if (platform === 'android') {
          const started = await handleAndroidBootInternal(device);
          return started;
        }
        throw new Error(`unknown platform ${platform}`);
      },
    },
    inputTool({
      name: 'device_mirror_tap',
      description: 'Tap a device. Give normalised x/y (0..1 of the screen) or a label to tap the first element whose accessibility text matches. Prefer this over raw adb/idb taps: it uses the same path the on-screen mirror uses.',
      kind: 'tap',
      parameters: {
        x: { type: 'number', description: 'Normalised x in 0..1. Ignored when label is given.' },
        y: { type: 'number', description: 'Normalised y in 0..1. Ignored when label is given.' },
        label: { type: 'string', description: 'Accessibility text to locate first, then tap its centre.' },
      },
    }),
    inputTool({
      name: 'device_mirror_swipe',
      description: 'Swipe between two normalised points (0..1). Use for scrolling and dismissing.',
      kind: 'swipe',
      parameters: {
        x: { type: 'number', required: true, description: 'Start x in 0..1.' },
        y: { type: 'number', required: true, description: 'Start y in 0..1.' },
        x2: { type: 'number', required: true, description: 'End x in 0..1.' },
        y2: { type: 'number', required: true, description: 'End y in 0..1.' },
        durationMs: { type: 'number', description: 'Duration in milliseconds. Defaults to 250.' },
      },
    }),
    inputTool({
      name: 'device_mirror_text',
      description: 'Type text into the focused control.',
      kind: 'text',
      parameters: { text: { type: 'string', required: true, description: 'Text to type (max 400 characters).' } },
    }),
    inputTool({
      name: 'device_mirror_key',
      description: "Press a navigation key: BACK, HOME or APP_SWITCH. On iOS, HOME uses the hardware button and BACK taps the navigation bar's back control; APP_SWITCH is unsupported there and returns unsupported=true.",
      kind: 'key',
      parameters: { key: { type: 'string', required: true, description: 'BACK, HOME or APP_SWITCH.' } },
    }),
    {
      name: 'device_mirror_find',
      description: 'Locate UI elements by accessibility text and return their pixel and normalised centre. Use it instead of guessing coordinates.',
      parameters: parameterSchema({ ...TARGET, query: { type: 'string', required: true, description: 'Case-insensitive text to match.' } }),
      output,
      execute: async (args) => {
        const platform = String(args.platform);
        const device = String(args.device);
        const geometry = await inputGeometry(platform, device);
        if (!geometry.ok) throw new Error(geometry.error || 'device geometry unknown');
        return findElements(platform, device, args.query, geometry.inputWidth, geometry.inputHeight);
      },
    },
    {
      name: 'device_mirror_snapshot',
      description: 'Save one full-resolution screenshot to a temporary file and return its path. Read that path with read_image when you need to actually look at the screen.',
      parameters: parameterSchema({ ...TARGET }),
      output,
      execute: async (args) => snapshotPng(String(args.platform), String(args.device)),
    },
    {
      name: 'device_mirror_describe',
      description: 'Dump the accessibility tree of the current screen: text, label, class, clickable, and each element centre in both pixels and normalised coordinates. Use it before acting when you do not know what is on screen.',
      parameters: parameterSchema({
        ...TARGET,
        limit: { type: 'number', description: 'Maximum elements to return. Defaults to 80.' },
      }),
      output,
      execute: async (args) => {
        const platform = String(args.platform);
        const device = String(args.device);
        const geometry = await inputGeometry(platform, device);
        if (!geometry.ok) throw new Error(geometry.error || 'device geometry unknown');
        return describeUi(platform, device, geometry.inputWidth, geometry.inputHeight, Number(args.limit) || 80);
      },
    },
    {
      name: 'device_mirror_app',
      description:
        'Install, launch, terminate or open a URL on a device. action=install takes an .apk/.app path, launch/terminate take a bundle id (iOS) or package name (Android), open_url takes a URL. Mirrors what the simulator-helper plugins do, on the same device the mirror is showing.',
      parameters: parameterSchema({
        ...TARGET,
        action: { type: 'string', required: true, description: 'install | launch | terminate | open_url' },
        target: { type: 'string', required: true, description: 'Path, bundle/package id, or URL depending on the action.' },
        args: { type: 'array', description: 'Optional launch arguments (iOS only).' },
      }),
      output,
      execute: async (args) => {
        const result = await deviceAppAction(
          String(args.platform), String(args.device),
          String(args.action), args.target, Array.isArray(args.args) ? args.args : [],
        );
        if (!result.ok) throw new Error(result.error || 'action failed');
        return result;
      },
    },
    {
      name: 'device_mirror_logs',
      description: 'Recent device logs. iOS runs `simctl spawn <udid> log show`, Android runs `logcat -d`. Filter with a substring.',
      parameters: parameterSchema({
        ...TARGET,
        seconds: { type: 'number', description: 'iOS: how far back to read, in seconds (max 3600).' },
        lines: { type: 'number', description: 'Android: how many recent lines (max 2000).' },
        filter: { type: 'string', description: 'Case-insensitive substring to keep. On Android it is also used as the logcat tag filter.' },
      }),
      output,
      execute: async (args) => {
        const result = await readLogs(String(args.platform), String(args.device), {
          seconds: args.seconds, lines: args.lines, filter: args.filter,
        });
        if (!result.ok) throw new Error(result.error || 'log read failed');
        return result;
      },
    },
    {
      name: 'device_mirror_avd',
      description:
        'Android AVD lifecycle: list the installed AVDs, start one, stop a running emulator, or create a new AVD. create needs imageId from `device_mirror_devices`-adjacent /android/catalog; deviceId is an optional device profile id. iOS simulators use device_mirror_boot instead.',
      parameters: parameterSchema({
        platform: { type: 'string', description: "Only 'android' is meaningful; defaults to android." },
        action: { type: 'string', required: true, description: 'list | start | stop | create' },
        name: { type: 'string', description: 'AVD name for start/stop, or the desired name for create.' },
        device: { type: 'string', description: 'Serial of the running emulator for stop.' },
        imageId: { type: 'string', description: 'System image id for create, e.g. system-images;android-30;google_apis;arm64-v8a.' },
        deviceId: { type: 'string', description: 'Optional device profile id for create, e.g. pixel_6.' },
      }),
      output,
      execute: async (args) => {
        const action = String(args.action);
        if (action === 'list') {
          const running = await runningAvds();
          return { ok: true, running: [...running.entries()].map(([avd, serial]) => ({ avd, serial })), all: await listAvds() };
        }
        if (action === 'start') {
          return handleAndroidBootInternal(String(args.name ?? ''));
        }
        if (action === 'stop') {
          const serial = String(args.device ?? '');
          if (!serial) throw new Error('missing device serial');
          const result = await stopEmulator(serial);
          if (!result.ok) throw new Error(result.error || 'stop failed');
          return result;
        }
        if (action === 'create') {
          const result = await createAndroidAvd({
            name: args.name, imageId: String(args.imageId ?? ''), deviceId: args.deviceId,
          });
          if (!result.ok) throw new Error(result.error || 'create failed');
          return { ok: true, avd: result.avd };
        }
        throw new Error(`unknown action ${action}`);
      },
    },
  ];
}

/** Boot/start an AVD by name, reusing the same helpers the HTTP route uses. */
async function handleAndroidBootInternal(name) {
  const avds = await listAvds();
  if (!avds.includes(name)) throw new Error(`unknown AVD ${name}`);
  // runningAvds() is a Map of avd name -> serial.
  const running = await runningAvds();
  const existing = running.get(name);
  if (existing) return { ok: true, device: existing, bootedInMs: 0 };
  let child;
  try {
    child = spawn(EMULATOR_BIN, ['-avd', name, '-no-window', '-no-audio', '-no-boot-anim', '-no-snapshot'], {
      detached: true,
      stdio: 'ignore',
    });
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : String(error));
  }
  child.on('error', (error) => note(`android:${name} emulator error: ${error.message}`));
  child.unref();
  note(`booting android avd ${name} (tool)`);
  const waited = await waitForAvdBoot(name);
  if (!waited.booted) {
    throw new Error(`AVD did not finish booting (phase: ${waited.phase ?? 'unknown'})`);
  }
  return { ok: true, device: waited.serial, bootedInMs: waited.bootedInMs };
}
  return buildToolDefinitions();
}

/**
 * Device Mirror — client half.
 *
 * ONE surface: a floating overlay registered into the shell's frame-wide
 * `shell.overlay` slot. It is deliberately not a right-sidebar tab — a device
 * you are driving belongs on top of the workspace, not squeezed into a column
 * that shares width with file trees and diffs.
 *
 * That also removes the plugin's only third-party dependency: nothing here
 * needs dsh-better-sidebar, so the mirror works on a bare profile.
 *
 * Design rule: the device screen IS the interface. All chrome lives in a strip
 * docked above the screen, outside its box, fading in on hover and disappearing
 * otherwise - so the resting state is just a phone, and a tap on the picture can
 * never land on a button. Nothing is written to document.body and no other
 * plugin's DOM is read.
 */
window.__ModuleLoader__.load({
  id: 'dsh-device-mirror',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useMemo, useRef, useState } = React;

    const API = '/api/device-mirror';
    const BOOT_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const STORAGE_KEY = 'dsh-device-mirror:float';
    /** Last device the user actually used, so reopening the panel resumes it. */
    const PICK_KEY = 'dsh-device-mirror:device';

    /** Latest locale, refreshed from the Client locale service. */
    let activeLocale = 'zh';
    const t = (zh, en) => (String(activeLocale).toLowerCase().startsWith('en') ? en : zh);

    function readLocale(locale) {
      try {
        const snapshot = locale?.getLocale?.() ?? locale?.getSnapshot?.();
        const active = snapshot?.active ?? snapshot?.locale ?? snapshot?.id;
        if (typeof active === 'string' && active) activeLocale = active;
      } catch {
        // A locale service that cannot answer keeps the previous value.
      }
    }

    /**
     * Boot beacon. The Host cannot inspect the page, so without this "the
     * module never loaded" and "it loaded but registered nothing" look alike.
     */
    function report(stage, extra) {
      try {
        const query = new URLSearchParams({ boot: BOOT_ID, stage });
        for (const [key, value] of Object.entries(extra || {})) query.set(key, String(value));
        fetch(`${API}/report?${query.toString()}`, { cache: 'no-store' }).catch(() => {});
      } catch {
        // A beacon that fails must never break a surface.
      }
    }

    // -----------------------------------------------------------------------
    // Shared store
    // -----------------------------------------------------------------------

    function createStore(initial) {
      let state = initial;
      const listeners = new Set();
      return {
        get: () => state,
        set(patch) {
          state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) };
          for (const listener of listeners) listener(state);
        },
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      };
    }

    /**
     * Multi-window state.
     *
     * A **panel** is one floating mirror bound to one device. Everything that
     * survives a reload lives in `panels`; per-panel runtime state (frames,
     * stream status) stays inside the component, so one panel receiving 12
     * frames a second does not re-render the others 12 times a second.
     *
     * The Host needed no change for this: producers are keyed by
     * `platform:device` and reference-counted, so two windows on one device
     * share a single capture and two windows on two devices get one each.
     */
    const store = createStore({
      devices: null,
      devicesError: null,
      loading: false,
      /** [{ id, platform, device, x, y }] — persisted, one entry per window. */
      panels: [],
      /** udid currently booting, so the picker can show progress on that row. */
      booting: '',
      bootError: null,
    });

    function useStore() {
      const [, force] = useState(0);
      useEffect(() => {
        const unsubscribe = store.subscribe(() => force((value) => value + 1));
        return () => {
          unsubscribe();
        };
      }, []);
      return store.get();
    }

    // -----------------------------------------------------------------------
    // Layout + persistence
    // -----------------------------------------------------------------------

    /**
     * ONE capture width for every window. The producer is keyed by device only,
     * so two windows on the same device asking for different widths would each
     * tear down the other's encoder. Panels differ in CSS width, not in capture
     * resolution.
     */
    /**
     * Capture resolution is derived from the rendered panel size times the
     * display's pixel ratio, because the frame is drawn 1:1 inside the box.
     * 380px wide looked soft on a 2x display: the panel is ~344 CSS px, so it
     * needs ~688 device pixels. Quantised to a step so a one-pixel layout change
     * does not tear down and rebuild the producer.
     */
    const CAPTURE_WIDTH_MIN = 360;
    // Matches the Host's own sanity bound (producerSpec clamps at 900). A
    // higher request would be silently truncated, so both sides agree here.
    const CAPTURE_WIDTH_MAX = 900;
    const CAPTURE_WIDTH_STEP = 40;
    /**
     * Supersampling factor. Measured at the final displayed size (688 device px
     * on a 2x screen), Laplacian sharpness went 920 → 989 with a lanczos scaler
     * and 989 → 1123 by capturing at 1.3x and letting the browser downscale.
     * Past ~1.3x it flattens (1000px scored the same as 920px).
     */
    const CAPTURE_SUPERSAMPLE = 1.3;
    const CAPTURE_FPS = 12;
    const CAPTURE_QUALITY = 10;
    const PANEL_WIDTH = 344;
    const CASCADE = 26;
    const EDGE = 20;
    const PANELS_KEY = 'dsh-device-mirror:panels';

    /**
     * Windows belong to a SESSION, not to the app: switching conversations must
     * swap which device you are looking at, and must not leak one session's
     * windows into another. Storage is therefore namespaced per session, with a
     * global key as the fallback for the case where the sessions service never
     * publishes.
     */
    function panelsKey(sessionId) {
      /**
       * A window belongs to the conversation that opened it.
       *
       * This used to fall back to the bare key when the session id was not
       * known, which made every such conversation share ONE set of windows -
       * so a mirror opened in one chat appeared in another the user never
       * opened it in. No id now means no persistence at all.
       */
      return sessionId ? `${PANELS_KEY}:${sessionId}` : null;
    }

    /** The session whose windows are currently in memory. */
    let activeSessionId = null;

    /**
     * `null` means "never saved for this session" (first visit, open one window
     * for the user); `[]` means "the user closed them all" and must stay empty.
     */
    function readPanels(sessionId = activeSessionId) {
      const key = panelsKey(sessionId);
      if (!key) return [];
      try {
        const raw = window.localStorage.getItem(key);
        if (raw === null || raw === undefined) return null;
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return null;
        return parsed
          .filter((row) => row && typeof row.id === 'string' && row.id)
          .map((row) => ({
            id: String(row.id),
            platform: typeof row.platform === 'string' ? row.platform : '',
            device: typeof row.device === 'string' ? row.device : '',
            x: Number.isFinite(row.x) ? row.x : EDGE,
            y: Number.isFinite(row.y) ? row.y : 88,
            minimized: row.minimized === true,
          }));
      } catch {
        return null;
      }
    }

    function persistPanels(sessionId, panels) {
      const key = panelsKey(sessionId);
      if (!key) return;
      try {
        window.localStorage.setItem(key, JSON.stringify(panels));
      } catch {
        // Storage denial costs only the restore convenience.
      }
    }

    /** Reads the active conversation id out of the sessions store snapshot. */
    function readSessionId(snapshot) {
      if (!snapshot || typeof snapshot !== 'object') return null;
      const current = snapshot.current;
      if (typeof current === 'string') return current;
      if (current && typeof current === 'object' && typeof current.id === 'string') return current.id;
      const rows = snapshot.byId ? Object.values(snapshot.byId) : [];
      // Newer sessions keep view ownership instead of publishing `current`.
      const owner = rows.find((row) => (row?.retainedBy?.mainView ?? 0) > 0);
      return typeof owner?.id === 'string' ? owner.id : null;
    }

    // -----------------------------------------------------------------------
    // Data access
    // -----------------------------------------------------------------------

    async function loadDevices() {
      store.set({ loading: true, devicesError: null });
      try {
        const response = await fetch(`${API}/devices`, { cache: 'no-store' });
        const body = await response.json().catch(() => null);
        if (!response.ok || !body?.ok) throw new Error(body?.error || `HTTP ${response.status}`);
        const rows = [
          ...(body.ios.devices ?? []).map((row) => ({ ...row, platform: 'ios' })),
          ...(body.android.devices ?? []).map((row) => ({ ...row, platform: 'android' })),
        ];
        const failures = [
          body.android.available === false ? body.android.reason : null,
          body.ios.available === false ? body.ios.reason : null,
        ].filter(Boolean);
        store.set({
          devices: rows,
          loading: false,
          devicesError: failures.length ? failures.join(' · ') : null,
        });
      } catch (error) {
        store.set({ loading: false, devicesError: error instanceof Error ? error.message : String(error) });
      }
    }

    /** Filled in by apply(); resolved lazily so a late service cannot block the plugin. */
    let pluginCtx = null;

    function sessionStore() {
      try {
        return pluginCtx?.get?.('sessions')?.list ?? null;
      } catch {
        return null;
      }
    }

    /**
     * Tracks the active conversation. `undefined` = not resolved yet, so the
     * overlay waits instead of loading the wrong (global) window set.
     */
    function useSessionId() {
      const [sessionId, setSessionId] = useState(undefined);
      useEffect(() => {
        let cancelled = false;
        let unsubscribe = null;
        const attach = () => {
          const list = sessionStore();
          if (!list?.subscribe || !list?.getSnapshot) return false;
          const read = () => {
            if (cancelled) return;
            try {
              setSessionId(readSessionId(list.getSnapshot()) ?? null);
            } catch {
              setSessionId(null);
            }
          };
          read();
          unsubscribe = list.subscribe(read);
          // Tell the Host which session the overlay resolved. Without this, a
          // wrong `ctx.sessions.list` shape degrades silently into the global
          // key and looks exactly like success from the outside.
          try {
            report('session', { detail: String(readSessionId(list.getSnapshot()) ?? 'none') });
          } catch {
            report('session', { detail: 'unreadable' });
          }
          return true;
        };
        if (attach()) {
          return () => {
            cancelled = true;
            unsubscribe?.();
          };
        }
        // The service can publish after this plugin applies; retry briefly, then
        // give up into the unscoped key rather than never showing a window.
        let ticks = 0;
        const timer = setInterval(() => {
          ticks += 1;
          if (attach()) {
            clearInterval(timer);
            return;
          }
          if (ticks >= 10) {
            clearInterval(timer);
            setSessionId(null);
          }
        }, 500);
        return () => {
          cancelled = true;
          clearInterval(timer);
          unsubscribe?.();
        };
      }, []);
      return sessionId;
    }

    /**
     * Swap the in-memory window set to another session: flush the outgoing set
     * under its own key, then load the incoming one. Returns the raw saved value
     * so the caller can tell "first visit" (null) from "closed them all" ([]).
     */
    function activateSession(sessionId) {
      const next = sessionId ?? null;
      if (activeSessionId !== null && activeSessionId !== next) {
        persistPanels(activeSessionId, store.get().panels);
      }
      activeSessionId = next;
      const saved = readPanels(next);
      store.set({ panels: saved && saved.length ? saved : [] });
      return saved;
    }

    function isRunning(row) {
      return Boolean(row) && (row.state === 'Booted' || row.state === 'device');
    }

    function findRow(platform, device) {
      return (store.get().devices ?? []).find((row) => row.platform === platform && row.device === device) ?? null;
    }

    async function requestInput(platform, device, payload) {
      const response = await fetch(`${API}/input`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ platform, device, ...payload }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok || !body?.ok) throw new Error(body?.error || `HTTP ${response.status}`);
      return body;
    }

    async function bootDevice(row) {
      if (store.get().booting) return false;
      store.set({ booting: row.device, bootError: null });
      try {
        const response = await fetch(`${API}/boot`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ platform: row.platform, device: row.device }),
        });
        const body = await response.json().catch(() => null);
        if (!response.ok || !body?.ok) throw new Error(body?.error || `HTTP ${response.status}`);
        // Refresh FIRST: the panel reconnects off the row's new `state`, so the
        // list has to be current before anything is selected.
        await loadDevices();
        store.set({ booting: '', bootError: null });
        return true;
      } catch (error) {
        store.set({ booting: '', bootError: error instanceof Error ? error.message : String(error) });
        return false;
      }
    }

    /**
     * Start an Android AVD and return the adb serial it came up as.
     *
     * Identity matters here: a stopped AVD is addressed by NAME, but every
     * runtime operation (stream, tap) needs the SERIAL. The Host does that
     * translation and hands the serial back, so the window rebinds to something
     * that actually accepts input.
     */
    async function bootAvd(name) {
      if (store.get().booting) return null;
      store.set({ booting: name, bootError: null });
      try {
        const response = await fetch(`${API}/android/boot`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name }),
        });
        const body = await response.json().catch(() => null);
        if (!response.ok || !body?.ok) throw new Error(body?.error || `HTTP ${response.status}`);
        await loadDevices();
        store.set({ booting: '', bootError: null });
        return typeof body.device === 'string' ? body.device : null;
      } catch (error) {
        store.set({ booting: '', bootError: error instanceof Error ? error.message : String(error) });
        return null;
      }
    }

    async function createAvd({ name, imageId, deviceId }) {
      const response = await fetch(`${API}/android/create`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: name || undefined, imageId, deviceId: deviceId || undefined }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok || !body?.ok) throw new Error(body?.error || `HTTP ${response.status}`);
      return body.avd;
    }

    // -----------------------------------------------------------------------
    // Panel actions
    // -----------------------------------------------------------------------

    function addPanel() {
      const state = store.get();
      const rows = state.devices ?? [];
      const used = new Set(state.panels.map((panel) => `${panel.platform}:${panel.device}`));
      const fresh = (row) => !used.has(`${row.platform}:${row.device}`);
      // A device nobody is showing yet, preferring one already running; only
      // then fall back to a duplicate view of something in use.
      const candidate = rows.find((row) => isRunning(row) && fresh(row))
        ?? rows.find(fresh)
        ?? rows.find(isRunning)
        ?? rows[0]
        ?? null;
      const index = state.panels.length;
      const viewportWidth = window.innerWidth || 1280;
      const panel = {
        id: `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
        platform: candidate?.platform ?? '',
        device: candidate?.device ?? '',
        x: Math.max(EDGE, viewportWidth - PANEL_WIDTH - EDGE - index * CASCADE),
        y: 88 + index * CASCADE,
        minimized: false,
      };
      const panels = [...state.panels, panel];
      store.set({ panels });
      persistPanels(activeSessionId, panels);
      if (!state.devices) loadDevices();
      return panel;
    }

    function removePanel(id) {
      const panels = store.get().panels.filter((panel) => panel.id !== id);
      store.set({ panels });
      persistPanels(activeSessionId, panels);
    }

    function movePanel(id, x, y) {
      const panels = store.get().panels.map((panel) => (panel.id === id ? { ...panel, x, y } : panel));
      store.set({ panels });
      persistPanels(activeSessionId, panels);
    }

    function setPanelMinimized(id, minimized) {
      const panels = store.get().panels.map((panel) => (panel.id === id ? { ...panel, minimized } : panel));
      store.set({ panels });
      persistPanels(activeSessionId, panels);
    }

    function setPanelDevice(id, platform, device) {
      const panels = store.get().panels.map((panel) => (
        panel.id === id ? { ...panel, platform, device } : panel
      ));
      store.set({ panels, bootError: null });
      persistPanels(activeSessionId, panels);
    }

    // -----------------------------------------------------------------------
    // Multipart JPEG reader
    // -----------------------------------------------------------------------

    const CRLF2 = [13, 10, 13, 10];

    function indexOfBytes(haystack, needle, from) {
      const limit = haystack.length - needle.length;
      outer: for (let i = Math.max(0, from); i <= limit; i += 1) {
        for (let j = 0; j < needle.length; j += 1) {
          if (haystack[i + j] !== needle[j]) continue outer;
        }
        return i;
      }
      return -1;
    }

    /**
     * Parses the exact body the Host writes: a boundary delimiter, part headers
     * that always include content-length, then the raw JPEG. Because the length
     * is authoritative the parser never has to scan for JPEG markers.
     */
    function createMultipartParser(onFrame) {
      let buffer = new Uint8Array(0);
      const delimiter = new TextEncoder().encode('--dshdevicemirrorframe');
      return (chunk) => {
        if (buffer.length === 0) buffer = chunk;
        else {
          const merged = new Uint8Array(buffer.length + chunk.length);
          merged.set(buffer, 0);
          merged.set(chunk, buffer.length);
          buffer = merged;
        }
        for (;;) {
          const start = indexOfBytes(buffer, delimiter, 0);
          if (start < 0) {
            // Keep a tail long enough to contain a split delimiter.
            if (buffer.length > delimiter.length) buffer = buffer.subarray(buffer.length - delimiter.length);
            return;
          }
          const headerEnd = indexOfBytes(buffer, CRLF2, start);
          if (headerEnd < 0) return;
          const headers = new TextDecoder().decode(buffer.subarray(start, headerEnd));
          const match = /content-length:\s*(\d+)/i.exec(headers);
          if (!match) {
            buffer = buffer.subarray(headerEnd + CRLF2.length);
            continue;
          }
          const length = Number(match[1]);
          const bodyStart = headerEnd + CRLF2.length;
          if (buffer.length < bodyStart + length) return;
          onFrame(buffer.subarray(bodyStart, bodyStart + length));
          buffer = buffer.subarray(bodyStart + length);
        }
      };
    }

    // -----------------------------------------------------------------------
    // Presentation helpers
    // -----------------------------------------------------------------------

    const STATUS_TONE = {
      live: '#30d158',
      connecting: '#ff9f0a',
      error: '#ff453a',
      idle: 'rgba(255,255,255,.38)',
    };

    /** Short display name: the picker carries the long detail, the chip does not. */
    function shortName(row) {
      if (!row) return t('选择设备', 'Pick device');
      const label = String(row.label || row.device);
      // Host labels look like "iPhone 16 Pro" or "Pixel 7 (panther)"; the chip
      // only has room for the leading name.
      return label.split(' (')[0].split(' · ')[0].slice(0, 24);
    }

    function deviceAspect(row) {
      if (row && row.nativeWidth && row.nativeHeight) return row.nativeWidth / row.nativeHeight;
      return 9 / 19.5;
    }

    function detailLine(row) {
      if (!row) return '';
      const bits = [];
      if (row.runtime) {
        // The Host reports the runtime as "iOS-26-5"; spelling that out as
        // "iOS 26 5" next to another "iOS" reads like a bug in the picker.
        const version = String(row.runtime).replace(/^iOS-/, '').replace(/-/g, '.');
        bits.push(`iOS ${version}`);
      } else {
        bits.push(row.platform === 'ios' ? 'iOS' : 'Android');
      }
      if (row.model && row.model !== shortName(row)) bits.push(row.model);
      if (row.nativeWidth) bits.push(`${row.nativeWidth}×${row.nativeHeight}`);
      return bits.join(' · ');
    }

    // -----------------------------------------------------------------------
    // Icons — 1.7px stroke, 20px box, currentColor
    // -----------------------------------------------------------------------

    const ICONS = {
      plus: ['M10 4v12', 'M4 10h12'],
      minimize: ['M4 10h12'],
      chevron: ['M5 8l5 5 5-5'],
      refresh: ['M17 10a7 7 0 1 1-2.1-5', 'M17 4v4h-4'],
      close: ['M5 5l10 10', 'M15 5L5 15'],
      expand: ['M7 3H3v4', 'M13 3h4v4', 'M17 13v4h-4', 'M3 13v4h4'],
      back: ['M12 5l-6 5 6 5'],
      home: ['M4 10l6-5 6 5', 'M6.5 9v6h7V9'],
      recents: ['M4.5 5h11v10h-11z'],
      send: ['M3 10l14-6-5 14-2.5-6z'],
      keyboard: [
        'M3 6.2h14a1.2 1.2 0 0 1 1.2 1.2v5.2a1.2 1.2 0 0 1-1.2 1.2H3a1.2 1.2 0 0 1-1.2-1.2V7.4A1.2 1.2 0 0 1 3 6.2z',
        'M5 9.2h.01', 'M7.8 9.2h.01', 'M10.6 9.2h.01', 'M13.4 9.2h.01',
        'M6.4 12.1h7.2',
      ],
      android: ['M6 9h8v7a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1z', 'M8 9V6.5a2 2 0 0 1 4 0V9', 'M6 10H4.5', 'M14 10h1.5'],
      ios: ['M10 6.5c1.6 0 2.6-1 2.6-2.2-1.5 0-2.6 1-2.6 2.2z', 'M13.4 8.2c-1.4-.8-2.9-.4-3.6 0-1.5.8-2.4 2.4-2 4.2.4 1.6 1.6 3.3 2.9 3.3.8 0 1.1-.4 2-.4s1.2.4 2 .4c1.3 0 2.4-1.7 2.8-3.3.4-1.8-.5-3.4-2-4.2z'],
    };

    function Icon({ name, size = 16 }) {
      const paths = ICONS[name] ?? [];
      return h('svg', {
        width: size, height: size, viewBox: '0 0 20 20', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true, style: { display: 'block' },
      }, paths.map((d, index) => h('path', { key: index, d })));
    }

    // -----------------------------------------------------------------------
    // Style tokens
    // -----------------------------------------------------------------------

    /**
     * Chrome glass. Deliberately DARK and mostly opaque: the backdrop is a live
     * device screen, which is very often white, and a translucent light-on-light
     * bar turns every icon invisible. At .82 a white screen still lands near
     * #2b2b2e, so white glyphs keep their contrast on any app.
     */
    const GLASS = {
      background: 'rgba(17,17,20,.82)',
      backdropFilter: 'blur(18px) saturate(150%)',
      WebkitBackdropFilter: 'blur(18px) saturate(150%)',
      border: '1px solid rgba(255,255,255,.14)',
      color: '#f5f5f7',
      boxShadow: '0 8px 26px rgba(0,0,0,.45), inset 0 1px 0 rgba(255,255,255,.07)',
    };


    const ghostButton = {
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      gap: '5px', minHeight: '26px', padding: '0 7px',
      borderRadius: '8px', border: '1px solid transparent',
      background: 'transparent', color: 'inherit', cursor: 'pointer',
      fontSize: '11px', lineHeight: 1, whiteSpace: 'nowrap',
      transition: 'background .14s ease, border-color .14s ease',
    };

    function hoverable(event, on) {
      // Tiny helper so every ghost button reacts the same way without a
      // per-button state hook.
      event.currentTarget.style.background = on ? 'rgba(255,255,255,.12)' : 'transparent';
      event.currentTarget.style.borderColor = on ? 'rgba(255,255,255,.10)' : 'transparent';
    }
    // -----------------------------------------------------------------------
    // Device manager — lives inside the window, and can create simulators
    // -----------------------------------------------------------------------

    function DeviceManager({ panel, onClose, onAddWindow }) {
      const state = useStore();
      const rows = state.devices ?? [];
      const others = state.panels.filter((other) => other.id !== panel.id);

      const [mode, setMode] = useState('list');
      const [catalog, setCatalog] = useState(null);
      const [catalogError, setCatalogError] = useState(null);
      const [creating, setCreating] = useState(false);
      const [createError, setCreateError] = useState(null);
      const [form, setForm] = useState({ name: '', deviceType: '', runtime: '' });
      const [createPlatform, setCreatePlatform] = useState('ios');
      const [androidCatalog, setAndroidCatalog] = useState(null);
      const [androidError, setAndroidError] = useState(null);
      const [avdForm, setAvdForm] = useState({ name: '', imageId: '', deviceId: '' });

      // Only paid for when the create sheet is opened: listing 124 device types
      // and the installed runtimes is two simctl calls.
      useEffect(() => {
        if (mode !== 'create' || catalog) return undefined;
        let cancelled = false;
        (async () => {
          try {
            const response = await fetch(`${API}/catalog`, { cache: 'no-store' });
            const body = await response.json().catch(() => null);
            if (!response.ok || !body?.ok) throw new Error(body?.error || `HTTP ${response.status}`);
            if (cancelled) return;
            setCatalog(body);
            const runtime = (body.runtimes ?? []).find((row) => row.available !== false) ?? (body.runtimes ?? [])[0];
            const deviceTypes = body.deviceTypes ?? [];
            const deviceType = deviceTypes.find((row) => row.identifier === 'com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro')
              ?? deviceTypes.find((row) => row.productFamily === 'iPhone')
              ?? deviceTypes[0];
            setForm((current) => ({
              ...current,
              runtime: current.runtime || runtime?.identifier || '',
              deviceType: current.deviceType || deviceType?.identifier || '',
            }));
          } catch (error) {
            if (!cancelled) setCatalogError(error instanceof Error ? error.message : String(error));
          }
        })();
        return () => {
          cancelled = true;
        };
      }, [mode, catalog]);

      // AVD templates come from a different toolchain than iOS simulators, so
      // they are fetched only when the Android tab is opened.
      useEffect(() => {
        if (mode !== 'create' || createPlatform !== 'android' || androidCatalog) return undefined;
        let cancelled = false;
        (async () => {
          try {
            const response = await fetch(`${API}/android/catalog`, { cache: 'no-store' });
            const body = await response.json().catch(() => null);
            if (!response.ok || !body?.ok) throw new Error(body?.error || `HTTP ${response.status}`);
            if (cancelled) return;
            setAndroidCatalog(body);
            const image = (body.images ?? [])[0];
            const device = (body.devices ?? []).find((row) => /pixel/i.test(row.name)) ?? (body.devices ?? [])[0];
            setAvdForm((current) => ({
              ...current,
              imageId: current.imageId || image?.id || '',
              deviceId: current.deviceId || device?.id || '',
            }));
          } catch (error) {
            if (!cancelled) setAndroidError(error instanceof Error ? error.message : String(error));
          }
        })();
        return () => {
          cancelled = true;
        };
      }, [mode, createPlatform, androidCatalog]);

      const choose = (row) => {
        setPanelDevice(panel.id, row.platform, row.device);
        onClose?.();
      };

      const boot = async (row) => {
        // A stopped Android AVD is addressed by name; booting it yields a serial,
        // and the window must bind to that serial (it is what accepts input).
        if (row.kind === 'avd') {
          const serial = await bootAvd(row.device);
          if (serial) {
            setPanelDevice(panel.id, 'android', serial);
            onClose?.();
          }
          return;
        }
        const ok = await bootDevice(row);
        if (ok) choose(row);
      };

      const submitAndroidCreate = async () => {
        if (creating || !avdForm.imageId) return;
        setCreating(true);
        setCreateError(null);
        try {
          const avd = await createAvd(avdForm);
          await loadDevices();
          const serial = await bootAvd(avd);
          if (!serial) throw new Error(store.get().bootError || 'AVD created, but it did not come up');
          setPanelDevice(panel.id, 'android', serial);
          onClose?.();
        } catch (error) {
          setCreateError(error instanceof Error ? error.message : String(error));
        } finally {
          setCreating(false);
        }
      };

      const submitCreate = async () => {
        if (createPlatform === 'android') return submitAndroidCreate();
        if (creating || !form.deviceType || !form.runtime) return;
        setCreating(true);
        setCreateError(null);
        try {
          const response = await fetch(`${API}/create`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              name: form.name.trim() || undefined,
              deviceTypeIdentifier: form.deviceType,
              runtimeIdentifier: form.runtime,
            }),
          });
          const body = await response.json().catch(() => null);
          if (!response.ok || !body?.ok) throw new Error(body?.error || `HTTP ${response.status}`);
          // Bind first so the window follows the new machine, then boot it; the
          // boot flips the device state, which is what re-opens the stream.
          await loadDevices();
          setPanelDevice(panel.id, 'ios', body.device);
          const booted = await bootDevice({ platform: 'ios', device: body.device });
          if (!booted) throw new Error(store.get().bootError || 'created, but the boot did not complete');
          onClose?.();
        } catch (error) {
          setCreateError(error instanceof Error ? error.message : String(error));
        } finally {
          setCreating(false);
        }
      };

      const groups = [
        { platform: 'ios', title: t('iOS 模拟器', 'iOS Simulators'), glyph: 'ios' },
        { platform: 'android', title: t('Android 设备', 'Android devices'), glyph: 'android' },
      ];

      const Row = (row) => {
        const running = isRunning(row);
        const selected = row.platform === panel.platform && row.device === panel.device;
        const booting = state.booting === row.device;
        const stoppedAvd = row.kind === 'avd' && row.state === 'Stopped';
        const canBoot = !running && (row.platform === 'ios' || stoppedAvd);
        const inUse = others.some((other) => other.platform === row.platform && other.device === row.device);
        return h('div', {
          key: `${row.platform}:${row.device}`,
          onClick: () => {
            if (booting) return;
            if (running) choose(row);
            else if (canBoot) boot(row);
          },
          onMouseEnter: (event) => { event.currentTarget.style.background = 'rgba(255,255,255,.08)'; },
          onMouseLeave: (event) => { event.currentTarget.style.background = selected ? 'rgba(255,255,255,.10)' : 'transparent'; },
          style: {
            display: 'flex', alignItems: 'center', gap: '8px',
            padding: '7px 9px', borderRadius: '9px',
            cursor: running || canBoot ? 'pointer' : 'default',
            background: selected ? 'rgba(255,255,255,.10)' : 'transparent',
            opacity: running || canBoot ? 1 : 0.5,
          },
        },
          h('span', {
            style: {
              width: '6px', height: '6px', borderRadius: '50%', flex: '0 0 auto',
              background: running ? '#30d158' : 'rgba(255,255,255,.28)',
              boxShadow: running ? '0 0 6px #30d158aa' : 'none',
            },
          }),
          h('span', { style: { display: 'flex', flexDirection: 'column', gap: '1px', minWidth: 0, flex: 1 } },
            h('span', { style: { display: 'flex', alignItems: 'center', gap: '5px', fontSize: '12px', fontWeight: 500 } },
              h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, shortName(row)),
              inUse
                ? h('span', { style: { fontSize: '9px', opacity: 0.5, border: '1px solid rgba(255,255,255,.22)', borderRadius: '999px', padding: '0 5px' } },
                    t('已开', 'open'))
                : null,
            ),
            h('span', {
              style: { fontSize: '10px', opacity: 0.55, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
            }, detailLine(row)),
          ),
          booting
            ? h('span', { style: { fontSize: '10px', opacity: 0.7, whiteSpace: 'nowrap' } }, t('启动中…', 'booting…'))
            : canBoot
              ? h('span', { style: { ...ghostButton, border: '1px solid rgba(255,255,255,.16)', padding: '0 8px', whiteSpace: 'nowrap' } }, t('启动', 'Boot'))
              : selected
                ? h('span', { style: { fontSize: '10px', opacity: 0.6, whiteSpace: 'nowrap' } }, t('当前', 'current'))
                : null,
        );
      };

      const field = {
        width: '100%', height: '26px', padding: '0 8px', borderRadius: '7px',
        fontSize: '11px', color: 'inherit',
        background: 'rgba(255,255,255,.08)',
        border: '1px solid rgba(255,255,255,.12)',
        outline: 'none',
      };

      const createSheet = () => {
        const field = {
          width: '100%', height: '26px', padding: '0 8px', borderRadius: '7px',
          fontSize: '11px', color: 'inherit',
          background: 'rgba(255,255,255,.08)',
          border: '1px solid rgba(255,255,255,.12)',
          outline: 'none',
        };
        const labelStyle = { fontSize: '9.5px', opacity: 0.5, textTransform: 'uppercase', letterSpacing: '.05em' };
        const submitStyle = (blocked) => ({
          ...ghostButton,
          marginTop: '2px',
          height: '28px',
          justifyContent: 'center',
          border: '1px solid rgba(255,255,255,.16)',
          background: 'rgba(48,209,88,.18)',
          opacity: blocked ? 0.55 : 1,
          cursor: blocked ? 'default' : 'pointer',
        });

        const iosFields = () => {
          const deviceTypes = catalog?.deviceTypes ?? [];
          const runtimes = catalog?.runtimes ?? [];
          const families = [];
          for (const row of deviceTypes) {
            const family = row.productFamily || t('其它', 'Other');
            if (!families.includes(family)) families.push(family);
          }
          const blocked = creating || !form.deviceType || !form.runtime;
          return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '5px' } },
            catalogError ? h('div', { style: { fontSize: '10px', color: '#ff453a', lineHeight: 1.5 } }, catalogError) : null,
            !catalog && !catalogError
              ? h('div', { style: { fontSize: '11px', opacity: 0.6, padding: '10px 6px' } }, t('正在读取模板…', 'Loading templates…'))
              : null,
            catalog
              ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '5px' } },
                  h('label', { style: { display: 'flex', flexDirection: 'column', gap: '3px' } },
                    h('span', { style: labelStyle }, t('模板', 'Model')),
                    h('select', {
                      value: form.deviceType,
                      onChange: (event) => setForm((current) => ({ ...current, deviceType: event.target.value })),
                      style: field,
                    },
                      families.map((family) => h('optgroup', { key: family, label: family },
                        deviceTypes.filter((row) => row.productFamily === family)
                          .map((row) => h('option', { key: row.identifier, value: row.identifier }, row.name)),
                      )),
                    ),
                  ),
                  h('label', { style: { display: 'flex', flexDirection: 'column', gap: '3px' } },
                    h('span', { style: labelStyle }, t('系统版本', 'Runtime')),
                    h('select', {
                      value: form.runtime,
                      onChange: (event) => setForm((current) => ({ ...current, runtime: event.target.value })),
                      style: field,
                    },
                      runtimes.map((row) => h('option', {
                        key: row.identifier,
                        value: row.identifier,
                        disabled: row.available === false,
                      }, `${row.name}${row.available === false ? ` · ${t('不可用', 'unavailable')}` : ''}`)),
                    ),
                  ),
                  h('label', { style: { display: 'flex', flexDirection: 'column', gap: '3px' } },
                    h('span', { style: labelStyle }, t('名称（可留空）', 'Name (optional)')),
                    h('input', {
                      value: form.name,
                      placeholder: t('自动命名', 'auto'),
                      onChange: (event) => setForm((current) => ({ ...current, name: event.target.value })),
                      style: field,
                    }),
                  ),
                  createError ? h('div', { style: { fontSize: '10px', color: '#ff453a', lineHeight: 1.5 } }, createError) : null,
                  h('button', {
                    onClick: submitCreate,
                    disabled: blocked,
                    onMouseEnter: (event) => hoverable(event, true),
                    onMouseLeave: (event) => hoverable(event, false),
                    style: submitStyle(blocked),
                  }, creating ? t('创建并启动中…', 'Creating and booting…') : t('创建并启动', 'Create and boot')),
                )
              : null,
          );
        };

        const androidFields = () => {
          const images = androidCatalog?.images ?? [];
          const profiles = androidCatalog?.devices ?? [];
          const blocked = creating || !avdForm.imageId;
          return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '5px' } },
            androidError ? h('div', { style: { fontSize: '10px', color: '#ff453a', lineHeight: 1.5 } }, androidError) : null,
            !androidCatalog && !androidError
              ? h('div', { style: { fontSize: '11px', opacity: 0.6, padding: '10px 6px' } }, t('正在读取镜像…', 'Loading images…'))
              : null,
            androidCatalog
              ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '5px' } },
                  images.length
                    ? h('label', { style: { display: 'flex', flexDirection: 'column', gap: '3px' } },
                        h('span', { style: labelStyle }, t('系统镜像', 'System image')),
                        h('select', {
                          value: avdForm.imageId,
                          onChange: (event) => setAvdForm((current) => ({ ...current, imageId: event.target.value })),
                          style: field,
                        }, images.map((row) => h('option', { key: row.id, value: row.id }, row.label ?? row.id))),
                      )
                    : h('div', { style: { fontSize: '10px', color: '#ff9f0a', lineHeight: 1.5 } },
                        t('本机没有可用的系统镜像，需先在 Android SDK 里装一个。', 'No system images installed. Add one in the Android SDK first.')),
                  profiles.length
                    ? h('label', { style: { display: 'flex', flexDirection: 'column', gap: '3px' } },
                        h('span', { style: labelStyle }, t('机型', 'Device profile')),
                        h('select', {
                          value: avdForm.deviceId,
                          onChange: (event) => setAvdForm((current) => ({ ...current, deviceId: event.target.value })),
                          style: field,
                        }, profiles.map((row) => h('option', { key: row.id, value: row.id }, row.name))),
                      )
                    : null,
                  h('label', { style: { display: 'flex', flexDirection: 'column', gap: '3px' } },
                    h('span', { style: labelStyle }, t('名称（可留空）', 'Name (optional)')),
                    h('input', {
                      value: avdForm.name,
                      placeholder: t('自动命名', 'auto'),
                      onChange: (event) => setAvdForm((current) => ({ ...current, name: event.target.value })),
                      style: field,
                    }),
                  ),
                  createError ? h('div', { style: { fontSize: '10px', color: '#ff453a', lineHeight: 1.5 } }, createError) : null,
                  h('button', {
                    onClick: submitCreate,
                    disabled: blocked,
                    onMouseEnter: (event) => hoverable(event, true),
                    onMouseLeave: (event) => hoverable(event, false),
                    style: submitStyle(blocked),
                  }, creating ? t('创建并启动中…', 'Creating and booting…') : t('创建并启动', 'Create and boot')),
                  h('div', { style: { fontSize: '9.5px', opacity: 0.45, lineHeight: 1.5 } },
                    t('首次启动实测约 50–70 秒。', 'A first boot measures about 50–70s.')),
                )
              : null,
          );
        };

        const platformTab = (id, label) => h('button', {
          onClick: () => { setCreatePlatform(id); setCreateError(null); },
          onMouseEnter: (event) => hoverable(event, true),
          onMouseLeave: (event) => hoverable(event, false),
          style: {
            ...ghostButton,
            flex: 1,
            justifyContent: 'center',
            height: '24px',
            border: `1px solid ${createPlatform === id ? 'rgba(255,255,255,.28)' : 'transparent'}`,
            background: createPlatform === id ? 'rgba(255,255,255,.12)' : 'transparent',
          },
        }, label);

        return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px', padding: '2px 2px 4px' } },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', padding: '2px 4px 2px 6px' } },
            h('button', {
              onClick: () => setMode('list'),
              onMouseEnter: (event) => hoverable(event, true),
              onMouseLeave: (event) => hoverable(event, false),
              title: t('返回设备列表', 'Back to devices'),
              style: { ...ghostButton, padding: '0 6px' },
            }, h(Icon, { name: 'back', size: 13 })),
            h('span', { style: { fontSize: '10px', letterSpacing: '.06em', textTransform: 'uppercase', opacity: 0.5 } },
              t('新建设备', 'New device')),
          ),
          h('div', { style: { display: 'flex', gap: '4px', padding: '0 4px' } },
            platformTab('ios', 'iOS'),
            platformTab('android', 'Android'),
          ),
          h('div', { style: { padding: '0 4px' } }, createPlatform === 'ios' ? iosFields() : androidFields()),
        );
      };

      const listSheet = () => h('div', { style: { display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 } },
        h('div', { style: { display: 'flex', alignItems: 'center', padding: '2px 6px 6px 8px' } },
          h('span', { style: { fontSize: '10px', letterSpacing: '.06em', textTransform: 'uppercase', opacity: 0.5 } },
            t('设备', 'Devices')),
          h('span', { style: { flex: 1 } }),
          h('button', {
            style: { ...ghostButton, padding: '0 6px' },
            onClick: () => loadDevices(),
            onMouseEnter: (event) => hoverable(event, true),
            onMouseLeave: (event) => hoverable(event, false),
            title: t('刷新', 'Refresh'),
          }, state.loading ? t('刷新中', 'refreshing') : h(Icon, { name: 'refresh', size: 13 })),
          onClose
            ? h('button', {
                style: { ...ghostButton, padding: '0 6px' },
                onClick: onClose,
                onMouseEnter: (event) => hoverable(event, true),
                onMouseLeave: (event) => hoverable(event, false),
                title: t('返回画面', 'Back to screen'),
              }, h(Icon, { name: 'close', size: 13 }))
            : null,
        ),
        state.devicesError ? h('div', { style: { fontSize: '10px', color: '#ff9f0a', padding: '0 8px 6px', lineHeight: 1.5 } }, state.devicesError) : null,
        state.bootError ? h('div', { style: { fontSize: '10px', color: '#ff453a', padding: '0 8px 6px', lineHeight: 1.5 } }, state.bootError) : null,
        !rows.length && state.loading
          ? h('div', { style: { fontSize: '11px', opacity: 0.6, padding: '10px 9px' } }, t('正在扫描设备…', 'Scanning…'))
          : null,
        !rows.length && !state.loading
          ? h('div', { style: { fontSize: '11px', opacity: 0.6, padding: '10px 9px', lineHeight: 1.6 } },
              t('没检测到设备。可以在下面新建一台。', 'No devices yet. Create one below.'))
          : null,
        h('div', { style: { flex: 1, overflowY: 'auto', minHeight: 0 } },
          groups.map((group) => {
            const list = rows.filter((row) => row.platform === group.platform);
            if (!list.length) return null;
            return h('div', { key: group.platform, style: { marginTop: '2px' } },
              h('div', {
                style: {
                  display: 'flex', alignItems: 'center', gap: '5px',
                  fontSize: '9.5px', letterSpacing: '.05em', textTransform: 'uppercase',
                  opacity: 0.42, padding: '5px 9px 3px',
                },
              }, h(Icon, { name: group.glyph, size: 11 }), group.title),
              list.map(Row),
            );
          }),
        ),
        // The window is where devices come from: no global "+" button anywhere.
        h('div', { style: { display: 'flex', gap: '5px', padding: '6px 4px 2px', borderTop: '1px solid rgba(255,255,255,.08)', marginTop: '4px' } },
          h('button', {
            onClick: () => setMode('create'),
            onMouseEnter: (event) => hoverable(event, true),
            onMouseLeave: (event) => hoverable(event, false),
            style: { ...ghostButton, flex: 1, justifyContent: 'center', border: '1px solid rgba(255,255,255,.16)', height: '26px' },
          }, h(Icon, { name: 'plus', size: 12 }), t('新建模拟器', 'New simulator')),
          onAddWindow
            ? h('button', {
                onClick: onAddWindow,
                onMouseEnter: (event) => hoverable(event, true),
                onMouseLeave: (event) => hoverable(event, false),
                title: t('在本会话再开一个窗口', 'Another window in this session'),
                style: { ...ghostButton, border: '1px solid rgba(255,255,255,.16)', height: '26px' },
              }, t('再开一窗', 'New window'))
            : null,
        ),
      );

      return h('div', {
        style: {
          ...GLASS,
          flex: 1,
          minHeight: 0,
          padding: '6px',
          zIndex: 5,
          display: 'flex',
          flexDirection: 'column',
        },
        onPointerDown: (event) => event.stopPropagation(),
      }, mode === 'create' ? createSheet() : listSheet());
    }

    // -----------------------------------------------------------------------
    // One floating window
    // -----------------------------------------------------------------------

    let topZ = 1000;

    function DevicePanel({ panel, onAddWindow }) {
      const state = useStore();
      const row = findRow(panel.platform, panel.device);

      const imgRef = useRef(null);
      const urlRef = useRef(null);
      const pointerRef = useRef(null);
      const dragRef = useRef(null);

      const [frameUrl, setFrameUrl] = useState(null);
      const [typing, setTyping] = useState(false);
      const [textMode, setTextMode] = useState(false);
      const [text, setText] = useState('');
      const [measuredAspect, setMeasuredAspect] = useState(null);
      const [status, setStatus] = useState('idle');
      const [streamError, setStreamError] = useState(null);
      const [inputError, setInputError] = useState(null);
      const [nonce, setNonce] = useState(0);
      const shellRef = useRef(null);
      const [z, setZ] = useState(() => ++topZ);

      const aspect = measuredAspect ?? deviceAspect(row);
      const running = isRunning(row);
      const iosDevice = panel.platform === 'ios';
      const textRowVisible = textMode || typing;

      // `row.state` is part of the reconnect key: booting a simulator flips it to
      // Booted, and that alone must re-open the stream without a button press.
      const deviceState = row?.state ?? 'unknown';

      // Fit the window to the viewport first: a 20:9 phone at 344 CSS px is
      // ~760 px tall, which overflows a shorter window.
      const viewportHeight = window.innerHeight || 800;
      const viewportWidth = window.innerWidth || 1280;
      const availableHeight = Math.max(300, viewportHeight - 150);
      const width = Math.max(220, Math.min(PANEL_WIDTH, Math.round(availableHeight * aspect)));
      const pixelRatio = window.devicePixelRatio || 1;
      const captureWidth = Math.min(
        CAPTURE_WIDTH_MAX,
        Math.max(
          CAPTURE_WIDTH_MIN,
          Math.ceil((width * pixelRatio * CAPTURE_SUPERSAMPLE) / CAPTURE_WIDTH_STEP) * CAPTURE_WIDTH_STEP,
        ),
      );

      const query = useMemo(() => {
        if (panel.minimized) return null;
        if (!panel.platform || !panel.device) return null;
        const params = new URLSearchParams({
          platform: panel.platform,
          device: panel.device,
          fps: String(CAPTURE_FPS),
          width: String(captureWidth),
          quality: String(CAPTURE_QUALITY),
          k: `${nonce}-${deviceState}`,
        });
        return `${API}/stream?${params.toString()}`;
      }, [panel.platform, panel.device, panel.minimized, nonce, deviceState, captureWidth]);

      useEffect(() => {
        setMeasuredAspect(null);
      }, [panel.device, panel.platform]);

      useEffect(() => {
        if (!query) {
          setStatus('idle');
          return undefined;
        }
        const controller = new AbortController();
        let cancelled = false;
        setStatus('connecting');
        setStreamError(null);

        const parse = createMultipartParser((bytes) => {
          if (cancelled) return;
          const blob = new Blob([bytes], { type: 'image/jpeg' });
          const url = URL.createObjectURL(blob);
          const previous = urlRef.current;
          urlRef.current = url;
          setFrameUrl(url);
          if (previous) setTimeout(() => URL.revokeObjectURL(previous), 1200);
          setStatus('live');
        });

        (async () => {
          try {
            const response = await fetch(query, { signal: controller.signal, cache: 'no-store' });
            if (!response.ok || !response.body) {
              const body = await response.json().catch(() => null);
              throw new Error(body?.error || `HTTP ${response.status}`);
            }
            const streamReader = response.body.getReader();
            for (;;) {
              const { done, value } = await streamReader.read();
              if (done) break;
              if (value) parse(value);
            }
            if (!cancelled) setStatus('idle');
          } catch (error) {
            if (cancelled || controller.signal.aborted) return;
            setStatus('error');
            setStreamError(error instanceof Error ? error.message : String(error));
          }
        })();

        return () => {
          cancelled = true;
          controller.abort();
          setFrameUrl(null);
          // The last frame's object URL had no successor to revoke it, so every
          // closed window leaked one decoded image (~50 KB) for the page's life.
          if (urlRef.current) {
            URL.revokeObjectURL(urlRef.current);
            urlRef.current = null;
          }
        };
      }, [query]);

      const normalise = (event) => {
        // Prefer the image, but fall back to the event target: the image node is
        // not guaranteed to be mounted when a gesture starts mid-reconnect.
        const element = imgRef.current ?? event?.currentTarget ?? null;
        if (!element || typeof element.getBoundingClientRect !== 'function') return null;
        const rect = element.getBoundingClientRect();
        if (!rect || !rect.width || !rect.height) return null;
        return {
          x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
          y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)),
        };
      };

      /**
       * Real time touch.
       *
       * Android's `input` route injects one event from a throwaway process, so a
       * drag had to be replayed as one `swipe` on release. The emulator accepts a
       * touch stream over gRPC, so when the Host says that is available the
       * gesture is forwarded as it happens. `null` means "not known yet": the
       * first press decides, and a refusal locks this window to the old path.
       */
      const realtimeRef = useRef(null);

      const startRealtime = (point) => {
        if (iosDevice || realtimeRef.current === false) return;
        requestInput(panel.platform, panel.device, { kind: 'touch', phase: 'down', x: point.x, y: point.y })
          .then(() => {
            realtimeRef.current = true;
            if (pointerRef.current) pointerRef.current.realtime = true;
          })
          .catch(() => {
            realtimeRef.current = false;
            if (pointerRef.current) pointerRef.current.realtime = false;
          });
      };

      const onScreenPointerDown = (event) => {
        if (status !== 'live') return;
        const point = normalise(event);
        if (!point) return;
        if (feedbackTimer.current) clearTimeout(feedbackTimer.current);
        pointerRef.current = { ...point, at: Date.now(), moved: false, realtime: false, lastMoveAt: 0 };
        setTouchEcho({ kind: 'press', x: point.x, y: point.y, x2: point.x, y2: point.y });
        event.currentTarget.setPointerCapture?.(event.pointerId);
        startRealtime(point);
      };

      const onScreenPointerMove = (event) => {
        const start = pointerRef.current;
        if (!start) return;
        const point = normalise(event);
        if (!point) return;
        const distance = Math.hypot((point.x - start.x) * 1000, (point.y - start.y) * 1000);
        if (distance > 12) start.moved = true;
        // ~30 Hz is more than the emulator consumes, and anything faster just
        // queues round trips behind a finger that has already moved on.
        if (start.realtime && Date.now() - (start.lastMoveAt ?? 0) > 33) {
          start.lastMoveAt = Date.now();
          requestInput(panel.platform, panel.device, { kind: 'touch', phase: 'move', x: point.x, y: point.y })
            .catch(() => { start.realtime = false; });
        }
        setTouchEcho({
          kind: start.moved ? 'swipe' : 'press',
          x: start.x, y: start.y, x2: point.x, y2: point.y,
        });
      };

      const onScreenPointerUp = (event) => {
        const start = pointerRef.current;
        pointerRef.current = null;
        if (!start || status !== 'live') {
          setTouchEcho(null);
          return;
        }
        const end = normalise(event) ?? { x: start.x, y: start.y };
        const distance = Math.hypot((end.x - start.x) * 1000, (end.y - start.y) * 1000);
        if (start.realtime) {
          // The gesture already reached the device sample by sample; only the
          // lift is left, and replaying it as a swipe would double the movement.
          requestInput(panel.platform, panel.device, { kind: 'touch', phase: 'up', x: end.x, y: end.y })
            .catch((error) => setInputError(error instanceof Error ? error.message : String(error)));
          setTouchEcho({ kind: 'release', x: start.x, y: start.y, x2: end.x, y2: end.y });
          if (feedbackTimer.current) clearTimeout(feedbackTimer.current);
          feedbackTimer.current = setTimeout(() => setTouchEcho(null), 240);
          return;
        }
        const payload = distance < 22
          ? { kind: 'tap', x: end.x, y: end.y }
          : { kind: 'swipe', x: start.x, y: start.y, x2: end.x, y2: end.y, duration: 220 };
        requestInput(panel.platform, panel.device, payload)
          .then(() => setInputError(null))
          .catch((error) => setInputError(error instanceof Error ? error.message : String(error)));
        // Keep the last gesture on screen for a beat so the press visibly lands.
        setTouchEcho({ kind: 'release', x: start.x, y: start.y, x2: end.x, y2: end.y });
        if (feedbackTimer.current) clearTimeout(feedbackTimer.current);
        feedbackTimer.current = setTimeout(() => setTouchEcho(null), 240);
      };

      const sendText = () => {
        if (!text.trim()) return;
        requestInput(panel.platform, panel.device, { kind: 'text', text })
          .then(() => { setText(''); setInputError(null); })
          .catch((error) => setInputError(error instanceof Error ? error.message : String(error)));
      };

      const sendKey = (key) => {
        requestInput(panel.platform, panel.device, { kind: 'key', key })
          .catch((error) => setInputError(error instanceof Error ? error.message : String(error)));
      };

      // ---- the title bar is the drag handle: the WHOLE bar, always visible.
      const startDrag = (event) => {
        // Only real action buttons opt out. The bar itself must stay draggable,
        // which is what the previous hover-only strip got wrong.
        if (event.target?.closest?.('button[data-action]')) return;
        dragRef.current = {
          pointerX: event.clientX, pointerY: event.clientY,
          originX: panel.x, originY: panel.y, moved: false,
        };
        event.currentTarget.setPointerCapture?.(event.pointerId);
        event.stopPropagation();
      };
      const moveDrag = (event) => {
        const drag = dragRef.current;
        if (!drag) return;
        const dx = event.clientX - drag.pointerX;
        const dy = event.clientY - drag.pointerY;
        // 3px was tight enough that a normal click often counted as a drag,
        // so the manager did not open and the window crept a few pixels.
        if (!drag.moved && Math.hypot(dx, dy) > 6) drag.moved = true;
        const maxX = (window.innerWidth || 1280) - 90;
        const maxY = (window.innerHeight || 800) - 60;
        const x = Math.min(maxX, Math.max(-width + 110, drag.originX + dx));
        const y = Math.min(maxY, Math.max(0, drag.originY + dy));
        drag.finalX = x;
        drag.finalY = y;
        // Move with a transform instead of React state: a setState per mousemove
        // re-rendered the whole window (and its blob-backed <img>) on every
        // pixel, which is what made dragging feel sticky.
        if (shellRef.current) {
          shellRef.current.style.transform = `translate3d(${x - panel.x}px, ${y - panel.y}px, 0)`;
        }
      };
      const endDrag = () => {
        const drag = dragRef.current;
        dragRef.current = null;
        if (!drag) return;
        if (shellRef.current) shellRef.current.style.transform = '';
        if (drag.moved) movePanel(panel.id, drag.finalX ?? panel.x, drag.finalY ?? panel.y);
        // A click without movement on the title bar opens the device manager:
        // one large, reliable target instead of a small chevron.
        else setModeOpen(true);
      };

      const [modeOpen, setModeOpen] = useState(false);
      useEffect(() => {
        if (!panel.device) setModeOpen(true);
      }, []);

      /**
       * Local touch feedback.
       *
       * The device only answers after a round trip (100 ms on Android, ~600 ms
       * on iOS because `idb` is a fresh python process per tap), and a swipe is
       * only delivered on release. Without a local echo the mirror feels dead:
       * you press, nothing moves, and you cannot tell whether the press landed.
       * This draws the press immediately and a trail while dragging.
       */
      const [touchEcho, setTouchEcho] = useState(null);
      const feedbackTimer = useRef(null);
      // A failed tap used to be invisible while streaming (the placeholder card
      // only renders when there is no frame), so a dropped input looked like a
      // dead mirror. Surface it briefly instead.
      const [inputNotice, setInputNotice] = useState(null);
      const noticeTimer = useRef(null);
      useEffect(() => () => {
        if (feedbackTimer.current) clearTimeout(feedbackTimer.current);
        if (noticeTimer.current) clearTimeout(noticeTimer.current);
      }, []);

      useEffect(() => {
        if (!inputError) return undefined;
        setInputNotice(inputError);
        if (noticeTimer.current) clearTimeout(noticeTimer.current);
        noticeTimer.current = setTimeout(() => setInputNotice(null), 3200);
        return undefined;
      }, [inputError]);

      const left = panel.x;
      const top = Math.max(8, Math.min(panel.y, viewportHeight - 80));

      const feedback = !panel.device
        ? t('选择一个设备', 'Pick a device')
        : !row
          ? t('这台设备已不在列表中', 'This device is gone')
          : !running
            ? t(`${shortName(row)} 未启动`, `${shortName(row)} is not running`)
            : streamError
              ?? (status === 'connecting' ? t('正在连接…', 'Connecting…') : null)
              ?? t('等待画面…', 'Waiting for a frame…');
      const showPlaceholder = status !== 'live' || !frameUrl;
      const canBoot = Boolean(row) && !running && row.platform === 'ios';
      const canRetry = running && status !== 'connecting' && status !== 'live';
      const bootingThis = Boolean(row) && state.booting === row.device;

      // ---- minimized: a small pill, click to restore
      if (panel.minimized) {
        return h('button', {
          onClick: () => setPanelMinimized(panel.id, false),
          title: t('展开镜像窗口', 'Restore mirror window'),
          style: {
            pointerEvents: 'auto',
            position: 'fixed',
            left: `${left}px`,
            top: `${top}px`,
            zIndex: z,
            display: 'inline-flex',
            alignItems: 'center',
            gap: '6px',
            maxWidth: '230px',
            height: '30px',
            padding: '0 11px 0 9px',
            borderRadius: '15px',
            cursor: 'pointer',
            color: '#f2f2f5',
            fontSize: '11px',
            background: 'rgba(24,24,27,.82)',
            border: '1px solid rgba(255,255,255,.14)',
            boxShadow: '0 8px 24px rgba(0,0,0,.42)',
            backdropFilter: 'blur(18px) saturate(160%)',
            WebkitBackdropFilter: 'blur(18px) saturate(160%)',
          },
        },
          h(Icon, { name: panel.platform === 'ios' ? 'ios' : 'android', size: 13 }),
          h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
            row ? shortName(row) : t('未选择设备', 'No device')),
        );
      }

      const barStyle = {
        ...GLASS,
        display: 'flex',
        alignItems: 'center',
        gap: '3px',
        padding: '4px',
        borderRadius: '12px',
        fontSize: '11px',
      };

      return h('div', {
        ref: shellRef,
        onPointerDownCapture: () => setZ(++topZ),
        style: {
          position: 'fixed',
          left: `${left}px`,
          top: `${top}px`,
          width: `${width}px`,
          zIndex: z,
          display: 'flex',
          flexDirection: 'column',
          pointerEvents: 'auto',
        },
      },

        // ---- title bar: always visible, the whole thing drags
        h('div', {
          onPointerDown: startDrag,
          onPointerMove: moveDrag,
          onPointerUp: endDrag,
          title: t('拖动移动，单击管理设备', 'Drag to move, click to manage devices'),
          style: { ...barStyle, marginBottom: '6px', cursor: 'grab' },
        },
          h('span', {
            style: { display: 'flex', alignItems: 'center', gap: '5px', flex: 1, minWidth: 0, paddingLeft: '5px' },
          },
            h('span', { style: { opacity: 0.7, display: 'flex', flex: '0 0 auto' } },
              h(Icon, { name: panel.platform === 'ios' ? 'ios' : 'android', size: 13 })),
            h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, shortName(row)),
          ),
          h('span', {
            title: status,
            style: {
              width: '6px', height: '6px', borderRadius: '50%', flex: '0 0 auto',
              background: STATUS_TONE[status] ?? STATUS_TONE.idle,
              boxShadow: status === 'live' ? '0 0 7px #30d158aa' : 'none',
            },
          }),
          h('button', {
            'data-action': '1',
            onClick: () => setTextMode((on) => !on),
            onMouseEnter: (e) => hoverable(e, true),
            onMouseLeave: (e) => hoverable(e, false),
            title: t('文字输入', 'Type to device'),
            style: { ...ghostButton, background: textMode ? 'rgba(255,255,255,.16)' : 'transparent' },
          }, h(Icon, { name: 'keyboard', size: 13 })),
          h('button', {
            'data-action': '1',
            onClick: () => setNonce((value) => value + 1),
            onMouseEnter: (e) => hoverable(e, true),
            onMouseLeave: (e) => hoverable(e, false),
            title: t('重连', 'Reconnect'),
            style: ghostButton,
          }, h(Icon, { name: 'refresh', size: 13 })),
          h('button', {
            'data-action': '1',
            onClick: () => setPanelMinimized(panel.id, true),
            onMouseEnter: (e) => hoverable(e, true),
            onMouseLeave: (e) => hoverable(e, false),
            title: t('收成小胶囊', 'Hide to a pill'),
            style: ghostButton,
          }, h(Icon, { name: 'minimize', size: 13 })),
          h('button', {
            'data-action': '1',
            onClick: () => removePanel(panel.id),
            onMouseEnter: (e) => hoverable(e, true),
            onMouseLeave: (e) => hoverable(e, false),
            title: t('关闭这个窗口', 'Close this window'),
            style: ghostButton,
          }, h(Icon, { name: 'close', size: 13 })),
        ),

        // Always-visible device navigation. It lives outside the screen like the
        // rest of the chrome, so it never covers the app, and it is NOT behind
        // the keyboard toggle: back/home are the two most-used controls.
        h('div', {
          style: { ...barStyle, marginBottom: '6px', padding: '3px', justifyContent: 'flex-start' },
        },
          [
            { key: 'BACK', icon: 'back', label: t('返回', 'Back') },
            { key: 'HOME', icon: 'home', label: t('主屏', 'Home') },
            {
              key: 'APP_SWITCH',
              icon: 'recents',
              label: iosDevice ? t('最近任务（iOS 模拟器无此接口）', 'Recents (no iOS API)') : t('最近任务', 'Recents'),
              unsupported: iosDevice,
            },
          ].map((item) => h('button', {
            key: item.key,
            onClick: () => { if (!item.unsupported) sendKey(item.key); },
            disabled: item.unsupported,
            onMouseEnter: (event) => { if (!item.unsupported) hoverable(event, true); },
            onMouseLeave: (event) => hoverable(event, false),
            title: item.label,
            style: {
              ...ghostButton,
              width: '34px',
              height: '26px',
              padding: 0,
              opacity: item.unsupported ? 0.32 : 1,
              cursor: item.unsupported ? 'not-allowed' : 'pointer',
            },
          }, h(Icon, { name: item.icon, size: 15 }))),
          h('span', { style: { flex: 1 } }),
          h('span', { style: { fontSize: '9.5px', opacity: 0.4, paddingRight: '6px' } },
            panel.platform === 'ios' ? 'iOS' : 'Android'),
        ),

        // A dropped stream keeps the last frame on screen, so a frozen picture
        // used to be indistinguishable from a still one. Say it out loud.
        status === 'error' && frameUrl && streamError
          ? h('div', {
              style: {
                ...GLASS,
                marginBottom: '6px',
                padding: '5px 9px',
                borderRadius: '10px',
                fontSize: '10.5px',
                lineHeight: 1.5,
                color: '#ff9a8a',
                borderColor: 'rgba(255,69,58,.35)',
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
              },
            },
              h('span', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                t('连接中断：', 'Disconnected: ') + streamError),
              h('button', {
                onClick: () => setNonce((value) => value + 1),
                onMouseEnter: (event) => hoverable(event, true),
                onMouseLeave: (event) => hoverable(event, false),
                style: { ...ghostButton, border: '1px solid rgba(255,108,92,.45)', padding: '1px 8px', height: '20px' },
              }, t('重试', 'Retry')),
            )
          : null,

        inputNotice
          ? h('div', {
              style: {
                ...GLASS,
                marginBottom: '6px',
                padding: '5px 9px',
                borderRadius: '10px',
                fontSize: '10.5px',
                lineHeight: 1.5,
                color: '#ff9a8a',
                borderColor: 'rgba(255,69,58,.35)',
              },
            }, inputNotice)
          : null,

        textRowVisible
          ? h('div', { style: { ...barStyle, marginBottom: '6px' } },
              h('input', {
                value: text,
                placeholder: t('发给设备…', 'Type to device…'),
                onChange: (event) => setText(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === 'Enter') sendText();
                  if (event.key === 'Escape') event.currentTarget.blur();
                },
                style: {
                  flex: 1, minWidth: 0, height: '24px', padding: '0 8px',
                  borderRadius: '7px', fontSize: '11px', color: 'inherit',
                  background: 'rgba(255,255,255,.08)',
                  border: '1px solid rgba(255,255,255,.12)',
                  outline: 'none',
                },
              }),
              h('button', { onClick: sendText, onMouseEnter: (e) => hoverable(e, true), onMouseLeave: (e) => hoverable(e, false), title: t('发送', 'Send'), style: ghostButton }, h(Icon, { name: 'send', size: 13 })),
            )
          : null,

        // ---- screen, or the device manager in the same footprint
        modeOpen
          ? h('div', {
              style: {
                width: '100%',
                // Content-sized, capped: the list is often two rows, and forcing
                // it into a phone-shaped box left a huge void with the footer
                // jammed against the bottom edge.
                maxHeight: `min(56vh, ${Math.round(viewportHeight - 190)}px)`,
                display: 'flex',
                borderRadius: '22px',
                overflow: 'hidden',
                boxShadow: '0 26px 70px -18px rgba(0,0,0,.7), inset 0 0 0 1px rgba(255,255,255,.09)',
              },
            }, h(DeviceManager, { panel, onClose: () => setModeOpen(false), onAddWindow }))
          : h('div', {
              onFocusCapture: () => setTyping(true),
              onBlurCapture: () => setTyping(false),
              style: {
                position: 'relative',
                width: '100%',
                aspectRatio: String(aspect),
                borderRadius: '22px',
                overflow: 'hidden',
                background: '#0b0b0d',
                boxShadow: '0 26px 70px -18px rgba(0,0,0,.7), inset 0 0 0 1px rgba(255,255,255,.09)',
                touchAction: 'none',
                cursor: status === 'live' ? 'crosshair' : 'default',
                userSelect: 'none',
              },
            },
              frameUrl
                ? h('img', {
                    ref: imgRef,
                    src: frameUrl,
                    alt: t('设备画面', 'Device screen'),
                    draggable: false,
                    style: { width: '100%', height: '100%', objectFit: 'contain', display: 'block' },
                    onLoad: (event) => {
                      const { naturalWidth, naturalHeight } = event.target;
                      if (naturalWidth && naturalHeight) setMeasuredAspect(naturalWidth / naturalHeight);
                    },
                    onPointerDown: onScreenPointerDown,
                    onPointerMove: onScreenPointerMove,
                    onPointerUp: onScreenPointerUp,
                    onPointerCancel: onScreenPointerUp,
                  })
                : null,
              showPlaceholder
                ? h('div', {
                    style: {
                      position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
                      alignItems: 'center', justifyContent: 'center', gap: '10px', padding: '20px',
                      textAlign: 'center', color: '#e9e9ee',
                      background: frameUrl ? 'rgba(8,8,10,.72)' : 'radial-gradient(120% 90% at 50% 0%, #1b1b20 0%, #0b0b0d 70%)',
                    },
                  },
                    h('span', {
                      style: {
                        width: '7px', height: '7px', borderRadius: '50%',
                        background: STATUS_TONE[status] ?? STATUS_TONE.idle,
                        boxShadow: status === 'live' ? '0 0 8px #30d158aa' : 'none',
                      },
                    }),
                    h('span', { style: { fontSize: '11.5px', opacity: 0.72, lineHeight: 1.6, maxWidth: '220px' } }, feedback),
                    state.bootError ? h('span', { style: { fontSize: '10px', color: '#ff453a', maxWidth: '230px', lineHeight: 1.5 } }, state.bootError) : null,
                    inputError ? h('span', { style: { fontSize: '10px', color: '#ff453a', maxWidth: '230px', lineHeight: 1.5 } }, inputError) : null,
                    h('div', { style: { display: 'flex', gap: '6px' } },
                      canBoot
                        ? h('button', {
                            onClick: () => { bootDevice(row).then((ok) => { if (ok) setNonce((value) => value + 1); }); },
                            disabled: bootingThis,
                            onMouseEnter: (e) => hoverable(e, true),
                            onMouseLeave: (e) => hoverable(e, false),
                            style: { ...ghostButton, ...GLASS, padding: '5px 12px', fontSize: '11px', opacity: bootingThis ? 0.6 : 1 },
                          }, bootingThis ? t('启动中…', 'Booting…') : t('启动并连接', 'Boot and connect'))
                        : (!row || !panel.device) || canRetry
                          ? h('button', {
                              onClick: () => setModeOpen(true),
                              onMouseEnter: (e) => hoverable(e, true),
                              onMouseLeave: (e) => hoverable(e, false),
                              style: { ...ghostButton, ...GLASS, padding: '5px 12px', fontSize: '11px' },
                            }, (!row || !panel.device) ? t('选择设备', 'Pick a device') : t('管理设备', 'Manage devices'))
                          : null,
                    ),
                  )
                : null,

              // Touch echo: drawn above the frame so a press always produces an
              // immediate visible answer on the cursor's own frame.
              touchEcho
                ? h('div', { style: { position: 'absolute', inset: 0, pointerEvents: 'none' } },
                    touchEcho.kind === 'swipe'
                      ? h('svg', {
                          viewBox: '0 0 100 100',
                          preserveAspectRatio: 'none',
                          style: { position: 'absolute', inset: 0, width: '100%', height: '100%' },
                        },
                          h('line', {
                            x1: touchEcho.x * 100, y1: touchEcho.y * 100,
                            x2: touchEcho.x2 * 100, y2: touchEcho.y2 * 100,
                            stroke: 'rgba(255,255,255,.8)',
                            strokeWidth: 1.4,
                            strokeDasharray: '3 3',
                            vectorEffect: 'non-scaling-stroke',
                          }),
                        )
                      : null,
                    h('span', {
                      style: {
                        position: 'absolute',
                        left: `${touchEcho.x * 100}%`,
                        top: `${touchEcho.y * 100}%`,
                        width: touchEcho.kind === 'release' ? '26px' : '15px',
                        height: touchEcho.kind === 'release' ? '26px' : '15px',
                        marginLeft: touchEcho.kind === 'release' ? '-13px' : '-7.5px',
                        marginTop: touchEcho.kind === 'release' ? '-13px' : '-7.5px',
                        borderRadius: '50%',
                        border: '1.5px solid rgba(255,255,255,.9)',
                        background: 'rgba(255,255,255,.22)',
                        opacity: touchEcho.kind === 'release' ? 0.35 : 0.95,
                        transition: 'width .2s ease, height .2s ease, margin .2s ease, opacity .2s ease',
                      },
                    }),
                  )
                : null,
            ),
      );
    }

    // -----------------------------------------------------------------------
    // The overlay: every window of the active session
    // -----------------------------------------------------------------------

    function FloatingLayer() {
      const state = useStore();
      const sessionId = useSessionId();

      // Re-runs on every conversation switch. Each session gets its own window
      // set, its own device binding and its own saved geometry; the streams of
      // the outgoing session are torn down by their components unmounting.
      useEffect(() => {
        if (sessionId === undefined) return undefined;
        activateSession(sessionId);
        (async () => {
          await loadDevices();
          // Deliberately NO auto-open. A mirror window starts a capture pipeline
          // and, for a stopped simulator, offers to boot it; that must be the
          // user's decision, not a side effect of opening a conversation. An
          // empty session shows the dashed "设备镜像 +" pill instead.
        })();
        return undefined;
      }, [sessionId]);

      // Which device this session is mirroring, reported to the Host so it is
      // observable (and so a future agent tool can act on it) instead of living
      // only in the browser's localStorage.
      useEffect(() => {
        if (sessionId === undefined) return undefined;
        const bound = state.panels
          .filter((panel) => panel.device)
          .map((panel) => `${panel.platform}:${panel.device}`)
          .join(',');
        report('bind', { detail: `${sessionId ?? 'none'}|${bound}`.slice(0, 200) });
        return undefined;
      }, [sessionId, state.panels]);

      const addWindow = () => addPanel();

      // No perpetual "+" button: devices and extra windows are created from
      // inside a window. This pill only exists while the session has none.
      if (!state.panels.length) {
        return h('div', { style: { pointerEvents: 'none' } },
          h('button', {
            onClick: addWindow,
            title: t('在本会话打开一个设备镜像窗口', 'Open a mirror window in this session'),
            style: {
              pointerEvents: 'auto',
              position: 'fixed',
              right: `${EDGE}px`,
              bottom: `${EDGE}px`,
              display: 'inline-flex',
              alignItems: 'center',
              gap: '7px',
              height: '34px',
              padding: '0 13px 0 11px',
              borderRadius: '17px',
              cursor: 'pointer',
              color: '#f2f2f5',
              fontSize: '11.5px',
              background: 'rgba(26,26,29,.72)',
              border: '1px dashed rgba(255,255,255,.28)',
              boxShadow: '0 8px 26px rgba(0,0,0,.42)',
              backdropFilter: 'blur(22px) saturate(180%)',
              WebkitBackdropFilter: 'blur(22px) saturate(180%)',
              zIndex: 100000,
            },
          },
            h(Icon, { name: 'android', size: 14 }),
            t('设备镜像', 'Device Mirror'),
            h(Icon, { name: 'plus', size: 13 }),
          ),
        );
      }

      return h('div', { style: { pointerEvents: 'none' } },
        state.panels.map((panel) => h(DevicePanel, { key: panel.id, panel, onAddWindow: addWindow })),
      );
    }

    // -----------------------------------------------------------------------
    // Plugin
    // -----------------------------------------------------------------------

    return {
      inject: ['slots'],
      /** Exposed for test/client.test.mjs. */
      __test: {
        createMultipartParser,
        store,
        components: { DevicePanel, DeviceManager, FloatingLayer },
        actions: {
          addPanel, removePanel, movePanel, setPanelDevice, setPanelMinimized,
          readPanels, persistPanels, loadDevices, activateSession, bootAvd, createAvd,
        },
        helpers: { readSessionId, panelsKey },
      },
      apply(ctx) {
        // Captured so the overlay can resolve `ctx.sessions.list` lazily; reading
        // it inside apply would race a service that publishes later.
        pluginCtx = ctx;
        let locale;
        try {
          locale = ctx.get('locale');
        } catch {
          locale = undefined;
        }
        readLocale(locale);
        if (locale && typeof locale.subscribe === 'function') {
          ctx.effect(() => locale.subscribe(() => readLocale(locale)));
        }

        // One slot, always: the frame-wide overlay layer, which is click-through
        // by default so N windows never block the app underneath.
        try {
          ctx.slots.inject('shell.overlay', () => ctx.slots.register({
            name: 'shell.overlay',
            id: 'device-mirror-float',
            order: 60,
            label: () => t('设备镜像浮窗', 'Device mirror overlay'),
          }, FloatingLayer));
          report('ready', { surfaces: 'overlay' });
        } catch (error) {
          report('overlay-failed', { detail: error instanceof Error ? error.message : String(error) });
        }
      },
    };
  },
});

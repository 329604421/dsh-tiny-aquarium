import React, { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { effectiveLight, normalizeConfig, ZOOM } from './core.js';
import { createTokenLedger, emptyLedgerSnapshot, isLedgerState, totalOf, TOKEN_UNIT } from './token-ledger.js';
import { zh, en } from './locales.js';
import styles from './aquarium.css';
import { FEED_CURSOR } from './feed-cursor.js';
import manifest from '../presets.json';
import { createCatalog, displayNameOf, STANDARD_FEEDING } from './custom-catalog.js';
import { buildPrompt, handoffBlockers, BLOCKER_KEYS, DIMENSIONS } from './customize.js';

export const inject = ['slots', 'theme', 'configForms', 'locale', 'sessions', 'uiWorkspace', 'workspaces'];

const NS = 'eco-aquarium';
/** 清单是 P5 起唯一的事实来源：内置与定制资产走同一份数据。 */
const catalog = createCatalog(manifest.presets);

/** One sample per minute is enough for a counter that only feeds fish. */
const POLL_MS = 60_000;
/** A config write churns the profile file, so background progress lands every five minutes. */
const PERSIST_MS = 5 * 60_000;

/** Localized text; replaced by the host binding inside apply(). */
let translate = key => zh[key] ?? en[key] ?? key;

/**
 * The sidebar glyph keeps the geometry of the former floating entry — clear
 * glass, one water line, one clip lamp clamped on the rim — redrawn for an
 * 18px navigation slot: one outline, one wave, one bracket, one pellet.
 * Stroked in currentColor so the host owns hover/active colors.
 */
export function AquariumGlyph({ size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true" focusable="false" style={{ display: 'block' }}>
      <path d="M4.5 6.8h15v10a3 3 0 0 1-3 3h-9a3 3 0 0 1-3-3Z" />
      <path d="M5 11.6c2.4-1.7 4.8 1.7 7.2 0s4.6-1.2 6.6 0" />
      <path d="M12.8 2.8h6.5v4" />
      <circle cx="8.4" cy="16.2" r="0.9" />
    </svg>
  );
}

/** `12.4M` — the only precision these numbers need. */
function formatTokens(value) {
  const tokens = Number.isFinite(value) ? value : 0;
  return `${(tokens / 1e6).toFixed(1)}M`;
}

function formatSince(epochAt) {
  if (!Number.isFinite(epochAt) || epochAt <= 0) return '—';
  const date = new Date(epochAt);
  const pad = value => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * Two-step confirmation for an irreversible action, without `window.confirm`:
 * the first click arms it, the label counts down, and it disarms itself.
 */
function useArmedAction(action, seconds = 5) {
  const [left, setLeft] = useState(0);
  const timeout = useRef(null);
  const interval = useRef(null);
  const cancel = () => {
    clearTimeout(timeout.current);
    clearInterval(interval.current);
    setLeft(0);
  };
  useEffect(() => cancel, []);
  const run = () => {
    if (left > 0) { cancel(); action(); return; }
    setLeft(seconds);
    clearTimeout(timeout.current);
    clearInterval(interval.current);
    timeout.current = setTimeout(cancel, seconds * 1000);
    interval.current = setInterval(() => setLeft(value => Math.max(0, value - 1)), 1000);
  };
  return { armed: left > 0, left, run, cancel };
}

function ToolIcon({ kind }) {
  return (
    <svg viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {kind === 'light' && <><path d="M9 14a7 7 0 1 1 14 0c0 3-4 5-4 8h-6c0-3-4-5-4-8ZM13 26h6M14 29h4M16 1v2M3 7l2 2M29 7l-2 2" /></>}
      {kind === 'food' && <><path d="M10 5h12v4H10zM9 9h14v18H9zM12 2h8M12 16h8M12 22h5" /><circle cx="24" cy="4" r="1" /><circle cx="27" cy="10" r=".8" /></>}
      {kind === 'close' && <path d="m7 7 18 18M25 7 7 25" />}
    </svg>
  );
}

/* The floating view is owned by one store so the customize page can open it. */
let aquariumOpen = false;
const openListeners = new Set();
export function setAquariumOpen(value) {
  if (aquariumOpen === value) return;
  aquariumOpen = value;
  openListeners.forEach(listener => listener());
}
const subscribeOpen = listener => { openListeners.add(listener); return () => openListeners.delete(listener); };
const readOpen = () => aquariumOpen;

export function apply(ctx) {
  if (typeof ctx.locale?.bind === 'function') translate = ctx.locale.bind(NS);

  ctx.effect(() => ctx.locale.register(NS, { zh, en }));
  ctx.effect(() => {
    const style = document.createElement('style');
    style.dataset.ecoAquarium = '';
    style.textContent = styles;
    document.head.append(style);
    return () => style.remove();
  });

  const form = ctx.configForms.get(NS);
  const subscribeConfig = listener => form.subscribe(listener);
  const getConfig = () => form.getSnapshot();

  const themeListeners = new Set();
  let dark = ctx.theme.getTheme().active.colorScheme === 'dark';
  ctx.on('theme/change', snapshot => {
    dark = snapshot.active.colorScheme === 'dark';
    themeListeners.forEach(listener => listener());
  });
  const subscribeTheme = listener => { themeListeners.add(listener); return () => themeListeners.delete(listener); };

  if (globalThis.__DSH_AQUARIUM_TEST__) {
    Object.assign(globalThis.__DSH_AQUARIUM_TEST__, {
      readConfig: getConfig,
      writeConfig: (ops, revision) => form.mutate(ops, revision),
      setTheme: id => ctx.theme.setTheme(id),
      readTheme: () => ctx.theme.getTheme(),
      readLedger: () => readLedger(),
      resetLedger: () => resetTokenStats(),
      sampleTokens: () => sampleSessions(),
      pollLedger: () => { poll(); return readLedger(); },
      customPrompt: id => customizationPrompt(id),
      customStart: id => startCustomization(id),
    });
  }

  /* --------------------------------------------------------- token ledger */
  /*
   * One ledger per plugin instance. The client is the only writer: it samples
   * `ctx.sessions.list` once a minute, folds the totals in, and persists the
   * whole payload through the plugin config (the host profile file), because
   * the desktop window's origin changes with its runtime port and would reset
   * any browser-side storage.
   */
  let ledger = null;
  let ledgerSnapshot = emptyLedgerSnapshot();
  const ledgerListeners = new Set();
  const subscribeLedger = listener => { ledgerListeners.add(listener); return () => ledgerListeners.delete(listener); };
  const readLedger = () => ledgerSnapshot;
  function publishLedger() {
    if (!ledger) return;
    const next = ledger.snapshot();
    const current = ledgerSnapshot;
    if (current.epochAt === next.epochAt && current.observed === next.observed && current.pending === next.pending
      && current.foodQueue === next.foodQueue && current.earned === next.earned && current.exchanges === next.exchanges
      && current.delivered === next.delivered) return;
    ledgerSnapshot = next;
    for (const listener of [...ledgerListeners]) listener();
  }

  /** Latest exchange, so the open view can announce it. */
  let gainNotice = null;
  const noticeListeners = new Set();
  const subscribeGain = listener => { noticeListeners.add(listener); return () => noticeListeners.delete(listener); };
  const readGain = () => gainNotice;
  function noteGain(count) {
    gainNotice = { count, at: Date.now() };
    for (const listener of [...noticeListeners]) listener();
  }

  // The scene is created inside the view, but the feeder lives out here.
  const sceneRef = { current: null };

  let started = false;
  let pollTimer = null;
  let startTimer = null;
  let lastPersistAt = 0;
  let lastPayload = null;
  let persistInFlight = false;
  let persistAgain = false;

  /** Read every session's cumulative usage from the list snapshot. */
  function sampleSessions() {
    const list = ctx.sessions?.list;
    if (!list || typeof list.getSnapshot !== 'function') return null;
    const state = list.getSnapshot();
    const ids = Array.isArray(state?.ids) ? state.ids : [];
    const entries = [];
    for (const id of ids) {
      const usage = state.byId?.[id]?.projectionValues?.tokenUsage
        ?? state.projectionsBySession?.[id]?.values?.tokenUsage;
      const tokens = totalOf(usage);
      if (tokens !== undefined) entries.push({ id, tokens });
    }
    return { entries, ids };
  }

  /**
   * Persist baselines and balances in one atomic write. Throttled unless the
   * caller says the numbers must survive a crash.
   */
  function persist(force) {
    if (!ledger) return;
    const view = form.getSnapshot();
    if (!view?.writable || view.value === undefined) return;
    const payload = ledger.serialize();
    const encoded = JSON.stringify(payload);
    if (!force && encoded === lastPayload) return;
    const now = Date.now();
    if (!force && now - lastPersistAt < PERSIST_MS) return;
    if (persistInFlight) { if (force) persistAgain = true; return; }
    persistInFlight = true;
    lastPersistAt = now;
    Promise.resolve()
      .then(() => form.mutate([{ op: 'set', path: ['ledger'], value: payload }]))
      .then(ok => {
        if (ok) lastPayload = encoded;
        else lastPersistAt = 0;
      })
      .catch(() => { lastPersistAt = 0; })
      .finally(() => {
        persistInFlight = false;
        if (persistAgain) { persistAgain = false; persist(true); }
      });
  }

  /**
   * 鱼食库存由账本持有，手动投喂是唯一的消耗入口。场景在落食前调用这里，
   * 拿不到鱼食就不落食——「投喂一次，库存少一批」才对得上，
   * 徽章与定制页的「待投喂」也才有意义。
   */
  function takeFood(want) {
    if (!ledger) return 0;
    // 库存的单位是「勺」：一次点击舀一勺，落几粒由场景决定（LIMITS.batch）。
    const count = ledger.takeScoops(want);
    if (count > 0) publishLedger();
    return count;
  }

  function poll() {
    if (!ledger) return;
    const sample = sampleSessions();
    if (!sample || sample.ids.length === 0) { publishLedger(); return; }
    const { gained } = ledger.observe(sample.entries);
    ledger.prune(sample.ids);
    publishLedger();
    if (gained > 0) { noteGain(gained); persist(true); } else persist(false);
  }

  /**
   * First sample only records baselines, so nothing before the install counts.
   * Reset replays exactly this sequence: clear the books, then re-baseline.
   */
  function startLedger() {
    if (started) return;
    const view = form.getSnapshot();
    const stored = view?.value?.ledger;
    ledger = createTokenLedger(isLedgerState(stored) ? stored : null);
    started = true;
    clearTimeout(startTimer);
    startTimer = null;
    publishLedger();
    poll();
    clearInterval(pollTimer);
    pollTimer = setInterval(poll, POLL_MS);
    pollTimer?.unref?.();
  }

  function resetTokenStats() {
    if (!ledger) return false;
    ledger.reset();
    publishLedger();
    poll();
    persist(true);
    return true;
  }

  /* ------------------------------------------------ P5 customization factory */
  /*
   * 定制入口只做四件事：校验、快照现状、拼提示词、把草稿交给新会话。
   * 资产的生产发生在用户自己的会话里（模型 + skill），插件不持有凭证、不代发请求。
   */
  function fishSummary(config) {
    const builtin = translate('fishBuiltinSummary');
    const custom = catalog.sanitizeCustomIds(config.customFishIds, 'fish')
      .map(id => catalog.getPreset(id))
      .filter(Boolean)
      .map(preset => `${displayNameOf(preset, translate)} ×${preset.params?.count ?? 2}`);
    return custom.length ? `${builtin}；${translate('fishCustomPrefix')} ${custom.join('、')}` : builtin;
  }

  /*
   * 现状不再写进提示词：`/skill` token 会把核心 skill 正文注入本步，正文里已经
   * 写明「开工会先读 presets.json」。这里只负责拼那条短草稿。
   */
  /** 生成提示词但不发送：预览与测试都走这里，保证提示词可检查。 */
  function customizationPrompt(dimensionId) {
    return buildPrompt(dimensionId, { now: Date.now() });
  }

  /**
   * 交接：关闭设置面板（导航到会话即替换主视图）、把提示词作为草稿追加。
   * 不自动发送——用户要自己补参考图与描述。
   */
  function startCustomization(dimensionId) {
    const blockers = handoffBlockers({ uiWorkspace: ctx.uiWorkspace, workspaces: ctx.workspaces });
    if (blockers.length) return { ok: false, reason: BLOCKER_KEYS[blockers[0]] ?? 'customFailed' };
    const prompt = customizationPrompt(dimensionId);
    try {
      ctx.uiWorkspace.startSession(undefined, { prompt: prompt.text, whenDraftExists: 'append' });
      return { ok: true, batchId: prompt.batchId };
    } catch {
      return { ok: false, reason: 'customFailed' };
    }
  }

  ctx.effect(() => {
    if (form.getSnapshot()?.value !== undefined) startLedger();
    else startTimer = setTimeout(startLedger, 4000);
    startTimer?.unref?.();
    // The fallback timer can start the ledger before the form is readable; the
    // first readable snapshot then flushes what it has.
    const unsubscribe = form.subscribe(() => {
      if (!started) startLedger();
      else persist(false);
    });
    // A hidden page throttles timers, so catching up on return is the only way
    // to keep a ten-minute gap from turning into a ten-minute hole.
    const onVisibility = () => {
      if (typeof document === 'undefined' || document.visibilityState !== 'visible') { persist(true); return; }
      clearInterval(pollTimer);
      pollTimer = setInterval(poll, POLL_MS);
      pollTimer?.unref?.();
      poll();
    };
    if (typeof document !== 'undefined') document.addEventListener?.('visibilitychange', onVisibility);
    return () => {
      clearTimeout(startTimer);
      clearInterval(pollTimer);
      pollTimer = null;
      if (typeof document !== 'undefined') document.removeEventListener?.('visibilitychange', onVisibility);
      unsubscribe();
      persist(true);
    };
  });

  /* ------------------------------------------------------------ play view */
  function PlayView({ usePanelInfo, t: hostT }) {
    const t = hostT || translate;
    const readPanel = usePanelInfo || (() => undefined);
    const open = useSyncExternalStore(subscribeOpen, readOpen, readOpen);
    const panel = readPanel(info => info?.activePanelId);
    const isDark = useSyncExternalStore(subscribeTheme, () => dark, () => dark);
    const configView = useSyncExternalStore(subscribeConfig, getConfig, getConfig);
    const { config, repaired } = normalizeConfig(configView.value);
    const [feeding, setFeeding] = useState(false);
    const [override, setOverride] = useState(null);
    const [attempt, setAttempt] = useState(0);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [message, setMessage] = useState(null);
    const [stats, setStats] = useState({ food: 0, fps: 0 });
    const [zoom, setZoomValue] = useState(ZOOM.min);
    const ledgerView = useSyncExternalStore(subscribeLedger, readLedger, readLedger);
    const gain = useSyncExternalStore(subscribeGain, readGain, readGain);
    const [popped, setPopped] = useState(false);
    const stage = useRef(null);
    const dialog = useRef(null);
    const entry = useRef(null);
    const scene = sceneRef;
    const returnFocus = useRef(null);
    const toastTimer = useRef(null);
    const mounted = useRef(true);
    const blankDown = useRef(null);
    const maxed = useRef(false);
    const shownFood = useRef(0);
    const shownGain = useRef(0);
    const popTimer = useRef(null);
    const resetArm = useArmedAction(() => { resetTokenStats(); announce('tokenResetDone'); });
    // The water line is the conversion progress: full exactly at 5M tokens.
    const waterLevel = Math.min(1, Math.max(0, ledgerView.pending / (ledgerView.unit || TOKEN_UNIT)));
    // SVG gradient ids must be unique per instance and CSS-safe.
    const waterKey = `aqw${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
    const lightOn = effectiveLight(config.lightMode, isDark, override);
    const zoomProgress = (zoom - ZOOM.min) / (ZOOM.max - ZOOM.min);
    // Zoomed views dissolve into the veil at a circular boundary instead of
    // hard-clipping against the window edges.
    const lens = zoomProgress > 0.002
      ? `radial-gradient(circle 58vh at 50% 50%, #000 ${(100 - 48 * zoomProgress).toFixed(1)}%, transparent 100%)`
      : undefined;
    const live = useRef({});
    live.current = { lightOn, isDark, config, t };

    useEffect(() => () => {
      mounted.current = false;
      clearTimeout(toastTimer.current);
      clearTimeout(popTimer.current);
    }, []);

    function toast(payload) {
      clearTimeout(toastTimer.current);
      setMessage(payload);
      toastTimer.current = setTimeout(() => { if (mounted.current) setMessage(null); }, 3200);
    }
    function announce(key) { toast({ key }); }
    /** Localized fragments only: the host dictionary has no interpolation. */
    function announceText(text) { toast({ text }); }
    function close() {
      setAquariumOpen(false);
      setFeeding(false);
      setOverride(null);
    }
    function openAquarium() {
      returnFocus.current = document.activeElement;
      setFeeding(false);
      setOverride(null);
      setMessage(null);
      setError('');
      setAquariumOpen(true);
    }

    // An exchange is worth one short line; it never interrupts the scene.
    useEffect(() => {
      if (!gain || gain.at === shownGain.current) return;
      shownGain.current = gain.at;
      announceText(`+${gain.count} ${t('tokenPellets')}`);
    }, [gain]);

    // Pop the badge only when food arrived, not on every re-render.
    useEffect(() => {
      const count = ledgerView.foodQueue;
      if (count > shownFood.current) {
        setPopped(true);
        clearTimeout(popTimer.current);
        popTimer.current = setTimeout(() => { if (mounted.current) setPopped(false); }, 1100);
      }
      shownFood.current = count;
    }, [ledgerView.foodQueue]);

    useEffect(() => { if (open) close(); }, [panel]);
    useEffect(() => {
      if (!open) return;
      dialog.current?.focus();
      return () => {
        const previous = returnFocus.current;
        queueMicrotask(() => {
          if (previous?.isConnected) previous.focus({ preventScroll: true });
          else entry.current?.focus({ preventScroll: true });
        });
      };
    }, [open]);

    useEffect(() => {
      if (!open) return;
      let cancelled = false;
      let instance;
      setLoading(true);
      setError('');
      setStats({ food: 0, fps: 0 });
      setZoomValue(ZOOM.min);
      // DSH owns the package-local loader; native import URLs cannot serve chunks on Desktop.
      require.async('./client.scene.js').then(mod => {
        if (cancelled) return;
        const current = live.current;
        instance = mod.createScene(stage.current, {
          dark: current.isDark, lightOn: current.lightOn, quality: current.config.qualityMode,
          scapePresetId: current.config.scapePresetId, tankPresetId: current.config.tankPresetId,
          lampPresetId: current.config.lampPresetId, customFishIds: current.config.customFishIds,
          feedingPresetId: current.config.feedingPresetId, canvasLabel: current.t('sceneLabel'),
          onClose: close,
          onTap: () => announce('tapped'),
          takeFood: want => takeFood(want),
          onFeed: (result, count) => {
            // 场景拒收（缸满 / 150ms 内连点）就要把刚扣的鱼食退回队列，否则白白少一批。
            if (result !== 'added' && result !== 'empty') { ledger?.refund(count); publishLedger(); }
            if (result === 'empty') announce('empty');
            else if (result === 'full') announce('full');
            else if (result === 'added') announce('added');
            persist(true);
          },
          onStats: next => {
            if (cancelled) return;
            setStats(next);
          },
          onZoom: value => {
            if (cancelled) return;
            setZoomValue(value);
            if (value >= ZOOM.max - 0.01 && !maxed.current) announce('zoomMax');
            maxed.current = value >= ZOOM.max - 0.01;
          },
          onQuality: () => announce('degraded'),
          onContext: state => {
            if (cancelled) return;
            if (state === 'restored') { setFeeding(false); setAttempt(n => n + 1); }
            else if (state === 'timeout') setError('contextTimeout');
            else setMessage({ key: 'contextLost' });
          },
        });
        scene.current = instance;
        setLoading(false);
        if (repaired.length) announce('repaired');
        else if (!configView.value) announce('configPending');
        // Opt-in local testing seam; absent from normal sessions and no remote logging.
        if (globalThis.__DSH_AQUARIUM_TEST__) globalThis.__DSH_AQUARIUM_TEST__.scene = instance;
      }).catch(err => {
        if (!cancelled) { setError(String(err?.message || err)); setLoading(false); }
      });
      return () => {
        cancelled = true;
        instance?.dispose();
        if (scene.current === instance) scene.current = null;
        if (globalThis.__DSH_AQUARIUM_TEST__) globalThis.__DSH_AQUARIUM_TEST__.scene = null;
      };
    }, [open, attempt, config.scapePresetId, config.tankPresetId, config.lampPresetId,
      config.customFishIds.join('|')]);

    useEffect(() => { scene.current?.setLighting(isDark, lightOn); }, [isDark, lightOn]);
    useEffect(() => { scene.current?.setQuality(config.qualityMode); }, [config.qualityMode]);
    // 投喂习惯只改行为权重，不重建场景：重建会让鱼瞬移，也会打断进行中的抢食。
    useEffect(() => {
      const { params } = catalog.feedingParamsOf(config.feedingPresetId);
      scene.current?.setFeedingPreset(params);
    }, [config.feedingPresetId]);
    useEffect(() => { scene.current?.setFeeding(feeding); }, [feeding]);
    useEffect(() => { setFeeding(false); }, [config.scapePresetId]);

    // Wheel zoom belongs to the whole modal, so the app behind never scrolls.
    useEffect(() => {
      if (!open) return;
      const node = dialog.current;
      if (!node) return;
      const onWheel = event => {
        event.preventDefault();
        scene.current?.zoomBy(-event.deltaY * 0.0016);
      };
      node.addEventListener('wheel', onWheel, { passive: false });
      return () => node.removeEventListener('wheel', onWheel);
    }, [open]);

    function onKeyDown(event) {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        if (feeding) setFeeding(false); else close();
      }
      if (event.key === '+' || event.key === '=') { event.preventDefault(); scene.current?.zoomBy(0.18); }
      if (event.key === '-' || event.key === '_') { event.preventDefault(); scene.current?.zoomBy(-0.18); }
      if (event.key === 'Tab') {
        const nodes = [...dialog.current.querySelectorAll('button:not(:disabled), select:not(:disabled), summary')];
        const first = nodes[0], last = nodes.at(-1);
        if (!nodes.length) { event.preventDefault(); return; }
        if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) {
          event.preventDefault(); last.focus();
        } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog.current)) {
          event.preventDefault(); first.focus();
        }
      }
    }

    if (!open) return <button ref={entry} className="dsh-aq-entry" aria-label={t('title')}
      title={`${t('title')} · ${t('tokenUsage')} ${formatTokens(ledgerView.observed)} · ${t('tokenQueue')} ${ledgerView.foodQueue}`
        + ` · ${t('tokenNext')} ${formatTokens(ledgerView.toNextUnit)}`}
      onClick={openAquarium} data-level={waterLevel > 0.999 ? 'full' : 'filling'}>
      {/* The button itself is the tank: water fills the whole circle behind the
          logo. The crest is part of the same filled path — a second translucent
          layer would double up on alpha and leave a hard seam at the surface. */}
      <span className="dsh-aq-entry-fill" aria-hidden="true">
        <svg className="dsh-aq-entry-water" viewBox="0 0 100 100" preserveAspectRatio="none"
          style={{ transform: `translateY(${((1 - waterLevel) * 100).toFixed(2)}%)`, opacity: waterLevel < 0.004 ? 0 : 1 }}>
          <defs>
            <linearGradient id={`${waterKey}-body`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" style={{ stopColor: 'var(--aq-entry-water)', stopOpacity: 0.32 }} />
              <stop offset="1" style={{ stopColor: 'var(--aq-entry-water)', stopOpacity: 0.58 }} />
            </linearGradient>
          </defs>
          <path d="M0 2.5q12.5 5 25 0t25 0 25 0 25 0V100H0Z" fill={`url(#${waterKey}-body)`} />
        </svg>
      </span>
      <AquariumGlyph size={30} />
      {ledgerView.foodQueue > 0 && <span className="dsh-aq-entry-badge" data-pop={popped ? 'true' : 'false'}>
        {ledgerView.foodQueue}
      </span>}
    </button>;

    return <section ref={dialog} className="dsh-aq-overlay" data-dark={isDark} data-feeding={feeding} role="dialog" aria-modal="true"
      aria-label={t('title')} tabIndex={-1} onKeyDown={onKeyDown}
      style={{ cursor: feeding ? FEED_CURSOR : undefined }}
      onPointerDown={event => {
        if (event.button === 0 && event.target === event.currentTarget) blankDown.current = { x: event.clientX, y: event.clientY };
        else blankDown.current = null;
      }}
      onPointerUp={event => {
        const start = blankDown.current;
        blankDown.current = null;
        if (event.button === 0 && start && event.target === event.currentTarget &&
          Math.hypot(event.clientX - start.x, event.clientY - start.y) < 6) close();
      }}>
      {/* 标题区只有名字与一句话：相位/版本这类开发期标记不进界面。 */}
      <header className="dsh-aq-heading"><h2>{t('title')}</h2><p>{t('subtitle')}</p></header>
      <button className="dsh-aq-close" aria-label={t('close')} title={t('close')} onClick={close}><ToolIcon kind="close" /></button>
      <div ref={stage} className="dsh-aq-stage"
        style={lens ? { maskImage: lens, WebkitMaskImage: lens } : undefined} />
      {/* Circular blurred boundary that fades in as the view approaches max zoom. */}
      <div className="dsh-aq-zoom-guide" aria-hidden="true"
        style={{ '--zoom-progress': zoomProgress.toFixed(3) }} />
      <div className="dsh-aq-caption" style={{ opacity: Math.max(0.12, 1 - zoomProgress * 1.15) }}><strong>{t('tank')}</strong>{t('dimensions')}<br />{t('noFish')}</div>
      {/* 出处说明：谁做的这一缸，以及定制时该换更强的模型。位置固定，不随放大淡出。 */}
      <p className="dsh-aq-credit">{t('credit')}</p>
      {/* 缸内颗粒数与库存是两个数：前者正在被吃、会自己掉到 0，后者才是还能舀几勺。
          以前只显示前者，用户会把「缸里还有 4 粒」当成「库存 4 粒」。 */}
      {/* 角标只报两个用户看得懂的数：水里还剩几粒、罐里还能舀几勺。
          FPS 是开发期的调试读数，不放在这行。 */}
      <div className="dsh-aq-badge">{t('stats')} {stats.food} {t('particles')} / 100 · {t('foodStock')} {ledgerView.foodQueue} {t('scoop')}</div>
      {loading && <div className="dsh-aq-loading" role="status">{t('loading')}</div>}
      {error && <div className="dsh-aq-error" role="alert">
        <h3>{t('failure')}</h3><p>{t(error === 'contextTimeout' ? error : 'failureHint')}</p>
        <button onClick={() => { setMessage(null); setFeeding(false); setAttempt(n => n + 1); }}>{t('retry')}</button>
        <button onClick={close}>{t('close')}</button>
        <details><summary>{t('errorDetail')}</summary><pre>{error}</pre></details>
      </div>}
      <div className="dsh-aq-status" role="status" aria-live="polite">
        {message ? (typeof message === 'string' ? t(message) : message.text ?? t(message.key)) : feeding ? t('feedHint') : ''}
      </div>
      <div className="dsh-aq-tools" role="group" aria-label={t('title')}>
        <button className="dsh-aq-tool" disabled={loading || !!error} aria-pressed={lightOn}
          onClick={() => setOverride(!lightOn)} aria-label={t('light')}>
          <ToolIcon kind="light" /><span><strong>{t(lightOn ? 'lightOn' : 'lightOff')}</strong><small>{t(override === null && config.lightMode === 'auto' ? 'auto' : 'manual')}</small></span>
        </button>
        {override !== null && <button className="dsh-aq-auto" onClick={() => setOverride(null)}>{t('restore')}</button>}
        <button className="dsh-aq-tool" disabled={loading || !!error} aria-pressed={feeding}
          onClick={() => setFeeding(value => !value)} aria-label={t('feed')}
          style={{ cursor: feeding ? FEED_CURSOR : undefined }}>
          {/* 这里曾经写死「粒 · 4」（每批投喂量），看起来就像库存数。现在读账本：
              库存按「勺」计，点一次舀走一勺，落进水里是 LIMITS.batch 粒。 */}
          <ToolIcon kind="food" /><span><strong>{t(feeding ? 'feeding' : 'feed')}</strong><small data-stock={ledgerView.foodQueue}>{ledgerView.foodQueue > 0 ? `${t('foodStock')} ${ledgerView.foodQueue} ${t('scoop')}` : t('foodEmptyLabel')}</small></span>
        </button>
        {/* Rendering quality moved to the settings page; this slot now reports
            the token budget and owns the one irreversible action. */}
        <div className="dsh-aq-token">
          <span className="dsh-aq-token-label">{t('tokenUsage')}</span>
          <strong className="dsh-aq-token-value">{formatTokens(ledgerView.observed)}</strong>
          <small>{t('tokenNext')} {formatTokens(ledgerView.toNextUnit)}</small>
          <span className="dsh-aq-token-bar" aria-hidden="true">
            <i style={{ transform: `scaleX(${waterLevel.toFixed(3)})` }} />
          </span>
          <button type="button" className="dsh-aq-token-reset" data-armed={resetArm.armed ? 'true' : 'false'}
            disabled={!configView.writable}
            title={configView.writable ? t('tokenResetHint') : t('tokenResetHint')}
            onClick={resetArm.run}>
            {resetArm.armed ? `${t('tokenResetConfirm')} ${resetArm.left}` : t('tokenReset')}
          </button>
        </div>
        <span className="dsh-aq-zoom-readout" aria-hidden="true">{zoom.toFixed(1)}×</span>
      </div>
      <p className="dsh-aq-hint">{t(feeding ? 'feedHint' : 'viewHint')} · {t('dismissHint')}</p>
    </section>;
  }

/* ---------------------------------------------------------- customize page */
/** 下拉选项：内置在前、定制在后；定制条目带「定制」标记，和 README 的排序一致。 */
function presetOptions(category, t, extra = []) {
  const rows = [...extra, ...catalog.listPresets(category)];
  return rows.map(preset => ({
    id: preset.id,
    label: preset.origin === 'custom'
      ? `${displayNameOf(preset, t)} · ${t('customBadge')}`
      : displayNameOf(preset, t),
  }));
}

function SettingsPage({ t: hostT }) {
    const t = hostT || translate;
    const isDark = useSyncExternalStore(subscribeTheme, () => dark, () => dark);
    const configView = useSyncExternalStore(subscribeConfig, getConfig, getConfig);
    const { config } = normalizeConfig(configView.value);
    const tank = catalog.resolvePresetId(config.tankPresetId, 'tank');
    const lamp = catalog.resolvePresetId(config.lampPresetId, 'lamp');
    const scape = catalog.resolvePresetId(config.scapePresetId, 'scape');
    const feeding = catalog.feedingPresetOf(config.feedingPresetId);
    // 配置里指向已下线/未打包的资产时，这里如实说明，而不是让用户以为设置丢了。
    const fallbacks = [tank.repaired && t('currentTank'), lamp.repaired && t('currentLamp'), scape.repaired && t('decor')]
      .filter(Boolean);
    const customFish = catalog.customPresets('fish');
    const ledgerView = useSyncExternalStore(subscribeLedger, readLedger, readLedger);
    const resetArm = useArmedAction(() => { resetTokenStats(); announce('tokenResetDone'); });
    const [saving, setSaving] = useState('');
    const [message, setMessage] = useState('');
    const mounted = useRef(true);
    const timer = useRef(null);
    const level = Math.min(1, Math.max(0, ledgerView.pending / (ledgerView.unit || TOKEN_UNIT)));

    useEffect(() => () => { mounted.current = false; clearTimeout(timer.current); }, []);

    function announce(key) {
      clearTimeout(timer.current);
      setMessage(key);
      timer.current = setTimeout(() => { if (mounted.current) setMessage(''); }, 3200);
    }

    async function save(field, value) {
      const revision = form.getSnapshot().revision;
      if (revision === undefined || saving) return;
      setSaving(field);
      try {
        const ok = await form.mutate([{ op: 'set', path: [field], value }], revision);
        if (mounted.current) announce(ok ? 'saved' : 'saveFailure');
      } catch { if (mounted.current) announce('saveFailure'); }
      finally { if (mounted.current) setSaving(''); }
    }

    /** 定制鱼种是「加入/移出」而不是替换：内置两种鱼始终在缸里。 */
    function toggleFish(id) {
      const current = Array.isArray(config.customFishIds) ? config.customFishIds : [];
      const next = current.includes(id) ? current.filter(item => item !== id) : [...current, id];
      save('customFishIds', next);
    }

    const locked = !configView.writable || !!saving;

    /*
     * 每个维度右侧的「当前值」。缸体/灯具/造景/投喂习惯是单选，鱼群是只读摘要
     * （内置两种鱼常在，定制鱼种在下面的子行里逐条上下水）。
     */
    const dimensionTail = {
      tank: <select id="dsh-aq-tank" aria-label={t('currentTank')} value={tank.id} disabled={locked}
        onChange={event => save('tankPresetId', event.target.value)}>
        {presetOptions('tank', t).map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
      </select>,
      lamp: <select id="dsh-aq-lamp" aria-label={t('currentLamp')} value={lamp.id} disabled={locked}
        onChange={event => save('lampPresetId', event.target.value)}>
        {presetOptions('lamp', t).map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
      </select>,
      scape: <select id="dsh-aq-scape" aria-label={t('decor')} value={scape.id} disabled={locked}
        onChange={event => save('scapePresetId', event.target.value)}>
        {presetOptions('scape', t).map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
      </select>,
      fish: <span className="dsh-aq-value">{fishSummary(config)}</span>,
      feeding: <select id="dsh-aq-feeding" aria-label={t('feedingPlan')} value={feeding.id} disabled={locked}
        onChange={event => save('feedingPresetId', event.target.value)}>
        {presetOptions('feeding', t, [STANDARD_FEEDING]).map(option =>
          <option key={option.id} value={option.id}>{option.label}</option>)}
      </select>,
    };

    return <section className="dsh-aq-page" data-dark={isDark} aria-label={`${t('title')} · ${t('pageCustomize')}`}>
      <header className="dsh-aq-head">
        <span className="dsh-aq-mark" aria-hidden="true"><AquariumGlyph size={26} /></span>
        <div className="dsh-aq-heading">
          {/* 页名与「定制」同一行同一号字，用一个间隔点分开；不再另起一行眉标。 */}
          <h1>{t('title')}<span className="dsh-aq-h1-sep" aria-hidden="true">·</span>{t('pageCustomize')}</h1>
          <p className="dsh-aq-lede">{t('pageLede')}</p>
        </div>
      </header>

      {/* The only numbers that move day to day, right where the eye lands. */}
      <div className="dsh-aq-strip">
        <div className="dsh-aq-strip-item">
          <span>{t('tokenUsed')}</span>
          <strong>{formatTokens(ledgerView.observed)}</strong>
        </div>
        <div className="dsh-aq-strip-item">
          <span>{t('tokenQueue')}</span>
          <strong>{ledgerView.foodQueue}<em>{t('scoop')}</em></strong>
        </div>
        <div className="dsh-aq-strip-item">
          <span>{t('tokenNextLabel')}</span>
          <strong>{formatTokens(ledgerView.toNextUnit)}</strong>
        </div>
        <div className="dsh-aq-strip-bar" aria-hidden="true">
          <i style={{ transform: `scaleX(${level.toFixed(3)})` }} />
        </div>
      </div>

      <div className="dsh-aq-blocks">
        {/*
         * 五个维度合成一块：左边「这个维度现在是什么」，右边「现成的」或「做一个新的」。
         * 选择控件与定制按钮同排，因为它们是同一件事的两种做法——挑现成的资产，
         * 或者让模型按 skill 里的契约做一份。拆成两块会让同一件事出现在页面两处。
         */}
        <section className="dsh-aq-block dsh-aq-block-ai" aria-labelledby="dsh-aq-ai">
          <h2 id="dsh-aq-ai">{t('customSection')}</h2>
          <p className="dsh-aq-note">{t('customLede')}</p>
          {DIMENSIONS.map(dimension => (
            <React.Fragment key={dimension.id}>
              <div className="dsh-aq-row" data-dimension-row={dimension.id}>
                <div className="dsh-aq-row-main">
                  <strong>{t(dimension.labelKey)}</strong>
                  <small>{t(dimension.hintKey)}</small>
                </div>
                <div className="dsh-aq-row-tail">
                  {dimensionTail[dimension.id]}
                  <button type="button" className="dsh-aq-custom" data-dimension={dimension.id}
                    disabled={locked} onClick={() => {
                      const result = startCustomization(dimension.id);
                      announce(result.ok ? 'customStarted' : (result.reason ?? 'customFailed'));
                    }}>
                    {t('customStart')}
                  </button>
                </div>
              </div>
              {/* 定制鱼种不替换内置鱼，而是逐条上下水，所以单独一行挂在鱼群下面。 */}
              {dimension.id === 'fish' && customFish.map(preset => {
                const on = config.customFishIds.includes(preset.id);
                return <div className="dsh-aq-row dsh-aq-row-sub" key={preset.id}>
                  <div className="dsh-aq-row-main">
                    <strong>{displayNameOf(preset, t)}</strong>
                    <small>{t('customBadge')} · {preset.params?.count ?? 2} {t('fishUnit')}</small>
                  </div>
                  <button type="button" className="dsh-aq-toggle" data-on={on ? 'true' : 'false'}
                    aria-pressed={on} disabled={locked} onClick={() => toggleFish(preset.id)}>
                    {on ? t('fishRemove') : t('fishAdd')}
                  </button>
                </div>;
              })}
            </React.Fragment>
          ))}
          {fallbacks.length > 0 && <p className="dsh-aq-note" role="status">{t('customFallback')}</p>}
          <p className="dsh-aq-note">{t('customFoot')}</p>
        </section>

        <section className="dsh-aq-block" aria-labelledby="dsh-aq-display">
          <h2 id="dsh-aq-display">{t('displaySection')}</h2>
          <div className="dsh-aq-row">
            <div className="dsh-aq-row-main">
              <label htmlFor="dsh-aq-light">{t('lightMode')}</label>
              <small>{t('lightModeHint')}</small>
            </div>
            <select id="dsh-aq-light" value={config.lightMode} disabled={locked}
              onChange={event => save('lightMode', event.target.value)}>
              <option value="auto">{t('lightModeAuto')}</option>
              <option value="on">{t('lightModeOn')}</option>
              <option value="off">{t('lightModeOff')}</option>
            </select>
          </div>
          <div className="dsh-aq-row">
            <div className="dsh-aq-row-main">
              <label htmlFor="dsh-aq-quality">{t('quality')}</label>
              <small>{t('qualityHint')}</small>
            </div>
            <select id="dsh-aq-quality" value={config.qualityMode} disabled={locked}
              onChange={event => save('qualityMode', event.target.value)}>
              <option value="auto">{t('autoQuality')}</option>
              <option value="standard">{t('standard')}</option>
              <option value="eco">{t('eco')}</option>
            </select>
          </div>
        </section>

        <section className="dsh-aq-block" aria-labelledby="dsh-aq-token">
          <h2 id="dsh-aq-token">{t('tokenSection')}</h2>
          <div className="dsh-aq-row">
            <div className="dsh-aq-row-main"><strong>{t('tokenSince')}</strong><small>{t('tokenSinceHint')}</small></div>
            <span className="dsh-aq-value">{formatSince(ledgerView.epochAt)}</span>
          </div>
          <div className="dsh-aq-row">
            <div className="dsh-aq-row-main"><strong>{t('tokenUsed')}</strong><small>{t('tokenUsedHint')}</small></div>
            <span className="dsh-aq-value">{formatTokens(ledgerView.observed)}</span>
          </div>
          <div className="dsh-aq-row">
            <div className="dsh-aq-row-main"><strong>{t('tokenNextLabel')}</strong><small>{t('tokenNextHint')}</small></div>
            <span className="dsh-aq-value">{formatTokens(ledgerView.toNextUnit)}</span>
          </div>
          <div className="dsh-aq-row">
            <div className="dsh-aq-row-main"><strong>{t('tokenEarned')}</strong><small>{t('tokenEarnedHint')}</small></div>
            <span className="dsh-aq-value">
              {ledgerView.earned} {t('scoop')}
              {ledgerView.exchanges > 0 ? ` · ${ledgerView.exchanges}${t('tokenTimes')}` : ''}
            </span>
          </div>
          {/* 已投喂 + 待投喂 = 初装 5 勺 + 已兑换。少这一行时，用户看到
              「兑换了 10 勺、库存只剩 5 勺」会以为算错了。 */}
          <div className="dsh-aq-row">
            <div className="dsh-aq-row-main"><strong>{t('tokenDelivered')}</strong><small>{t('tokenDeliveredHint')}</small></div>
            <span className="dsh-aq-value">{ledgerView.delivered} {t('scoop')}</span>
          </div>
          <div className="dsh-aq-row">
            <div className="dsh-aq-row-main"><strong>{t('tokenQueue')}</strong><small>{t('tokenQueueHint')}</small></div>
            <span className="dsh-aq-value">{ledgerView.foodQueue} {t('scoop')}</span>
          </div>
          <div className="dsh-aq-row">
            <div className="dsh-aq-row-main"><strong>{t('tokenReset')}</strong><small>{t('tokenResetHint')}</small></div>
            <button type="button" className="dsh-aq-danger" data-armed={resetArm.armed ? 'true' : 'false'}
              disabled={!configView.writable} onClick={resetArm.run}>
              {resetArm.armed ? `${t('tokenResetConfirm')} ${resetArm.left}` : t('tokenReset')}
            </button>
          </div>
          <p className="dsh-aq-note">{t('tokenFoot')}</p>
        </section>
      </div>

      <div className="dsh-aq-cta">
        <div>
          <strong>{t('playTitle')}</strong>
          <p>{t('playHint')}</p>
        </div>
        <button type="button" className="dsh-aq-primary" onClick={() => setAquariumOpen(true)}>{t('playOpen')}</button>
      </div>

      <p className="dsh-aq-status-line" role="status" aria-live="polite">{message ? t(message) : t('pageFoot')}</p>
    </section>;
  }

  /** One sidebar row: the icon slot and the page it opens share the same id. */
  function SidebarEntry(props) {
    return <AquariumGlyph size={props?.size || 18} />;
  }

  ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist', id: NS, order: 40, locale: NS, label: () => translate('title'),
  }, SidebarEntry)));
  ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: NS, locale: NS }, SettingsPage)));
  ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: 'eco-aquarium-view', order: -100, locale: NS,
  }, PlayView)));
}



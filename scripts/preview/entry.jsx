// Preview host: renders the aquarium floating view and settings page outside
// DSH with a stub ctx, on top of a fake app surface, using the real scene chunk.
import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { apply, setAquariumOpen } from '../../src/client.jsx';
import { zh } from '../../src/locales.js';

// The preview can ask for the states the checks need: `?mode=closed|page|
// overlay` picks the initial surface without a first frame that would deliver
// food, and `?ledger=returning` resumes a ledger that already handed out its
// welcome stock, i.e. every run after the very first one.
const params = new URLSearchParams(globalThis.location?.search ?? '');
const initialMode = ['closed', 'page', 'overlay'].includes(params.get('mode')) ? params.get('mode') : 'overlay';
const returning = params.get('ledger') === 'returning';
// `?fish=a,b` and `?scape=…&tank=…&lamp=…&feeding=…` pretend the profile
// already carries those ids, which is how the custom-asset path gets exercised
// without a real session writing config first.
const ids = key => (params.get(key) ?? '').split(',').map(value => value.trim()).filter(Boolean);

const config = {
  schemaVersion: 1, tankPresetId: params.get('tank') ?? 'tank.clear-40', lampPresetId: params.get('lamp') ?? 'lamp.arch',
  scapePresetId: params.get('scape') ?? 'scape.jungle', lightMode: 'auto', qualityMode: 'auto',
  feedingPresetId: params.get('feeding') ?? 'feeding.standard', customFishIds: ids('fish'),
  ...(returning ? {
    ledger: {
      v: 1, epochAt: Date.now(), observed: 0, pending: 0, foodQueue: 0,
      earned: 0, exchanges: 0, gifted: true, baseline: [],
    },
  } : {}),
};
// The host's config form publishes a NEW snapshot object per change, and
// `useSyncExternalStore` compares by identity, so the stub must do the same.
let snapshot = { value: config, revision: 1, writable: true };
function replaceValue(key, value) {
  snapshot = { ...snapshot, value: { ...snapshot.value, [key]: value }, revision: snapshot.revision + 1 };
  configListeners.forEach(listener => listener());
}
const configListeners = new Set();
const t = key => zh[key] ?? key;

let dark = false;
const themeListeners = new Set();
const chunkDefs = {};

window.__ModuleLoader__ = {
  load(definition) { chunkDefs[definition.chunk || 'client.js'] = definition; },
};
window.require = {
  async: async spec => {
    const file = String(spec).replace('./', '');
    if (!chunkDefs[file]) {
      await new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = '../lib/' + file;
        script.onload = resolve;
        script.onerror = () => reject(new Error('cannot load ' + file));
        document.head.append(script);
      });
    }
    const definition = chunkDefs[file];
    if (!definition) throw new Error('chunk not registered: ' + file);
    return definition.factory(() => { throw new Error('unexpected module require'); });
  },
};

const registrations = {};
// One fake session whose cumulative usage the preview can move by hand.
const usage = { preview: 1_000_000 };
// P5：交接桩。点「AI 定制」只是把草稿交给 startSession，预览里记下参数供断言。
const handoffs = [];
const ctx = {
  effect(fn) { fn(); return () => {}; },
  on(name, listener) { if (name === 'theme/change') themeListeners.add(listener); },
  locale: { register: () => () => {}, bind: () => t },
  theme: { getTheme: () => ({ active: { colorScheme: dark ? 'dark' : 'light' } }), setTheme() {} },
  uiWorkspace: {
    startSession(workspaceId, options) { handoffs.push({ workspaceId, options }); },
  },
  workspaces: {
    list: { getSnapshot: () => ({ phase: 'ready', items: [{ workspaceId: 'ws-preview', sessionIds: ['preview'] }] }) },
  },
  configForms: { get: () => ({
    subscribe: listener => { configListeners.add(listener); return () => configListeners.delete(listener); },
    getSnapshot: () => snapshot,
    mutate: async operations => {
      for (const operation of operations) if (operation.op === 'set') replaceValue(operation.path[0], operation.value);
      return true;
    },
  }) },
  sessions: { list: { getSnapshot: () => ({
    ids: Object.keys(usage),
    byId: Object.fromEntries(Object.entries(usage).map(([id, tokens]) => [id, {
      projectionValues: { tokenUsage: { uncachedInputTokens: tokens } },
    }])),
    projectionsBySession: {},
  }) } },
  slots: {
    inject(name, fn) { registrations[name] = fn(); return () => delete registrations[name]; },
    register: (options, component) => ({ options, component }),
  },
};
window.__DSH_AQUARIUM_TEST__ = {};
apply(ctx);

const Overlay = registrations['shell.overlay'].component;
const Page = registrations.main.component;

function FakeApp() {
  return React.createElement('div', { className: 'fake-shell' },
    React.createElement('aside', { className: 'fake-side' },
      React.createElement('strong', null, 'DeepSeek Harness'),
      ['插件', '自动化任务', '更多', '工作区 · 默认工作区', '新会话'].map(text =>
        React.createElement('p', { key: text }, text))),
    React.createElement('main', { className: 'fake-main' },
      React.createElement('h1', { className: 'fake-h' }, '探索未至之境'),
      React.createElement('p', { className: 'fake-p' },
        '这是一段占位正文，用来检查悬浮鱼缸的半透明遮罩是否把宿主内容压下去。文字应当变模糊、变淡，而不是与玻璃缸叠在一起。'),
      React.createElement('div', { className: 'fake-composer' }, '描述你想要构建的内容，/ 调用指令，@ 文件或对话'),
      React.createElement('p', { className: 'fake-p' },
        '第二段占位文字：如果遮罩没有生效，这里的内容会直接透过鱼缸显示出来。')));
}

function Preview({ initial = 'overlay' }) {
  const [mode] = useState(initial);
  useEffect(() => { setAquariumOpen(mode === 'overlay'); }, [mode]);
  return React.createElement('div', { className: 'shell', 'data-mode': mode },
    mode === 'page' ? React.createElement('div', { className: 'page-layer' }, React.createElement(Page, { t })) : null,
    mode === 'page' ? null : React.createElement(FakeApp, null),
    mode === 'page' ? null : React.createElement('div', { className: 'slot-layer' }, React.createElement(Overlay, { t, usePanelInfo: () => 'tiny-aquarium' })));
}

const root = createRoot(document.getElementById('root'));
root.render(React.createElement(Preview, { initial: initialMode }));

window.__preview = {
  setMode(next) { root.render(React.createElement(Preview, { key: next, initial: next })); },
  setScape(value) { replaceValue('scapePresetId', value); },
  // Move the fake session's cumulative usage and take one sample, exactly like
  // the one-minute poll does.
  setTokens(tokens) {
    usage.preview = tokens;
    return window.__DSH_AQUARIUM_TEST__.pollLedger();
  },
  readLedger: () => window.__DSH_AQUARIUM_TEST__.readLedger(),
  // 定制入口：返回本次交接的提示词，用于检查九段是否齐全。
  customPrompt: id => window.__DSH_AQUARIUM_TEST__.customPrompt(id),
  handoffs: () => handoffs.slice(),
  lastHandoff: () => handoffs.at(-1) ?? null,
  setDark(value) {
    dark = value;
    document.body.dataset.dark = value ? 'true' : 'false';
    themeListeners.forEach(listener => listener({ active: { colorScheme: dark ? 'dark' : 'light' } }));
  },
};

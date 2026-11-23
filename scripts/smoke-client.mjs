// Loads the built client bundle the way DSH's module loader does, activates it
// against a stub host, and server-renders every registered slot. This catches
// broken slot registrations and component crashes without a browser.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { zh } from '../src/locales.js';
import { WELCOME_SCOOPS } from '../src/token-ledger.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const code = await readFile(path.join(root, 'lib', 'client.js'), 'utf8');
// 插件 id（NS）以 cordis.patch.yml 为准：包名只对 npm 负责，id 决定 slot / locale /
// skill 的命名空间，两者的连字符写法允许不同（包名 dsh-tiny-aquarium ↔ id tinyfish）。
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const patch = await readFile(path.join(root, 'cordis.patch.yml'), 'utf8');
const NS = (patch.match(/^\s*-\s*id:\s*([\w-]+)/m) || [])[1];
assert.ok(NS, 'cordis.patch.yml declares the plugin id');

let definition;
let injectedCss = '';
const sandboxWindow = { __ModuleLoader__: { load(next) { definition = next; } } };
globalThis.window = sandboxWindow;
globalThis.document = {
  createElement: () => ({
    dataset: {},
    remove() {},
    get textContent() { return injectedCss; },
    set textContent(value) { injectedCss = value; },
  }),
  head: { append() {} },
};
new Function('window', code)(sandboxWindow);
assert.equal(definition?.id, pkg.name, 'bundle registers under the package name');

const client = definition.factory(require);
assert.equal(typeof client.apply, 'function', 'client exports apply()');
assert.deepEqual([...client.inject].sort(),
  ['configForms', 'locale', 'sessions', 'slots', 'theme', 'uiWorkspace', 'workspaces'],
  'declares the services it uses');

const config = {
  schemaVersion: 1, tankPresetId: 'tank.clear-40', lampPresetId: 'lamp.arch',
  scapePresetId: 'scape.jungle', lightMode: 'auto', qualityMode: 'auto',
};
const t = key => zh[key] ?? key;
const registered = new Map();
const writes = [];
const ctx = {
  effect(fn) { fn(); return () => {}; },
  on() {},
  locale: { register: () => () => {}, bind: () => t },
  theme: { getTheme: () => ({ active: { colorScheme: 'light' } }), setTheme() {} },
  configForms: {
    get: () => ({
      subscribe: () => () => {},
      getSnapshot: () => ({ value: { ...config }, revision: 3, writable: true }),
      mutate: async ops => { writes.push(ops); return true; },
    }),
  },
  // One parent session and one subagent row, both with projection values.
  sessions: {
    list: {
      getSnapshot: () => ({
        ids: ['sess_parent', 'sess_child'],
        byId: {
          sess_parent: { projectionValues: { tokenUsage: { uncachedInputTokens: 800, outputTokens: 200 } } },
          sess_child: { projectionValues: { tokenUsage: { cacheReadTokens: 1_500 } } },
        },
        projectionsBySession: {},
      }),
    },
  },
  slots: {
    inject(name, fn) { registered.set(name, fn()); return () => registered.delete(name); },
    register: (options, component) => ({ options, component }),
  },
};

globalThis.__DSH_AQUARIUM_TEST__ = {};
client.apply(ctx);
const test = globalThis.__DSH_AQUARIUM_TEST__;
const ledger = test.readLedger();
assert.ok(ledger.epochAt > 0, 'the ledger starts its epoch on first run');
assert.equal(ledger.observed, 0, 'the first sample only records baselines');
assert.equal(ledger.foodQueue, WELCOME_SCOOPS, 'a fresh install is stocked with the welcome scoops');
assert.equal(ledger.earned, 0, 'the welcome stock is not an exchange');
assert.deepEqual(test.sampleTokens().entries.map(entry => entry.tokens).sort(), [1000, 1500], 'parent and subagent usage both count');

assert.deepEqual([...registered.keys()].sort(), ['main', 'shell.overlay', 'sidebar.panellist'], 'sidebar row, settings page and floating view');
const sidebar = registered.get('sidebar.panellist');
assert.equal(sidebar.options.id, NS);
assert.equal(sidebar.options.order, 40);
assert.equal(sidebar.options.label(), '小鱼缸', 'sidebar label is localized');
const glyph = renderToStaticMarkup(React.createElement(sidebar.component, { size: 18 }));
assert.match(glyph, /<svg[^>]*width="18"/);
assert.match(glyph, /stroke="currentColor"/, 'sidebar glyph inherits host color');

const page = registered.get('main');
assert.equal(page.options.key, NS, 'page key matches the sidebar id');
const pageHtml = renderToStaticMarkup(React.createElement(page.component, { t }));
for (const text of ['小鱼缸', '定制', '显示与光照', '外观与手感', '做一个新的', '打开鱼缸', '灯光模式', '渲染质量',
  'Token 统计', '统计起点', '累计用量', '待投喂', '已兑换', '已投喂', '重置统计']) {
  assert.ok(pageHtml.includes(text), `settings page renders ${text}`);
}
// 页名与页别同一行、同一号字，中间一个间隔点——不再另起一行眉标。
assert.match(pageHtml, /<h1[^>]*>小鱼缸<span[^>]*>·<\/span>定制<\/h1>/, 'title and page name share one line');
// 定制页是成品界面：开发期的阶段标记、旧页名、版本号与原始资产 id 都不该出现。
for (const gone of ['P5', 'P4', 'AI 定制', '结构版本', '设置', 'dsh-aq-scene', 'dsh-aq-life']) {
  assert.ok(!pageHtml.includes(gone), `customize page no longer renders ${gone}`);
}
// P5：五个维度各一个入口，按钮带 data-dimension 便于预览与验收定位。
assert.equal((pageHtml.match(/data-dimension="/g) || []).length, 5, 'five customization entry points render');
for (const dimension of ['tank', 'lamp', 'scape', 'fish', 'feeding']) {
  assert.match(pageHtml, new RegExp(`data-dimension="${dimension}"`), `customization entry for ${dimension}`);
  // 每个维度的行同时承载「当前值」，选择与定制在同一行。
  assert.match(pageHtml, new RegExp(`data-dimension-row="${dimension}"`), `row for ${dimension}`);
}
assert.match(pageHtml, /data-dark="false"/);
assert.match(pageHtml, /dsh-aq-strip/, 'token figures sit above the fold, not only in the bottom block');
assert.doesNotMatch(pageHtml, /dsh-aq-stage/, 'settings page does not mount the 3D stage');
// P5 起缸体与灯具也是可选条目，加上造景、投喂习惯、灯光模式与渲染质量共 6 个下拉。
assert.equal((pageHtml.match(/<select/g) || []).length, 6, 'tank, lamp, scape, feeding, lighting and quality selects render');
for (const text of ['苔藓石景', '水草丛林', '沉木疏林']) assert.ok(pageHtml.includes(text), `scape option ${text}`);

const view = registered.get('shell.overlay');
assert.equal(view.options.order, -100, 'floating view stays under host notices');
const closed = renderToStaticMarkup(React.createElement(view.component, { t }));
assert.match(closed, /class="dsh-aq-entry"/, 'closed state shows the floating entry');
assert.doesNotMatch(closed, /role="dialog"/);
assert.match(closed, /dsh-aq-entry-water/, 'the entry fills the whole button with water');
assert.match(closed, /dsh-aq-entry-fill/, 'the water is clipped to the button');
assert.doesNotMatch(closed, />小鱼缸</, 'the entry is logo only, without the app name');
assert.match(closed, new RegExp(`dsh-aq-entry-badge[^>]*>${WELCOME_SCOOPS}<`),
  'the badge carries the welcome pellets before any token is spent');

client.setAquariumOpen(true);
const opened = renderToStaticMarkup(React.createElement(view.component, { t }));
assert.match(opened, /role="dialog"/, 'open state renders the aquarium view');
assert.match(opened, /class="dsh-aq-stage"/, 'view mounts its stage');
assert.match(opened, /dsh-aq-zoom-guide/, 'view renders the zoom boundary');
assert.match(opened, /dsh-aq-zoom-readout/, 'view shows the zoom level');
assert.match(opened, /关闭鱼缸/, 'view exposes a close control');
assert.match(opened, /鱼食罐/, 'view keeps the feeding tool');
assert.match(opened, /Token 用量/, 'the tool column reports token usage');
assert.match(opened, /重置统计/, 'the tool column owns the reset action');
// 出处说明站在左下角：谁做的缸、谁写的代码，以及定制该换更强的模型。
assert.match(opened, /class="dsh-aq-credit"/, 'the view carries a credits line');
assert.match(opened, /Kimi 3\.1 Pro/, 'the credits name the asset author model');
assert.match(opened, /DeepSeek-V4\.1 Flash/, 'the credits name the code model');
assert.equal((opened.match(/<select/g) || []).length, 0, 'rendering quality left the floating view');
// 全屏视图同样只留成品文案：没有阶段标记，也没有 FPS 这类调试读数。
assert.doesNotMatch(opened, /P5|P4|FPS|设置/, 'the view carries no phase marker or debug readout');
client.setAquariumOpen(false);

assert.match(injectedCss, /backdrop-filter/, 'the view keeps a real translucent mask');
assert.match(injectedCss, /\.dsh-aq-overlay\s*\{/, 'overlay styles are shipped');

console.log('smoke-client: slots, glyph, settings page, floating view OK');

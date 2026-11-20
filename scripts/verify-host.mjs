import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const url = process.env.DSHAQ_URL;
if (!url) throw new Error('Set DSHAQ_URL to the URL printed by your isolated official DSH Web host.');
const out = path.resolve(process.env.DSHAQ_EVIDENCE || 'docs/evidence');
await fs.mkdir(out, { recursive: true });
const pkg = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
const browser = await chromium.launch({ channel: process.env.DSHAQ_BROWSER || 'msedge', headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1,
  recordVideo: { dir: out, size: { width: 1440, height: 1000 } },
});
await context.addInitScript(() => { globalThis.__DSH_AQUARIUM_TEST__ = {}; });
const page = await context.newPage();
const errors = [];
const requests = [];
let expectWebglFailure = false;
const result = { host: 'Official DSH 0.2.2-rc.3 Web GUI, isolated profile', browser: browser.version(), checks: [], errors };
page.on('pageerror', error => {
  if (expectWebglFailure && /WebGL context/i.test(error.message)) return;
  errors.push(error.message);
});
page.on('console', msg => {
  if (expectWebglFailure && /WebGL context/i.test(msg.text())) return;
  if (msg.type() === 'error' && /THREE|shader|aquarium/i.test(msg.text())) errors.push(msg.text());
});
page.on('request', request => requests.push(request.url()));
const sceneSnapshot = () => page.evaluate(() => globalThis.__DSH_AQUARIUM_TEST__.scene?.snapshot());
const project = point => page.evaluate(point => globalThis.__DSH_AQUARIUM_TEST__.scene.project(point), point);
const check = (name, data) => { result.checks.push({ name, pass: true, ...(data ? { data } : {}) }); console.log('PASS', name); };
async function screenshot(name) { await page.screenshot({ path: path.join(out, name + '.png') }); }
async function dismissHostDialogs(target) {
  const intro = target.getByRole('dialog', { name: '开始使用', exact: true });
  const mask = target.locator('div[aria-hidden="true"][class*="_mask_"]').first();
  let quiet = 0;
  for (let i = 0; i < 24; i++) {
    let acted = false;
    const preview = target.getByRole('button', { name: '继续', exact: true });
    if (await preview.isVisible().catch(() => false)) { await preview.click(); acted = true; }
    const close = intro.getByRole('button', { name: '关闭', exact: true });
    if (await close.isVisible().catch(() => false)) { await close.click(); acted = true; }
    const blocked = await mask.isVisible().catch(() => false);
    if (blocked && !acted) {
      await mask.click({ position: { x: 5, y: 5 }, timeout: 1000 }).catch(() => {});
      acted = true;
    }
    quiet = acted || blocked ? 0 : quiet + 1;
    if (quiet >= 2) break;
    await target.waitForTimeout(250);
  }
  return intro;
}
async function open() {
  const start = Date.now();
  await page.getByRole('button', { name: '小鱼缸', exact: true }).click();
  await page.waitForFunction(() => !!globalThis.__DSH_AQUARIUM_TEST__.scene);
  return Date.now() - start;
}
async function close() {
  await page.getByRole('button', { name: '关闭鱼缸', exact: true }).first().click();
  await page.waitForFunction(() => !globalThis.__DSH_AQUARIUM_TEST__.scene);
  assert.equal(await page.locator('[data-aquarium-canvas]').count(), 0);
}
async function pointClick(point) {
  const p = await project(point);
  await page.mouse.click(p.x, p.y);
}
try {
  await page.goto(url);
  // The official Web host keeps SSE open, so `networkidle` never settles.
  await page.waitForLoadState('domcontentloaded');
  await page.getByRole('button', { name: '小鱼缸', exact: true }).waitFor();
  // Host onboarding is modal and renders asynchronously; close it before pointer tests.
  const intro = await dismissHostDialogs(page);
  assert.equal(await intro.isVisible().catch(() => false), false);
  await page.waitForFunction(() => globalThis.__DSH_AQUARIUM_TEST__.readConfig?.().status === 'ready');
  await screenshot('00-entry-closed');
  const entryBox = await page.getByRole('button', { name: '小鱼缸', exact: true }).boundingBox();
  const sendBox = await page.getByRole('button', { name: '发送消息', exact: true }).boundingBox().catch(() => null);
  assert.ok(entryBox && entryBox.width > 30 && entryBox.height > 30);
  if (sendBox) {
    const overlap = !(entryBox.x >= sendBox.x + sendBox.width || entryBox.x + entryBox.width <= sendBox.x ||
      entryBox.y >= sendBox.y + sendBox.height || entryBox.y + entryBox.height <= sendBox.y);
    assert.equal(overlap, false, 'entry must not cover the composer send control');
  }
  check('Single visible entry clear of the composer send control', { entryBox, sendBox });
  const beforeOpen = requests.filter(r => r.includes(`/${pkg.name}/client.scene.js`));
  assert.equal(beforeOpen.length, 0);
  check('Renderer chunk not requested before opening');
  const firstOpenMs = await open();
  const pipeline = await page.locator('[data-aquarium-canvas]').evaluate(canvas => {
    const gl = canvas.getContext('webgl2');
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    return {
      webgl2: !!gl, alpha: gl.getContextAttributes().alpha,
      clear: [...gl.getParameter(gl.COLOR_CLEAR_VALUE)],
      gpu: info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
    };
  });
  assert.equal(pipeline.webgl2, true);
  assert.equal(pipeline.alpha, true);
  assert.equal(pipeline.clear[3], 0);
  check('Official host slot, lazy chunk and transparent WebGL2', { firstOpenMs, pipeline });

  // Rendering quality now lives on the settings page, so the floating view
  // reports the token budget instead of a select.
  assert.equal(await page.locator('.dsh-aq-overlay select').count(), 0, 'no select is left in the floating view');
  await page.locator('.dsh-aq-token').waitFor();
  const ledgerStart = await page.evaluate(() => globalThis.__DSH_AQUARIUM_TEST__.readLedger());
  assert.ok(ledgerStart.epochAt > 0, 'the token ledger starts its epoch');
  assert.equal(ledgerStart.observed, 0, 'the first sample only records baselines');
  assert.equal(ledgerStart.foodQueue, 5, 'a fresh install ships with the welcome pellets');
  await page.evaluate(() => globalThis.__DSH_AQUARIUM_TEST__.writeConfig([{ op: 'set', path: ['qualityMode'], value: 'standard' }]));
  await page.waitForFunction(() => globalThis.__DSH_AQUARIUM_TEST__.readConfig().value.qualityMode === 'standard');
  const config = await page.evaluate(() => globalThis.__DSH_AQUARIUM_TEST__.readConfig());
  assert.equal(config.writable, true);
  const sameSceneTime = (await sceneSnapshot()).time;
  assert.ok(sameSceneTime >= 0);
  const stale = await page.evaluate(async () => {
    const t = globalThis.__DSH_AQUARIUM_TEST__;
    const before = t.readConfig();
    await t.writeConfig([{ op: 'set', path: ['qualityMode'], value: 'auto' }], before.revision);
    const refused = await t.writeConfig([{ op: 'set', path: ['qualityMode'], value: 'eco' }], before.revision);
    return { refused, current: t.readConfig().value.qualityMode };
  });
  assert.equal(stale.refused, false);
  assert.equal(stale.current, 'auto');
  check('Real volatile Config write and stale-revision rejection', { revision: config.revision });
  // Reset must write immediately: the section has to exist right after the click.
  await page.evaluate(() => globalThis.__DSH_AQUARIUM_TEST__.resetLedger());
  await page.waitForFunction(() => globalThis.__DSH_AQUARIUM_TEST__.readConfig().value.ledger?.v === 1);
  const persisted = await page.evaluate(() => globalThis.__DSH_AQUARIUM_TEST__.readConfig().value.ledger);
  assert.ok(persisted.epochAt > 0);
  assert.equal(persisted.observed, 0);
  assert.equal(persisted.foodQueue, 5, 'reset reinstalls the welcome stock');
  assert.equal(persisted.gifted, true, 'the restock is flagged so a restart cannot repeat it');
  check('Token ledger resets and lands in the volatile config', persisted);
  await screenshot('01-light-transparent');

  const tapPoint = { x: 0.06, y: 0.15, z: 0.127 };
  const projected = await project(tapPoint);
  const hit = await page.evaluate(p => globalThis.__DSH_AQUARIUM_TEST__.scene.pick(p.x, p.y), projected);
  assert.equal(hit.kind, 'glass');
  await page.mouse.move(projected.x, projected.y);
  assert.equal(await page.locator('[data-aquarium-canvas]').evaluate(c => c.style.cursor), 'pointer');
  await pointClick(tapPoint);
  const tapA = (await sceneSnapshot()).taps.at(-1);
  assert.ok(tapA);
  await screenshot('02-glass-tap-a');
  await page.waitForTimeout(340);
  await pointClick({ x: -0.08, y: 0.12, z: 0.127 });
  const tapB = (await sceneSnapshot()).taps.at(-1);
  assert.ok(Math.abs(tapA.point.x - tapB.point.x) > 0.06);
  await screenshot('03-glass-tap-b');
  check('Glass-only pointer and different local tap coordinates');

  const beforeDrag = await sceneSnapshot();
  const dragStart = await project(tapPoint);
  await page.mouse.move(dragStart.x, dragStart.y);
  await page.mouse.down();
  await page.mouse.move(dragStart.x + 120, dragStart.y, { steps: 18 });
  await page.mouse.move(dragStart.x - 65, dragStart.y, { steps: 16 });
  await page.mouse.up();
  const afterDrag = await sceneSnapshot();
  assert.ok(Math.abs(afterDrag.yaw - beforeDrag.yaw) > 0.1);
  assert.ok(Math.abs(afterDrag.wave) > 0.0002);
  assert.equal(afterDrag.food.length, 0);
  await screenshot('04-rotation-water');
  const disturbed = Math.abs(afterDrag.wave);
  await page.waitForTimeout(4200);
  assert.ok(Math.abs((await sceneSnapshot()).wave) < Math.max(0.0002, disturbed * 0.1));
  check('Horizontal rotation, reverse input and decaying water response');

  await page.getByRole('button', { name: '鱼食罐', exact: true }).click();
  const toolCursor = await page.getByRole('button', { name: '鱼食罐', exact: true }).evaluate(node => node.style.cursor);
  assert.match(decodeURIComponent(toolCursor), /rotate\(-18 16 16\)/);
  // Use the actual top plane and raycast after rotation, not a screen approximation.
  const feedPoint = { x: -0.05, y: 0.269, z: -0.025 };
  const feedScreen = await project(feedPoint);
  const feedHit = await page.evaluate(p => globalThis.__DSH_AQUARIUM_TEST__.scene.pick(p.x, p.y), feedScreen);
  assert.equal(feedHit.kind, 'water');
  await page.mouse.move(feedScreen.x, feedScreen.y);
  const waterCursor = await page.locator('[data-aquarium-canvas]').evaluate(node => node.style.cursor);
  assert.match(decodeURIComponent(waterCursor), /rotate\(-54 16 16\)/);
  await pointClick(feedPoint);
  const firstFood = (await sceneSnapshot()).food;
  assert.equal(firstFood.length, 4);
  await screenshot('05-food-at-water');
  await page.waitForFunction(() => globalThis.__DSH_AQUARIUM_TEST__.scene.snapshot().fishState.some(fish => fish.eaten > 0));
  const feedingNow = await sceneSnapshot();
  assert.ok(feedingNow.fishState.some(fish => fish.eaten > 0), 'fish should actually consume pellets');
  for (const pellet of feedingNow.food) {
    const original = firstFood.find(item => item.id === pellet.id);
    if (original) assert.ok(pellet.y <= original.y);
  }
  await pointClick({ x: 0.075, y: 0.269, z: -0.035 });
  const secondFood = (await sceneSnapshot()).food;
  assert.ok(secondFood.length > 0 && secondFood.length <= 8);
  await screenshot('06-food-sinking');
  const beforeWall = (await sceneSnapshot()).food.length;
  await pointClick(tapPoint);
  assert.ok((await sceneSnapshot()).food.length <= beforeWall);
  assert.equal((await sceneSnapshot()).taps.length, 0);
  const feedingDrag = await project(tapPoint);
  await page.mouse.move(feedingDrag.x, feedingDrag.y);
  await page.mouse.down();
  await page.mouse.move(feedingDrag.x + 80, feedingDrag.y, { steps: 10 });
  await page.mouse.up();
  assert.ok((await sceneSnapshot()).food.length <= 100);
  check('Actual water raycast, jar cursors, real consumption, wall rejection and drag isolation');

  for (let i = 0; i < 30; i++) {
    await pointClick({ x: -0.06 + (i % 3) * 0.03, y: 0.269, z: -0.03 });
    await page.waitForTimeout(165);
  }
  const capped = await sceneSnapshot();
  assert.ok(capped.food.length <= 100, 'consumption must never break the hard food cap');
  assert.equal(new Set(capped.food.map(pellet => pellet.id)).size, capped.food.length);
  if (capped.food.length === 100) await page.getByRole('status').filter({ hasText: '鱼食已足够' }).waitFor();
  await screenshot('11-food-cap');
  await page.keyboard.press('Escape');
  const beforeTapBurst = (await sceneSnapshot()).taps.length;
  for (let i = 0; i < 6; i++) await pointClick(tapPoint);
  const newTaps = (await sceneSnapshot()).taps.length - beforeTapBurst;
  assert.ok(newTaps >= 1 && newTaps <= 3, `tap throttle allowed ${newTaps} of 6 rapid taps`);
  await page.getByRole('button', { name: '鱼食罐', exact: true }).click();
  check('Feeding cap remains bounded with consumption and tap throttling still works', { newTaps, food: capped.food.length });

  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('button', { name: '鱼食罐', exact: true }).getAttribute('aria-pressed'), 'false');
  assert.equal(await page.locator('.dsh-aq-overlay').count(), 1);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.dsh-aq-overlay').count(), 0);
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === '小鱼缸');
  check('Two-level Escape and focus restoration');

  await open();
  await page.mouse.click(620, 16);
  await page.waitForFunction(() => !document.querySelector('.dsh-aq-overlay'));
  check('A single blank-overlay click closes the aquarium');

  await page.evaluate(() => globalThis.__DSH_AQUARIUM_TEST__.writeConfig([{ op: 'set', path: ['qualityMode'], value: 'eco' }]));
  await page.waitForFunction(() => globalThis.__DSH_AQUARIUM_TEST__.readConfig().value.qualityMode === 'eco');
  await page.reload();
  await page.waitForLoadState('domcontentloaded');
  await page.getByRole('button', { name: '小鱼缸', exact: true }).waitFor();
  await dismissHostDialogs(page);
  await page.waitForFunction(() => globalThis.__DSH_AQUARIUM_TEST__.readConfig?.().status === 'ready');
  assert.equal(await page.evaluate(() => globalThis.__DSH_AQUARIUM_TEST__.readConfig().value.qualityMode), 'eco');
  await page.evaluate(() => globalThis.__DSH_AQUARIUM_TEST__.writeConfig([{ op: 'set', path: ['qualityMode'], value: 'auto' }]));
  await page.waitForFunction(() => globalThis.__DSH_AQUARIUM_TEST__.readConfig().value.qualityMode === 'auto');
  check('Quality selection survives a page reload (host-owned persistence)');

  await page.evaluate(() => globalThis.__DSH_AQUARIUM_TEST__.setTheme('dark'));
  await open();
  await page.waitForFunction(() => globalThis.__DSH_AQUARIUM_TEST__.scene.snapshot().light > 0.9);
  await screenshot('07-dark-automatic-light');
  await page.getByRole('button', { name: '灯光', exact: true }).click();
  await page.evaluate(() => globalThis.__DSH_AQUARIUM_TEST__.setTheme('light'));
  await page.evaluate(() => globalThis.__DSH_AQUARIUM_TEST__.setTheme('dark'));
  await page.waitForFunction(() => globalThis.__DSH_AQUARIUM_TEST__.scene.snapshot().light < 0.1);
  await screenshot('08-dark-manual-off');
  await close();
  await open();
  assert.ok((await sceneSnapshot()).light > 0.9);
  check('Host theme event, manual priority, reset on reopening');
  await page.keyboard.press('Tab');
  for (let i = 0; i < 9; i++) {
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement.closest('.dsh-aq-overlay') !== null), true);
  }
  await page.keyboard.press('Shift+Tab');
  assert.equal(await page.evaluate(() => document.activeElement.closest('.dsh-aq-overlay') !== null), true);
  check('Keyboard focus stays inside aquarium');

  const pause = await page.evaluate(async () => {
    const s = globalThis.__DSH_AQUARIUM_TEST__.scene;
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
    const before = s.snapshot();
    await new Promise(resolve => setTimeout(resolve, 200));
    const after = s.snapshot();
    delete document.hidden;
    document.dispatchEvent(new Event('visibilitychange'));
    return { before, after };
  });
  assert.equal(pause.before.renders, pause.after.renders);
  assert.equal(pause.before.time, pause.after.time);
  assert.equal(pause.after.running, false);
  check('Visibility-event pause stops rendering and fixed simulation (injected hidden state)');

  await page.locator('[data-aquarium-canvas]').evaluate(canvas => {
    globalThis.__aqLost = canvas.getContext('webgl2').getExtension('WEBGL_lose_context');
    globalThis.__aqLost.loseContext();
  });
  await page.getByRole('status').filter({ hasText: '图形连接暂时中断' }).waitFor();
  await page.waitForTimeout(300);
  await page.evaluate(() => globalThis.__aqLost.restoreContext());
  await page.waitForFunction(() => globalThis.__DSH_AQUARIUM_TEST__.scene?.snapshot().running === true);
  check('Real WebGL context loss and reconstruction');

  await close();
  expectWebglFailure = true;
  await page.evaluate(() => {
    globalThis.__aqOrigContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, ...args) {
      return String(type).startsWith('webgl') ? null : globalThis.__aqOrigContext.call(this, type, ...args);
    };
  });
  await page.getByRole('button', { name: '小鱼缸', exact: true }).click();
  await page.locator('.dsh-aq-error').waitFor();
  assert.ok((await page.locator('.dsh-aq-error').innerText()).includes('暂时无法打开三维鱼缸'));
  await screenshot('10-webgl-unavailable');
  await page.evaluate(() => { HTMLCanvasElement.prototype.getContext = globalThis.__aqOrigContext; });
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await page.waitForFunction(() => !!globalThis.__DSH_AQUARIUM_TEST__.scene);
  expectWebglFailure = false;
  await close();
  check('WebGL unavailable shows an explicit error; retry recovers');

  await page.evaluate(() => globalThis.__DSH_AQUARIUM_TEST__.setTheme('light'));
  await page.getByRole('button', { name: '插件', exact: true }).first().click();
  await page.getByRole('button', { name: '小鱼缸', exact: true }).waitFor();
  await open();
  await screenshot('09-host-plugin-page');
  await close();
  await page.getByRole('button', { name: '自动化任务', exact: true }).first().click();
  await open();
  await close();
  check('Single global entry across Plugins and Automation panels');

  // Disable all off-machine traffic. The host remains local and is not a backend dependency of this plugin.
  const blocked = [];
  await context.route('**/*', route => {
    const requestUrl = new URL(route.request().url());
    if (['http:', 'https:'].includes(requestUrl.protocol) && requestUrl.hostname !== '127.0.0.1') {
      blocked.push(requestUrl.origin);
      return route.abort();
    }
    return route.continue();
  });
  const cycles = [];
  for (let i = 0; i < 20; i++) {
    const ms = await open();
    const snap = await sceneSnapshot();
    cycles.push({ ms, memory: snap.memory, calls: snap.calls });
    await close();
    assert.equal(await page.getByRole('button', { name: '小鱼缸', exact: true }).count(), 1);
  }
  assert.ok(cycles.every(c => c.memory.geometries === cycles[0].memory.geometries));
  assert.ok(cycles.every(c => c.memory.textures === cycles[0].memory.textures));
  check('20 open/close cycles: no duplicate entry, canvas or growing renderer resource count', cycles);
  check('External traffic blocked; local scene still opens', { blocked });
  await open();
  await page.waitForTimeout(4600);
  const baseline = await sceneSnapshot();
  check('Framework performance sample (not a Desktop GPU-memory claim)', baseline);
  await close();
  assert.equal(errors.length, 0, errors.join('\n'));
  check('No page errors or shader compile failures');

  // A fresh page delays the renderer chunk so closing mid-load can be exercised.
  const slow = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await slow.addInitScript(() => { globalThis.__DSH_AQUARIUM_TEST__ = {}; });
  const slowPage = await slow.newPage();
  await slowPage.route('**/client.scene.js*', async route => {
    await new Promise(resolve => setTimeout(resolve, 900));
    await route.continue();
  });
  await slowPage.goto(url);
  await slowPage.waitForLoadState('domcontentloaded');
  await slowPage.getByRole('button', { name: '小鱼缸', exact: true }).waitFor();
  await dismissHostDialogs(slowPage);
  await slowPage.waitForFunction(() => globalThis.__DSH_AQUARIUM_TEST__.readConfig?.().status === 'ready');
  await slowPage.getByRole('button', { name: '小鱼缸', exact: true }).click();
  await slowPage.getByRole('status').filter({ hasText: '正在装满一缸清水' }).waitFor();
  await slowPage.keyboard.press('Escape');
  await slowPage.waitForFunction(() => !document.querySelector('.dsh-aq-overlay'));
  await slowPage.waitForTimeout(1400);
  assert.equal(await slowPage.locator('.dsh-aq-overlay').count(), 0);
  assert.equal(await slowPage.locator('[data-aquarium-canvas]').count(), 0);
  await slowPage.getByRole('button', { name: '小鱼缸', exact: true }).click();
  await slowPage.waitForFunction(() => !!globalThis.__DSH_AQUARIUM_TEST__.scene);
  await slowPage.getByRole('button', { name: '关闭鱼缸', exact: true }).first().click();
  await slowPage.waitForFunction(() => !globalThis.__DSH_AQUARIUM_TEST__.scene);
  check('Closing during initialization never reopens the scene');
  await slow.close();
  result.status = 'passed';
} catch (error) {
  result.status = 'failed';
  result.failure = String(error.stack || error);
  await screenshot('failure');
  console.error(error);
  process.exitCode = 1;
} finally {
  await fs.writeFile(path.join(out, 'host-results.json'), JSON.stringify(result, null, 2));
  const video = page.video();
  await context.close();
  await video.saveAs(path.join(out, 'p1-host-interactions.webm'));
  await video.delete();
  await browser.close();
}

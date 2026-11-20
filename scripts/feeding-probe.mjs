// P4 feeding probe: real fish, real food consumption and the two jar cursors.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../', import.meta.url));
const out = path.join(root, '.screenshots');
await mkdir(out, { recursive: true });
const result = await build({
  absWorkingDir: root, entryPoints: ['scripts/preview/entry.jsx'], bundle: true,
  write: false, format: 'iife', platform: 'browser', target: 'chrome130', jsx: 'transform',
  loader: { '.css': 'text', '.glb': 'binary' },
  define: { 'process.env.NODE_ENV': '"production"' },
});
await writeFile(path.join(out, 'preview.js'), result.outputFiles[0].text);
await writeFile(path.join(out, 'feeding-probe.html'), `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>P4 feeding probe</title><style>
html,body,#root,.shell{margin:0;width:100%;height:100%;overflow:hidden}.shell{position:relative}.slot-layer{position:absolute;inset:0}
</style></head><body><div id="root"></div><script src="preview.js"></script></body></html>`);

const edge = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find(candidate => existsSync(candidate));
const browser = await chromium.launch(edge ? { executablePath: edge, headless: true } : { channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
const errors = [];
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
page.on('pageerror', error => errors.push(String(error)));

try {
  // 鱼食库存由账本持有：先攒够一个单位再投，否则点水面投不出食物（这是 P5 后的规则）。
  await page.goto(pathToFileURL(path.join(out, 'feeding-probe.html')).href + '?ledger=returning');
  await page.waitForSelector('canvas[data-aquarium-canvas]', { timeout: 20000 });
  await page.waitForFunction(() => globalThis.__DSH_AQUARIUM_TEST__?.scene?.snapshot().fish === 7, { timeout: 20000 });
  await page.evaluate(() => window.__preview.setTokens(0));
  await page.evaluate(() => window.__preview.setTokens(6_000_000));
  await page.getByRole('button', { name: '鱼食罐', exact: true }).click();
  const toolCursor = await page.getByRole('button', { name: '鱼食罐', exact: true }).evaluate(node => node.style.cursor);
  assert.match(decodeURIComponent(toolCursor), /rotate\(-18 16 16\)/);

  const feedPoint = await page.evaluate(() => globalThis.__DSH_AQUARIUM_TEST__.scene.project({ x: 0.025, y: 0.269, z: -0.01 }));
  await page.mouse.move(feedPoint.x, feedPoint.y);
  const waterCursor = await page.locator('canvas[data-aquarium-canvas]').evaluate(node => node.style.cursor);
  assert.match(decodeURIComponent(waterCursor), /rotate\(-54 16 16\)/);
  await page.mouse.click(feedPoint.x, feedPoint.y);

  const states = new Set();
  let peakFood = 0;
  let gatherShot = false;
  for (let sample = 0; sample < 70; sample++) {
    const snapshot = await page.evaluate(() => globalThis.__DSH_AQUARIUM_TEST__.scene.snapshot());
    snapshot.fishState.forEach(fish => states.add(fish.behavior));
    peakFood = Math.max(peakFood, snapshot.food.length);
    if (!gatherShot && states.has('compete')) {
      await page.screenshot({ path: path.join(out, 'p4-feeding-gather.png') });
      gatherShot = true;
    }
    if (snapshot.fishState.some(fish => fish.eaten > 0) && snapshot.food.length === 0) break;
    await page.waitForTimeout(100);
  }
  const feeding = await page.evaluate(() => globalThis.__DSH_AQUARIUM_TEST__.scene.snapshot());
  assert.ok(states.has('gather'), `missing gather in ${[...states].join(',')}`);
  assert.ok(states.has('compete'), `missing compete in ${[...states].join(',')}`);
  assert.ok(feeding.fishState.some(fish => fish.eaten > 0), 'fish should consume real pellets');
  assert.equal(feeding.food.length, 0, 'the first four pellets should be eaten');
  assert.ok(feeding.fishState.some(fish => fish.behavior === 'scatter'), 'fish should disperse after the food is gone');
  await page.waitForTimeout(900);
  await page.screenshot({ path: path.join(out, 'p4-feeding-scatter.png') });

  await page.waitForTimeout(5000);
  const settled = await page.evaluate(() => globalThis.__DSH_AQUARIUM_TEST__.scene.snapshot());
  assert.ok(settled.fishState.every(fish => fish.behavior === 'cruise'), 'all fish should resume cruising within five seconds');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('canvas[data-aquarium-canvas]').evaluate(node => node.style.cursor), 'default');
  assert.deepEqual(errors, []);

  const summary = {
    fish: settled.fish, peakFood, states: [...states], totalEaten: settled.fishState.reduce((sum, fish) => sum + fish.eaten, 0),
    restingCursor: '-18deg', waterCursor: '-54deg', settled: settled.fishState.map(fish => fish.behavior), errors,
  };
  await writeFile(path.join(out, 'p4-feeding-probe.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
} finally {
  await browser.close();
}

// P4 tap probe: a real glass click must frighten both species, then settle.
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
await writeFile(path.join(out, 'tap-probe.html'), `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>P4 tap probe</title><style>
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
const snapshot = () => page.evaluate(() => globalThis.__DSH_AQUARIUM_TEST__.scene.snapshot());

try {
  await page.goto(pathToFileURL(path.join(out, 'tap-probe.html')).href + '?ledger=returning');
  await page.waitForSelector('canvas[data-aquarium-canvas]', { timeout: 20000 });
  await page.waitForFunction(() => globalThis.__DSH_AQUARIUM_TEST__?.scene?.snapshot().fish === 7, null, { timeout: 20000 });
  // 后半段要用鱼食证明「受惊优先于觅食」，库存得先攒够一批。
  await page.evaluate(() => window.__preview.setTokens(0));
  await page.evaluate(() => window.__preview.setTokens(6_000_000));
  await page.waitForTimeout(400);
  const before = await snapshot();
  assert.ok(before.fishState.every(fish => fish.reaction === 'calm'), JSON.stringify(before.fishState.map(fish => ({ species: fish.species, reaction: fish.reaction, startles: fish.startles }))));

  const tapLocal = { x: -0.09, y: 0.15, z: 0.119 };
  const tapPoint = await page.evaluate(point => globalThis.__DSH_AQUARIUM_TEST__.scene.project(point), tapLocal);
  const hit = await page.evaluate(point => globalThis.__DSH_AQUARIUM_TEST__.scene.pick(point.x, point.y), tapPoint);
  assert.equal(hit.kind, 'glass');
  await page.mouse.click(tapPoint.x, tapPoint.y);

  const states = new Set();
  let fled = null;
  for (let sample = 0; sample < 40; sample++) {
    const current = await snapshot();
    current.fishState.forEach(fish => states.add(fish.reaction));
    if (current.fishState.some(fish => fish.reaction === 'flee')) { fled = current; break; }
    await page.waitForTimeout(30);
  }
  assert.ok(fled, 'at least one fish should enter the flee state');
  assert.ok(fled.fishState.every(fish => fish.startles === 1), 'every fish should hear the tap exactly once');
  await page.screenshot({ path: path.join(out, 'p4-tap-flee.png') });

  await page.waitForTimeout(450);
  const escape = await snapshot();
  const displacements = escape.fishState.map((fish, index) => {
    const old = before.fishState[index];
    return Math.hypot(fish.x - old.x, fish.y - old.y, fish.z - old.z);
  });
  assert.ok(Math.max(...displacements) > 0.02, `fish should visibly dart, got ${displacements.map(n => n.toFixed(3)).join(',')}`);
  assert.ok(escape.fishState.every(fish => fish.startles === 1), 'the retained ripple must not retrigger fish');

  for (let sample = 0; sample < 30; sample++) {
    const current = await snapshot();
    current.fishState.forEach(fish => states.add(fish.reaction));
    if (current.fishState.every(fish => fish.reaction === 'settle' || fish.reaction === 'calm')) break;
    await page.waitForTimeout(50);
  }
  assert.ok(states.has('alert') && states.has('flee') && states.has('settle'), `missing reaction phase in ${[...states].join(',')}`);
  await page.screenshot({ path: path.join(out, 'p4-tap-settle.png') });
  await page.waitForTimeout(2800);
  const settled = await snapshot();
  assert.ok(settled.fishState.every(fish => fish.reaction === 'calm'), 'all fish should calm down');
  assert.ok(settled.fishState.every(fish => fish.behavior === 'cruise'), 'all fish should resume their normal behavior');

  // Feeding must yield to fright, then rediscover the remaining pellets.
  await page.getByRole('button', { name: '鱼食罐', exact: true }).click();
  const feedPoint = await page.evaluate(() => globalThis.__DSH_AQUARIUM_TEST__.scene.project({ x: 0.025, y: 0.269, z: -0.01 }));
  await page.mouse.click(feedPoint.x, feedPoint.y);
  await page.waitForFunction(() => globalThis.__DSH_AQUARIUM_TEST__.scene.snapshot().fishState.some(fish => ['gather', 'compete'].includes(fish.feeding)), null, { timeout: 5000 });
  await page.keyboard.press('Escape');
  await page.mouse.click(tapPoint.x, tapPoint.y);
  await page.waitForTimeout(120);
  const interrupted = await snapshot();
  assert.ok(interrupted.fishState.every(fish => fish.startles === 2), 'the second tap should be heard once by every fish');
  assert.ok(interrupted.fishState.every(fish => fish.feeding === 'cruise'), 'fright should release every feeding target');
  await page.waitForTimeout(3600);
  const resumed = await snapshot();
  assert.ok(resumed.fishState.every(fish => fish.reaction === 'calm'));
  assert.ok(resumed.fishState.some(fish => fish.feeding !== 'cruise'), 'fish should rediscover remaining food after settling');
  assert.deepEqual(errors, []);

  const summary = {
    fish: settled.fish, states: [...states], startles: interrupted.fishState.map(fish => fish.startles),
    maxDisplacement: Math.max(...displacements), settled: settled.fishState.map(fish => fish.reaction),
    feedingInterrupted: true, feedingResumed: true, errors,
  };
  await writeFile(path.join(out, 'p4-tap-probe.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
} finally {
  await browser.close();
}

// Offline probe: 鱼食库存闭环 —— 兑换只入队，手动投喂才消耗，徽章常驻显示库存。
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
  define: { 'process.env.NODE_ENV': '"production"', __AQ_PLUGIN_ROOT__: '"probe"' },
});
await writeFile(path.join(out, 'preview.js'), result.outputFiles[0].text);
await writeFile(path.join(out, 'autofeed-probe.html'), `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>P4 feed stock probe</title><style>
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
  // returning = 已有账本、没有待投放的库存，从零开始数。
  await page.goto(pathToFileURL(path.join(out, 'autofeed-probe.html')).href + '?mode=closed&ledger=returning');
  await page.waitForFunction(() => !!globalThis.__preview?.readLedger, { timeout: 20000 });

  // 1) 兑换只入队：关着缸换到 5 粒，徽章要立刻显示 5，缸里一粒也没落。
  await page.evaluate(() => window.__preview.setTokens(1_000_000));
  const credited = await page.evaluate(() => window.__preview.setTokens(1_000_000 + 6_000_000));
  assert.equal(credited.foodQueue, 5, 'the exchange queues five scoops');
  assert.equal(credited.delivered, 0, 'nothing has been fed yet');
  const badge = (await page.locator('.dsh-aq-entry-badge').textContent()).trim();
  assert.equal(badge, '5', 'the badge mirrors the stock');
  await page.screenshot({ path: path.join(out, 'p4-feed-stock-badge.png') });

  // 2) 开缸不会偷偷把库存倒进缸里。
  await page.locator('.dsh-aq-entry').click();
  await page.waitForSelector('canvas[data-aquarium-canvas]', { timeout: 20000 });
  await page.waitForFunction(() => globalThis.__DSH_AQUARIUM_TEST__?.scene?.snapshot().fish === 7, { timeout: 20000 });
  await page.waitForTimeout(1200);
  const opened = await page.evaluate(() => ({
    ledger: window.__preview.readLedger(),
    food: window.__DSH_AQUARIUM_TEST__.scene.snapshot().food.length,
  }));
  assert.equal(opened.food, 0, 'opening the tank must not empty the jar');
  assert.equal(opened.ledger.foodQueue, 5, 'the stock waits for a manual tap');

  // 按钮副标题与右下角角标都必须报库存，且单位是「勺」：曾经写死「粒 · 4」，
  // 库存 0 时也显示 4，用户点下去才被告知已经喂完。
  const labels = await page.evaluate(() => ({
    stock: document.querySelector('.dsh-aq-tool [data-stock]')?.textContent ?? '',
    badge: document.querySelector('.dsh-aq-badge')?.textContent ?? '',
  }));
  assert.equal(labels.stock, '库存 5 勺', `the jar button reports real stock, got ${labels.stock}`);
  assert.ok(labels.badge.includes('库存 5 勺'), `the corner badge also carries stock, got ${labels.badge}`);

  // 3) 一次点击只舀一勺：库存 −1，水里多一小撮（LIMITS.batch = 4 粒）。
  //    以前一次点掉 4 粒库存，5 粒只能喂一次多一点，页面还写着「4 粒」。
  await page.getByRole('button', { name: '鱼食罐', exact: true }).click();
  const point = await page.evaluate(() => globalThis.__DSH_AQUARIUM_TEST__.scene.project({ x: 0.025, y: 0.269, z: -0.01 }));
  await page.mouse.click(point.x, point.y);
  await page.waitForTimeout(700);
  const first = await page.evaluate(() => ({
    ledger: window.__preview.readLedger(),
    food: window.__DSH_AQUARIUM_TEST__.scene.snapshot().food.length,
  }));
  assert.equal(first.ledger.foodQueue, 4, 'one click costs exactly one scoop');
  assert.equal(first.ledger.delivered, 1, 'the scoop is booked as fed');
  assert.equal(first.food, 4, `a scoop pours four pellets, got ${first.food}`);
  await page.screenshot({ path: path.join(out, 'p4-feed-stock.png') });

  // 4) 把剩下四勺逐次喂完：五勺喂完才空罐，账本仍然对得上。
  for (let i = 0; i < 4; i += 1) {
    await page.mouse.click(point.x, point.y);
    await page.waitForTimeout(700);
  }
  const second = await page.evaluate(() => window.__preview.readLedger());
  assert.equal(second.foodQueue, 0, 'five clicks empty the jar');
  assert.equal(second.delivered, 5, 'the books still add up');
  assert.equal(second.delivered + second.foodQueue, second.earned,
    'fed + queued = credited（returning 账本没有初装 5 勺）');

  // 5) 没库存就喂不出：提示「鱼食已喂完」，账本不动。
  await page.mouse.click(point.x, point.y);
  await page.waitForTimeout(400);
  const empty = await page.evaluate(() => ({
    ledger: window.__preview.readLedger(),
    hint: document.querySelector('.dsh-aq-status')?.textContent ?? '',
  }));
  assert.equal(empty.ledger.delivered, 5, 'an empty jar cannot feed the fish');
  assert.ok(empty.hint.includes('鱼食已喂完'), `expected an out-of-food hint, got ${empty.hint}`);
  const emptyLabel = await page.evaluate(() => document.querySelector('.dsh-aq-tool [data-stock]')?.textContent ?? '');
  assert.equal(emptyLabel, '已喂完', `an empty jar says so before you click, got ${emptyLabel}`);
  await page.screenshot({ path: path.join(out, 'p4-feed-empty.png') });

  // 6) 关缸后兑换继续入队，徽章重新出现。
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
  const requeued = await page.evaluate(() => window.__preview.setTokens(1_000_000 + 12_000_000));
  assert.equal(requeued.foodQueue, 5, 'a closed tank keeps the new batch in the jar');
  assert.equal(requeued.exchanges, 2, 'the second exchange is recorded');
  const badgeAgain = (await page.locator('.dsh-aq-entry-badge').textContent()).trim();
  assert.equal(badgeAgain, '5', 'the badge comes back with the stock');
  await page.screenshot({ path: path.join(out, 'p4-feed-requeued.png') });

  assert.deepEqual(errors, []);
  const summary = { credited, opened, first, second, empty, requeued, badge, badgeAgain, errors };
  await writeFile(path.join(out, 'p4-autofeed-probe.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
} finally {
  await browser.close();
}

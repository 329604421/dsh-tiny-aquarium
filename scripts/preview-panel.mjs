// Builds standalone preview pages for the aquarium floating view, its sidebar
// glyph and the settings page, then screenshots them in the installed Edge so
// the mask, layout and icon can be reviewed without a running DSH session.
import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../', import.meta.url));
const out = path.join(root, '.screenshots');
await mkdir(out, { recursive: true });

// esbuild's native writer can be denied in this workspace; write with Node instead.
async function bundle(entry, file) {
  const result = await build({
    absWorkingDir: root,
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target: 'chrome130',
    jsx: 'transform',
    loader: { '.css': 'text', '.glb': 'binary' },
    define: {
      'process.env.NODE_ENV': '"production"',
      // 与 scripts/build.mjs 一致：提示词里的插件根目录来自这里。
      __AQ_PLUGIN_ROOT__: JSON.stringify(root.replace(/[\\/]+$/, '')),
    },
  });
  await writeFile(path.join(out, file), result.outputFiles[0].text);
}

await bundle('scripts/preview/entry.jsx', 'preview.js');
await bundle('scripts/preview/icons.jsx', 'icons.js');

await writeFile(path.join(out, 'panel-preview.html'), `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>Eco aquarium preview</title>
<style>
  html, body { margin: 0; height: 100%; }
  body { background: #f6f6f2; color: #22302a; font-family: "Segoe UI", "Microsoft YaHei", sans-serif;
         --dsw-bg-elevated: #f5f4ee; --dsw-text-primary: #304b40; }
  body[data-dark='true'] { background: #14171a; color: #e6ebde;
         --dsw-bg-elevated: #1c2024; --dsw-text-primary: #e6ebde; }
  #root, .shell { height: 100%; }
  .shell { position: relative; display: flex; height: 100vh; overflow: hidden; }
  .fake-shell { display: flex; flex: 1; height: 100%; }
  .fake-side { width: 250px; padding: 22px 18px; display: flex; flex-direction: column; gap: 14px; border-right: 1px solid rgba(0,0,0,.06); background: rgba(255,255,255,.5); }
  body[data-dark='true'] .fake-side { background: rgba(255,255,255,.03); border-color: rgba(255,255,255,.06); }
  .fake-side strong { font-size: 15px; }
  .fake-side p { margin: 0; font-size: 13px; opacity: .7; }
  .fake-main { flex: 1; padding: 46px 54px; display: flex; flex-direction: column; gap: 16px; }
  .fake-h { margin: 0; font-size: 28px; font-weight: 600; }
  .fake-p { max-width: 620px; margin: 0; font-size: 14px; line-height: 1.95; opacity: .72; }
  .fake-composer { max-width: 620px; padding: 22px 18px; border: 1px solid rgba(0,0,0,.12); border-radius: 16px; font-size: 14px; opacity: .55; }
  body[data-dark='true'] .fake-composer { border-color: rgba(255,255,255,.14); }
  .slot-layer { position: absolute; inset: 0; }
  .page-layer { position: absolute; inset: 0; overflow: auto; background: #fdfdfa; }
  body[data-dark='true'] .page-layer { background: #15181b; }
</style></head>
<body data-dark="false"><div id="root"></div><script src="preview.js"></script></body></html>
`);

await writeFile(path.join(out, 'icons.html'), `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>Aquarium sidebar glyph</title>
<style>html, body { margin: 0; }</style></head>
<body><div id="root"></div><script src="icons.js"></script></body></html>
`);

const edge = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find(candidate => existsSync(candidate));

const browser = await chromium.launch(edge ? { executablePath: edge, headless: true } : { channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
const problems = [];
page.on('console', message => { if (message.type() === 'error') problems.push(message.text()); });
page.on('pageerror', error => problems.push(String(error)));

const url = pathToFileURL(path.join(out, 'panel-preview.html')).href;
// Every run but the first resumes a ledger that already spent its welcome
// stock, so the fill levels and counts below stay exactly what they say.
const returning = url + '?ledger=returning';
const shot = name => page.screenshot({ path: path.join(out, name + '.png') });
const wait = ms => page.waitForTimeout(ms);

await page.goto(returning);
await page.waitForSelector('canvas[data-aquarium-canvas]', { timeout: 20000 });
await wait(1800);
await shot('overlay-light-1440');

// Wheel zoom: scroll up over the stage until the view reaches its limit.
await page.mouse.move(760, 520);
for (let i = 0; i < 8; i += 1) await page.mouse.wheel(0, -320);
await wait(700);
await shot('overlay-light-zoomed-1440');
const zoomReadout = await page.locator('.dsh-aq-zoom-readout').textContent();
console.log('zoomed to', zoomReadout);
for (let i = 0; i < 8; i += 1) await page.mouse.wheel(0, 320);
await wait(3400);

await page.evaluate(() => window.__preview.setDark(true));
await wait(800);
await shot('overlay-dark-1440');
const canvasBox = await page.locator('canvas[data-aquarium-canvas]').boundingBox();

await page.evaluate(() => window.__preview.setDark(false));
await page.setViewportSize({ width: 720, height: 900 });
await wait(900);
await shot('overlay-light-720');

await page.setViewportSize({ width: 1440, height: 1000 });
await page.evaluate(() => window.__preview.setMode('closed'));
await wait(500);
await shot('entry-closed-1440');

// The entry's water line is the conversion progress: empty, half, almost full,
// then the badge that carries the pellets the full tank turned into. A 3x
// context renders the 58px button large enough to judge the fill.
const entryPage = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 3 });
entryPage.on('pageerror', error => problems.push(String(error)));
// Start closed: an open tank pumps the queue into the scene, which would move
// the welcome pellets out of the badge before the first frame is captured.
await entryPage.goto(url + '?mode=closed&ledger=returning');
await entryPage.waitForFunction(() => !!window.__preview);
await entryPage.waitForSelector('.dsh-aq-entry');
await wait(400);
const entryShot = async name => {
  const box = await entryPage.locator('.dsh-aq-entry').boundingBox();
  await entryPage.screenshot({
    path: path.join(out, name + '.png'),
    clip: { x: box.x - 26, y: box.y - 26, width: box.width + 52, height: box.height + 52 },
  });
};
// A brand-new install: the welcome pellets are already in the badge, with no
// tokens spent and the tank still closed.
const welcomePage = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 3 });
welcomePage.on('pageerror', error => problems.push(String(error)));
await welcomePage.goto(url + '?mode=closed');
await welcomePage.waitForSelector('.dsh-aq-entry-badge');
await wait(400);
const welcomeBadge = (await welcomePage.locator('.dsh-aq-entry-badge').textContent()).trim();
const welcomeLedger = await welcomePage.evaluate(() => window.__preview.readLedger());
if (welcomeBadge !== '5') throw new Error(`fresh install badge shows "${welcomeBadge}", expected 5`);
if (welcomeLedger.earned !== 0) throw new Error('the welcome pellets must not count as earnings');
{
  const box = await welcomePage.locator('.dsh-aq-entry').boundingBox();
  await welcomePage.screenshot({
    path: path.join(out, 'entry-welcome.png'),
    clip: { x: box.x - 26, y: box.y - 26, width: box.width + 52, height: box.height + 52 },
  });
}
console.log('welcome ledger', JSON.stringify(welcomeLedger), 'badge', welcomeBadge);
await welcomePage.close();

await entryShot('entry-fill-000');
await entryPage.evaluate(() => window.__preview.setTokens(1_000_000 + 2_400_000));
await wait(1200);
await entryShot('entry-fill-048');
await entryPage.evaluate(() => window.__preview.setTokens(1_000_000 + 4_950_000));
await wait(1200);
await entryShot('entry-fill-099');
const filled = await entryPage.evaluate(() => window.__preview.readLedger());
await entryPage.evaluate(() => window.__preview.setDark(true));
await wait(700);
await entryShot('entry-dark-fill');
await entryPage.evaluate(() => window.__preview.setDark(false));
await entryPage.evaluate(() => window.__preview.setTokens(1_000_000 + 6_000_000));
await wait(1500);
await entryShot('entry-badge');
const credited = await entryPage.evaluate(() => window.__preview.readLedger());
console.log('entry ledger', JSON.stringify(filled), '→', JSON.stringify(credited));

// The same statistics inside the open view's tool column.
await entryPage.evaluate(() => window.__preview.setMode('overlay'));
await entryPage.waitForSelector('.dsh-aq-token');
await entryPage.evaluate(() => window.__preview.setTokens(1_000_000 + 14_400_000));
await wait(600);
const toolsBox = await entryPage.locator('.dsh-aq-tools').boundingBox();
await entryPage.screenshot({
  path: path.join(out, 'view-tools-token.png'),
  clip: { x: toolsBox.x - 14, y: toolsBox.y - 14, width: toolsBox.width + 28, height: toolsBox.height + 28 },
});
// First click only arms the reset; the label counts down and disarms itself.
await entryPage.locator('.dsh-aq-token-reset').click();
await wait(400);
await entryPage.screenshot({
  path: path.join(out, 'view-tools-reset-armed.png'),
  clip: { x: toolsBox.x - 14, y: toolsBox.y - 14, width: toolsBox.width + 28, height: toolsBox.height + 28 },
});
const armed = await entryPage.locator('.dsh-aq-token-reset').textContent();
await wait(5200);
const disarmed = await entryPage.locator('.dsh-aq-token-reset').textContent();
const stillCredited = await entryPage.evaluate(() => window.__preview.readLedger().observed);
console.log('reset label', JSON.stringify(armed), '→', JSON.stringify(disarmed), 'observed after timeout', stillCredited);
await entryPage.close();

await page.evaluate(() => window.__preview.setTokens(1_000_000 + 12_400_000));
await page.evaluate(() => window.__preview.setMode('page'));
await wait(700);
await shot('settings-light-1440');

// 五个维度合成一块后，每行有三个元素。窄窗口靠 `row-tail` 换行兜底，
// 这里连宽一起拍，免得只有宽屏才对得齐。
await page.setViewportSize({ width: 720, height: 900 });
await wait(500);
await page.locator('.dsh-aq-block-ai').scrollIntoViewIfNeeded();
await wait(200);
await shot('settings-custom-720');
const narrow = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('[data-dimension-row]')];
  return rows.map(row => {
    const tail = row.querySelector('.dsh-aq-row-tail');
    const box = tail?.getBoundingClientRect();
    const parent = row.getBoundingClientRect();
    return { overflows: !!box && (box.left < parent.left - 1 || box.right > parent.right + 1), width: Math.round(box?.width ?? 0) };
  });
});
if (narrow.some(row => row.overflows)) throw new Error('a customization row overflows the page at 720px');
await page.setViewportSize({ width: 1440, height: 1000 });
await wait(400);

// The host's main panel is a clipped flex column, so the page itself has to be
// the scroll container. Never let this regress into a page that silently cuts
// off its lower blocks.
const scroll = await page.evaluate(() => {
  const view = document.querySelector('.dsh-aq-page');
  if (!view) return null;
  const style = getComputedStyle(view);
  const before = view.scrollTop;
  view.scrollTop = view.scrollHeight;
  return {
    overflowY: style.overflowY,
    clientHeight: view.clientHeight,
    scrollHeight: view.scrollHeight,
    before,
    after: view.scrollTop,
  };
});
console.log('settings scroll', JSON.stringify(scroll));
if (!scroll) throw new Error('the settings page is missing');
if (scroll.overflowY !== 'auto' && scroll.overflowY !== 'scroll') {
  throw new Error(`the settings page does not scroll itself (overflow-y: ${scroll.overflowY})`);
}
if (scroll.scrollHeight <= scroll.clientHeight) {
  throw new Error('the settings page is not tall enough to prove scrolling');
}
if (scroll.after <= scroll.before) {
  throw new Error('the settings page refused to scroll to its last block');
}
await wait(400);
await shot('settings-token-light-1440');

// P5: five customization entries; each hands a short `/skill` draft to a new session.
await page.locator('.dsh-aq-block-ai').scrollIntoViewIfNeeded();
await wait(200);
const aiBox = await page.locator('.dsh-aq-block-ai').boundingBox();
await page.screenshot({
  path: path.join(out, 'settings-custom-light-1440.png'),
  clip: { x: aiBox.x - 12, y: aiBox.y - 12, width: aiBox.width + 24, height: aiBox.height + 24 },
});
const prompt = await page.evaluate(() => window.__preview.customPrompt('tank'));
const [promptHead] = prompt.text.split('\n');
// 首行必须是被宿主识别为 skill 手势的 `/name` token：正文靠它注入，草稿本身保持干净。
if (!promptHead.startsWith('/aquarium-custom-tank') && !promptHead.includes(' /aquarium-custom-tank')) {
  throw new Error('prompt does not start with the /skill reference');
}
if (!promptHead.includes('/aquarium-custom-core')) throw new Error('prompt does not reference the core skill');
if (!prompt.text.includes('外形')) throw new Error('prompt does not leave blanks for the user');
if (!prompt.text.includes('batch') && !/（批次 \S+/.test(prompt.text)) throw new Error('prompt carries no batch id');
// 契约留在 skill 里，草稿一旦重新变长就会先在这里失败。
if (prompt.text.includes('assets-src/') || prompt.text.includes('【回报】')) throw new Error('prompt is copying the skill again');
if (prompt.text.length > 400) throw new Error(`prompt is ${prompt.text.length} chars, too long for a draft`);
await page.locator('[data-dimension="tank"]').click();
await wait(250);
const handoff = await page.evaluate(() => window.__preview.lastHandoff());
if (!handoff) throw new Error('the customization button did not hand off to a session');
if (handoff.options.whenDraftExists !== 'append') throw new Error('handoff must append to an existing draft');
if (!handoff.options.prompt.includes(prompt.batchId.slice(0, 4))) throw new Error('handoff prompt lost its batch id');
console.log('custom handoff', JSON.stringify({ promptLength: handoff.options.prompt.length, whenDraftExists: handoff.options.whenDraftExists }));

await page.evaluate(() => window.__preview.setDark(true));
await wait(500);
await page.evaluate(() => { document.querySelector('.dsh-aq-page').scrollTop = 0; });
await wait(300);
await shot('settings-top-dark-1440');
await page.evaluate(() => { const view = document.querySelector('.dsh-aq-page'); view.scrollTop = view.scrollHeight; });
await wait(400);
await shot('settings-dark-1440');

const iconPage = await browser.newPage({ viewport: { width: 760, height: 200 }, deviceScaleFactor: 2 });
await iconPage.goto(pathToFileURL(path.join(out, 'icons.html')).href);
await iconPage.waitForTimeout(300);
await iconPage.screenshot({ path: path.join(out, 'sidebar-glyph.png') });

await browser.close();
console.log('canvas box', JSON.stringify(canvasBox));
console.log(problems.length ? 'page problems:\n' + problems.join('\n') : 'no page errors');



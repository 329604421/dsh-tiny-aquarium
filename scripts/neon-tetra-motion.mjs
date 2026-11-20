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
  absWorkingDir: root, entryPoints: ['scripts/preview/fish-probe.js'], bundle: true,
  write: false, format: 'iife', platform: 'browser', target: 'chrome130',
  loader: { '.css': 'text', '.glb': 'binary' },
  define: { 'process.env.NODE_ENV': '"production"' },
});
await writeFile(path.join(out, 'neon-motion-entry.js'), result.outputFiles[0].text);
await writeFile(path.join(out, 'neon-motion.html'), `<!doctype html>
<html><head><meta charset="utf-8"><style>html,body{margin:0;background:#eef2ef}#root{width:1100px;height:760px}</style></head>
<body><div id="root"></div><script src="neon-motion-entry.js"></script></body></html>`);
const edge = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find(c => existsSync(c));
const browser = await chromium.launch(edge ? { executablePath: edge, headless: true } : { channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1100, height: 760 }, deviceScaleFactor: 1 });
const messages = [];
page.on('console', m => messages.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', e => messages.push(`[pageerror] ${e}`));
await page.goto(pathToFileURL(path.join(out, 'neon-motion.html')).href);
await page.waitForSelector('canvas[data-aquarium-canvas]', { timeout: 20000 });
await page.waitForTimeout(2200);
await page.evaluate(() => window.__api.setZoom(2.2));
await page.waitForTimeout(600);
const shots = [];
for (let i = 0; i < 8; i++) {
  const file = path.join(out, `neon-motion-${i}.png`);
  await page.screenshot({ path: file });
  shots.push(file);
  await page.waitForTimeout(350);
}
const imgs = shots.map((file, i) => `<figure><img src="./neon-motion-${i}.png"><figcaption>${(i * 0.35).toFixed(2)}s</figcaption></figure>`).join('');
await writeFile(path.join(out, 'neon-motion-sheet.html'), `<!doctype html><style>
  body{margin:0;background:#dfe5e0;font:13px "Microsoft YaHei",sans-serif}.grid{display:grid;grid-template-columns:repeat(4,400px);gap:0}
  figure{margin:0;position:relative;overflow:hidden;width:400px;height:300px}img{position:absolute;left:-180px;top:-290px;width:1100px;height:760px}
  figcaption{position:absolute;left:8px;top:6px;color:#fff;background:rgba(0,0,0,.45);padding:1px 6px;border-radius:3px;z-index:2}
</style><div class="grid">${imgs}</div>`);
const sheet = await browser.newPage({ viewport: { width: 1600, height: 600 } });
await sheet.goto(pathToFileURL(path.join(out, 'neon-motion-sheet.html')).href);
await sheet.waitForTimeout(500);
await sheet.screenshot({ path: path.join(out, 'p2-neon-motion.png'), fullPage: true });
console.log(messages.filter(m => !m.startsWith('[log]')).join('\n') || 'console: clean');
await browser.close();

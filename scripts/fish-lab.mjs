// 渲染鱼皮调色台的三视图。用法：node scripts/fish-lab.mjs
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
  absWorkingDir: root, entryPoints: ['scripts/preview/fish-lab.js'], bundle: true,
  write: false, format: 'iife', platform: 'browser', target: 'chrome130',
  loader: { '.glb': 'binary' },
});
await writeFile(path.join(out, 'fish-lab.js'), result.outputFiles[0].text);
await writeFile(path.join(out, 'fish-lab.html'), `<!doctype html>
<html><head><meta charset="utf-8"><style>html,body{margin:0;background:#8f9c98}canvas{display:block;max-width:100%}</style></head>
<body><script src="fish-lab.js"></script></body></html>`);

const edge = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find(c => existsSync(c));
const browser = await chromium.launch(edge ? { executablePath: edge, headless: true } : { channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1300, height: 460 } });
const messages = [];
page.on('console', m => messages.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', e => messages.push(`[pageerror] ${e}`));

await page.goto(pathToFileURL(path.join(out, 'fish-lab.html')).href);
await page.waitForFunction(() => window.__ready || window.__error, { timeout: 20000 }).catch(() => {});
await page.waitForTimeout(400);
await page.screenshot({ path: path.join(out, 'p2-fish-lab.png') });
console.log(messages.filter(m => !m.includes('[log]')).join('\n') || 'console: clean');
await browser.close();

import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../', import.meta.url));
const out = path.join(root, '.screenshots');
await mkdir(out, { recursive: true });

// 三个预设：asset = 形体/近景/泳姿相位，swim = 一个尾拍周期，debug = 鳍位检查
const PRESETS = {
  asset: { entry: 'scripts/preview/clownfish-lab.js', name: 'clownfish-lab', shot: 'p2-clownfish-lab.png', width: 1680, height: 1260 },
  swim: { entry: 'scripts/preview/clownfish-swim.js', name: 'clownfish-swim', shot: 'p2-clownfish-swim.png', width: 2400, height: 1200 },
  debug: { entry: 'scripts/preview/clownfish-debug.js', name: 'clownfish-debug', shot: 'clownfish-debug.png', width: 1840, height: 460 },
};
const preset = PRESETS[process.argv[2] || 'asset'] || PRESETS.asset;
const NAME = preset.name;
const ENTRY = preset.entry;
const SHOT = preset.shot;
const result = await build({
  absWorkingDir: root,
  entryPoints: [ENTRY],
  bundle: true,
  write: false,
  format: 'iife',
  platform: 'browser',
  target: 'chrome130',
  loader: { '.glb': 'binary' },
});
await writeFile(path.join(out, NAME + '.js'), result.outputFiles[0].text);
await writeFile(path.join(out, NAME + '.html'), `<!doctype html>
<html><head><meta charset="utf-8"><style>html,body{margin:0;background:#8f9c98}canvas{display:block;max-width:100%}</style></head>
<body><script src="${NAME}.js"></script></body></html>`);
const edge = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find(candidate => existsSync(candidate));
const browser = await chromium.launch(edge ? { executablePath: edge, headless: true } : { channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: preset.width, height: preset.height } });
const messages = [];
page.on('console', message => messages.push(`[${message.type()}] ${message.text()}`));
page.on('pageerror', error => messages.push(`[pageerror] ${error}`));
await page.goto(pathToFileURL(path.join(out, NAME + '.html')).href);
await page.waitForFunction(() => window.__ready || window.__error, { timeout: 20000 });
await page.waitForTimeout(300);
await page.screenshot({ path: path.join(out, SHOT) });
console.log(JSON.stringify(await page.evaluate(() => window.__clownfish)));
console.log(messages.filter(message => !message.includes('[log]')).join('\n') || 'console: clean');
await browser.close();

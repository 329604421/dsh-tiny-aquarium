import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../', import.meta.url));
const out = path.join(root, '.screenshots');
await mkdir(out, { recursive: true });
const PRESETS = {
  raw: { entry: 'scripts/preview/neon-tetra-raw.js', name: 'neon-tetra-raw', shot: 'p2-neon-tetra-raw.png', width: 1840, height: 460 },
  asset: { entry: 'scripts/preview/neon-tetra-lab.js', name: 'neon-tetra-lab', shot: 'p2-neon-tetra-lab.png', width: 1680, height: 1260 },
  swim: { entry: 'scripts/preview/neon-tetra-swim.js', name: 'neon-tetra-swim', shot: 'p2-neon-tetra-swim.png', width: 2400, height: 1200 },
  debug: { entry: 'scripts/preview/neon-tetra-debug.js', name: 'neon-tetra-debug', shot: 'neon-tetra-debug.png', width: 1840, height: 460 },
};
const preset = PRESETS[process.argv[2] || 'raw'] || PRESETS.raw;
const result = await build({
  absWorkingDir: root, entryPoints: [preset.entry], bundle: true, write: false,
  format: 'iife', platform: 'browser', target: 'chrome130', loader: { '.glb': 'binary' },
});
await writeFile(path.join(out, preset.name + '.js'), result.outputFiles[0].text);
await writeFile(path.join(out, preset.name + '.html'), `<!doctype html>
<html><head><meta charset="utf-8"><style>html,body{margin:0;background:#879792}canvas{display:block;max-width:100%}</style></head>
<body><script src="${preset.name}.js"></script></body></html>`);
const edge = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find(candidate => existsSync(candidate));
const browser = await chromium.launch(edge ? { executablePath: edge, headless: true } : { channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: preset.width, height: preset.height } });
const messages = [];
page.on('console', message => messages.push(`[${message.type()}] ${message.text()}`));
page.on('pageerror', error => messages.push(`[pageerror] ${error}`));
await page.goto(pathToFileURL(path.join(out, preset.name + '.html')).href);
await page.waitForFunction(() => window.__ready || window.__error, { timeout: 20000 });
await page.waitForTimeout(300);
await page.screenshot({ path: path.join(out, preset.shot) });
console.log(JSON.stringify(await page.evaluate(() => window.__neonTetra || window.__error)));
console.log(messages.filter(message => !message.includes('[log]')).join('\n') || 'console: clean');
await browser.close();

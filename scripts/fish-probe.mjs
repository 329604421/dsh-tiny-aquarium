// 鱼群验证：加载独立 probe 页，读 snapshot 判断鱼是否真的进缸、位置是否在
// 水体内、有没有越界或退化成零尺寸。用法：node scripts/fish-probe.mjs
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
await writeFile(path.join(out, 'fish-probe.js'), result.outputFiles[0].text);

await writeFile(path.join(out, 'fish-probe.html'), `<!doctype html>
<html><head><meta charset="utf-8"><style>
  html,body{margin:0;height:100%;background:#eef2ef;font:13px/1.6 "Microsoft YaHei",sans-serif}
  #root{width:100vw;height:100vh}
</style></head><body><div id="root"></div><script src="fish-probe.js"></script></body></html>`);

const edge = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find(c => existsSync(c));

const browser = await chromium.launch(edge ? { executablePath: edge, headless: true } : { channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1100, height: 760 }, deviceScaleFactor: 1 });
const messages = [];
page.on('console', m => messages.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', e => messages.push(`[pageerror] ${e}`));

await page.goto(pathToFileURL(path.join(out, 'fish-probe.html')).href);
await page.waitForSelector('canvas[data-aquarium-canvas]', { timeout: 20000 });
await page.waitForTimeout(2600);

const snap = await page.evaluate(() => window.__snap());
const logs = await page.evaluate(() => window.__logs);

// 采第二个时间点，确认鱼真的在游，而不是静止摆着
await page.waitForTimeout(1200);
const later = await page.evaluate(() => window.__snap());
await page.screenshot({ path: path.join(out, 'p2-fish-probe.png') });

// 近景：镜头推到最近，才看得清鳞片与背腹渐变
await page.evaluate(() => window.__api.setZoom(2.2));
await page.waitForTimeout(900);
await page.screenshot({ path: path.join(out, 'p2-fish-closeup.png') });

console.log('probe logs:', logs.length ? logs.join(' | ') : '(none)');
console.log('fish count:', snap.fish, '| draws:', snap.calls, '| fps:', snap.fps);
if (snap.fishState?.length) {
  for (let i = 0; i < snap.fishState.length; i++) {
    const f = snap.fishState[i];
    const g = later.fishState[i] ?? f;
    const moved = Math.hypot(g.x - f.x, g.y - f.y, g.z - f.z) * 100;
    const inWater = f.y > 0.018 && f.y < 0.267 && Math.abs(f.x) < 0.193 && Math.abs(f.z) < 0.118;
    console.log(`  fish @ ${f.x.toFixed(3)}, ${f.y.toFixed(3)}, ${f.z.toFixed(3)} yaw=${(f.yaw * 180 / Math.PI).toFixed(0)}° rz=${(f.rz * 180 / Math.PI).toFixed(0)}° `
      + `fwd=(${f.fx.toFixed(2)},${f.fy.toFixed(2)},${f.fz.toFixed(2)}) `
      + `${f.pilot ? `pilot y=${(f.pilot.yaw * 180 / Math.PI).toFixed(0)}° p=${(f.pilot.pitch * 180 / Math.PI).toFixed(0)}° r=${(f.pilot.roll * 180 / Math.PI).toFixed(0)}° ${f.pilot.state} v=${(f.pilot.speed * 100).toFixed(2)}cm/s` : ''} `
      + `${inWater ? 'in-water' : 'OUT-OF-BOUNDS'} moved=${moved.toFixed(2)}cm/1.2s`);
  }
}
const noise = messages.filter(m => !m.startsWith('[log]'));
for (const m of messages.filter(x => x.includes('FISH_MESH'))) console.log(m);
console.log(noise.length ? 'console:\n' + noise.join('\n') : 'console: clean');
await browser.close();

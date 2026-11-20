// End-to-end checks for the P5 custom-asset paths that the pure-unit tests
// cannot reach: whether a registered custom .glb actually lands in the scene,
// whether an id that has been unregistered falls back instead of blanking the
// tank, and whether switching the feeding habit repairs out-of-range values.
//
// It renders the real client bundle in headless Edge against the same preview
// page used by `npm run preview`, with `?fish=` / `?scape=` / `?feeding=`
// pretending the profile already carries those ids.
import { build } from 'esbuild';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../', import.meta.url));
const out = path.join(root, '.screenshots');
await mkdir(out, { recursive: true });

const result = await build({
  absWorkingDir: root,
  entryPoints: ['scripts/preview/entry.jsx'],
  bundle: true,
  write: false,
  format: 'iife',
  platform: 'browser',
  target: 'chrome130',
  jsx: 'transform',
  loader: { '.css': 'text', '.glb': 'binary' },
  define: {
    'process.env.NODE_ENV': '"production"',
    __AQ_PLUGIN_ROOT__: JSON.stringify(root.replace(/[\\/]+$/, '')),
  },
});
await writeFile(path.join(out, 'p5-preview.js'), result.outputFiles[0].text);

const pageStyle = `
  html, body { margin: 0; height: 100%; }
  body { background: #f6f6f2; --dsw-bg-elevated: #f5f4ee; --dsw-text-primary: #304b40;
         font-family: "Segoe UI", "Microsoft YaHei", sans-serif; }
  #root, .shell { height: 100%; }
  .shell { position: relative; display: flex; height: 100vh; overflow: hidden; }
  .fake-shell { display: flex; flex: 1; height: 100%; }
  .fake-side { width: 250px; padding: 22px 18px; border-right: 1px solid rgba(0,0,0,.06); }
  .fake-main { flex: 1; padding: 46px 54px; }
  .slot-layer { position: absolute; inset: 0; }
`;
await writeFile(path.join(out, 'p5-preview.html'), `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>P5 custom checks</title>
<style>${pageStyle}</style></head>
<body data-dark="false"><div id="root"></div><script src="p5-preview.js"></script></body></html>
`);

const edge = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find(candidate => existsSync(candidate));

const manifest = JSON.parse(await readFile(path.join(root, 'presets.json'), 'utf8'));
const customFish = manifest.presets.filter(preset => preset.category === 'fish' && preset.origin === 'custom');

const browser = await chromium.launch(edge ? { executablePath: edge, headless: true } : { channel: 'msedge', headless: true });
const problems = [];
const failures = [];
const url = pathToFileURL(path.join(out, 'p5-preview.html')).href;

function check(label, condition, detail) {
  if (condition) console.log('ok   ' + label);
  else { failures.push(label + (detail ? ' — ' + JSON.stringify(detail) : '')); console.log('FAIL ' + label + (detail ? ' ' + JSON.stringify(detail) : '')); }
}

async function open(query) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  page.on('console', message => { if (message.type() === 'error') problems.push(message.text()); });
  page.on('pageerror', error => problems.push(String(error)));
  await page.goto(url + query);
  await page.waitForSelector('canvas[data-aquarium-canvas]', { timeout: 25000 });
  await page.waitForFunction(() => !!window.__DSH_AQUARIUM_TEST__?.scene, null, { timeout: 25000 });
  return page;
}

// 1. Nothing custom registered: the baseline the P3/P4 probes also see.
const plain = await open('?mode=overlay&scape=scape.jungle');
const plainSnap = await plain.evaluate(() => window.__DSH_AQUARIUM_TEST__.scene.snapshot());
check('built-in scene has no custom roots', plainSnap.custom.roots === 0, plainSnap.custom);
check('built-in scene counts both schools', plainSnap.fish === 7, plainSnap.fish);
await plain.close();

// 2. A registered custom fish must be parsed, added to the school list and
//    driven by the same swim solver as the built-ins.
if (customFish.length === 0) {
  console.log('skip custom fish — presets.json has no custom fish entry');
  console.log('     （重新武装这条判据：把归档的探针资产登记回来，然后重跑本脚本）');
  console.log('     cp assets-src/custom-archive/2026-11-20/gold-probe.glb assets-src/models/fish/');
  console.log('     node scripts/custom-asset.mjs add --id fish.gold-probe --file assets-src/models/fish/gold-probe.glb \\');
  console.log('       --display-name 测试金鱼 --license MIT --author probe --params \'{"targetLength":0.06,"count":3,"cruise":0.7}\'');
  console.log('     npm run build && npm run p5:check');
} else {
  const ids = customFish.map(entry => entry.id).join(',');
  const page = await open('?mode=overlay&fish=' + encodeURIComponent(ids));
  await page.waitForTimeout(1200);
  const snap = await page.evaluate(() => window.__DSH_AQUARIUM_TEST__.scene.snapshot());
  const expected = customFish.reduce((sum, entry) => sum + (entry.params?.count ?? 1), 7);
  check('custom fish id reaches the scene', JSON.stringify(snap.custom.fish) === JSON.stringify(customFish.map(e => e.id)), snap.custom.fish);
  // 鱼种由 School 持有并在 dispose 时自清几何/材质，不进 customRoots（那里只放
  // 缸体/灯具/造景这类直接挂在 tank 下、需要单独释放的根节点）。
  check('custom fish is owned by its school, not the asset list', snap.custom.roots === 0, snap.custom.roots);
  check('custom fish joins the school', snap.fish === expected, { got: snap.fish, expected });
  const riding = snap.fishState.filter(entry => !['neon-tetra', 'clownfish'].includes(entry.species));
  check('custom species reports a behaviour', riding.length > 0 && riding.every(entry => typeof entry.behavior === 'string'), riding.slice(0, 1));
  // 位置必须是有限数：NaN 会被 JSON 写成 null，正是「TANK_BOX 厘米制误当米制」
  // 那次事故的表现，所以这条同时把「空间契约」钉住。
  const finite = riding.every(entry => Number.isFinite(entry.x) && Number.isFinite(entry.y) && Number.isFinite(entry.z));
  check('custom fish position is finite', finite, riding.slice(0, 1));
  const inside = riding.every(entry => Math.abs(entry.x) < 0.193 && entry.y > 0.018 && entry.y < 0.267 && Math.abs(entry.z) < 0.118);
  check('custom fish stays inside the glass', inside, riding.slice(0, 2));
  await page.screenshot({ path: path.join(out, 'p5-custom-fish-1440.png') });
  await page.close();
}

// 3. An id whose asset has been archived must fall back to the built-in preset
//    instead of leaving an empty tank (AC-38 的可回退面).
const stale = await open('?mode=overlay&scape=scape.does-not-exist&tank=tank.does-not-exist&lamp=lamp.does-not-exist');
const staleSnap = await stale.evaluate(() => window.__DSH_AQUARIUM_TEST__.scene.snapshot());
check('unknown scape falls back to a real preset', typeof staleSnap.scape.id === 'string' && staleSnap.scape.id.startsWith('scape.'), staleSnap.scape.id);
check('unknown tank falls back', staleSnap.custom.tank === null, staleSnap.custom.tank);
check('unknown lamp falls back', staleSnap.custom.lamp === null, staleSnap.custom.lamp);
check('fallback scene still renders fish', staleSnap.fish === 7 && staleSnap.renders > 0, { fish: staleSnap.fish, renders: staleSnap.renders });
await stale.close();

// 4. Feeding habit switching mutates the weights in place and reports the
//    parameters it had to repair, without rebuilding the scene.
const feeding = await open('?mode=overlay&feeding=feeding.does-not-exist');
const repaired = await feeding.evaluate(() => {
  const scene = window.__DSH_AQUARIUM_TEST__.scene;
  const before = scene.snapshot();
  const state = scene.setFeedingPreset({ noticeMin: 9, scatterMax: -3, competeRadius: 0.05 });
  const after = scene.snapshot();
  return {
    state,
    fishBefore: before.fish, fishAfter: after.fish,
    scapeBefore: before.scape.id, scapeAfter: after.scape.id,
  };
});
check('out-of-range feeding values are repaired', Array.isArray(repaired.state.repaired) && repaired.state.repaired.length >= 2, repaired.state);
check('repaired values fall back to the built-in feel',
  repaired.state.noticeMin === 0.25 && repaired.state.scatterMax === 4.6 && repaired.state.competeRadius === 0.05, repaired.state);
check('feeding switch keeps the same fish', repaired.fishBefore === repaired.fishAfter, { before: repaired.fishBefore, after: repaired.fishAfter });
check('feeding switch keeps the same scape', repaired.scapeBefore === repaired.scapeAfter);
await feeding.close();

await browser.close();

if (problems.length) {
  console.log('page problems:', problems);
  failures.push('page reported ' + problems.length + ' problem(s)');
}
console.log(failures.length ? `\n${failures.length} failure(s)` : '\nall custom checks passed');
process.exitCode = failures.length ? 1 : 0;

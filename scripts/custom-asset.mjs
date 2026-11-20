#!/usr/bin/env node
/**
 * P5 定制资产的登记工具：体检、登记、下线、核对。
 *
 * 刻意做成命令行而不是插件按钮：写文件需要用户授权，会话里由模型执行本脚本，
 * 用户看到的是「跑了什么、结果是什么」，而不是插件偷偷改清单。
 *
 * 用法：
 *   node scripts/custom-asset.mjs list [--category fish]
 *   node scripts/custom-asset.mjs audit --id tank.relic-round --file assets-src/models/tank/relic-round.glb
 *   node scripts/custom-asset.mjs add   --id tank.relic-round --file assets-src/models/tank/relic-round.glb \
 *                                       --display-name "复古圆角缸" --license CC0-1.0 --author 杜春生
 *   node scripts/custom-asset.mjs archive --id tank.relic-round
 *   node scripts/custom-asset.mjs check
 */
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readAsset, GlbError } from './lib/glb.mjs';
import { auditCandidate } from './lib/audit.mjs';
import { CUSTOM_LIMITS, parseCustomId } from '../src/customize.js';
import { createCatalog } from '../src/custom-catalog.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifestPath = path.join(root, 'presets.json');
const archiveRoot = path.join(root, 'assets-src', 'custom-archive');

const CATEGORY_DIR = { tank: 'tank', lamp: 'lamp', fish: 'fish', scape: 'scene' };

const args = process.argv.slice(2);
const command = args.shift() ?? 'list';
function flag(name, fallback) {
  const index = args.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const value = args[index + 1];
  return value === undefined || value.startsWith('--') ? true : value;
}

async function loadManifest() {
  return JSON.parse(await readFile(manifestPath, 'utf8'));
}
async function saveManifest(manifest) {
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
}

const fmt = value => (value === undefined ? '—' : String(value));
const pad = (text, width) => {
  const value = String(text);
  const visual = [...value].reduce((sum, char) => sum + (char.charCodeAt(0) > 127 ? 2 : 1), 0);
  return value + ' '.repeat(Math.max(0, width - visual));
};

function printReport(report) {
  console.log(`\n体检：${report.id}（${report.category}）`);
  for (const item of report.checks) {
    console.log(`  ${item.pass ? 'PASS' : 'FAIL'}  ${pad(item.label, 34)} ${item.detail}`);
  }
  console.log(`  → ${report.pass ? '全部通过，可以登记' : '未通过，不要写进清单'}\n`);
}

async function buildEntry(id, category, file, extra = {}) {
  const parsed = parseCustomId(id);
  if (!parsed) throw new Error(`id 不合法：${id}`);
  const relative = file ? path.relative(root, path.resolve(root, file)).replace(/\\/g, '/') : '';
  const entry = {
    id,
    category,
    version: 1,
    sourceType: category === 'feeding' ? 'params' : 'glb',
    displayName: extra.displayName || id,
    origin: 'custom',
    createdAt: new Date().toISOString(),
    license: extra.license || 'UNSPECIFIED',
    author: extra.author || 'custom',
    source: relative || 'presets.json',
  };
  if (category !== 'feeding') entry.file = 'custom-bundle';
  if (entry.license === 'UNSPECIFIED') {
    // 缺少许可等于不允许发布，体检会拦下来；这里不替用户编一个。
    entry.license = '';
  }

  let stats = null;
  if (relative) {
    const absolute = path.join(root, relative);
    if (!existsSync(absolute)) throw new Error(`找不到资产文件：${relative}`);
    ({ stats } = await readAsset(absolute));
    entry.triangles = stats.triangles;
    entry.textures = stats.images.reduce((max, image) => Math.max(max, image.width, image.height), 0);
    if (category !== 'fish' && stats.bounds) {
      entry.bounds = stats.bounds.size.map(value => Number((value * 100).toFixed(2)));
    }
    entry.animations = stats.animations;
  }
  if (category === 'tank') {
    entry.anchor = extra.anchor || 'tank-local-bottom';
    entry.forward = extra.forward || '+z';
  }
  if (category === 'lamp') entry.anchor = extra.anchor || 'tank-local';
  if (category === 'scape') {
    entry.anchor = extra.anchor || 'tank-local-bottom';
    entry.forward = extra.forward || '+y';
  }
  if (extra.params) entry.params = JSON.parse(extra.params);
  if (extra.collision) entry.collision = JSON.parse(extra.collision);
  return { entry, stats, relative };
}

async function commandAudit() {
  const id = flag('id');
  const category = flag('category') || parseCustomId(id)?.category;
  if (!id || !category) throw new Error('audit 需要 --id <类别>.<slug>');
  const manifest = await loadManifest();
  const existingIds = manifest.presets.map(preset => preset.id);
  const existing = manifest.presets.find(preset => preset.id === id);
  const { entry, stats } = await buildEntry(id, category, flag('file', existing?.source), {
    displayName: flag('display-name'), license: flag('license'), author: flag('author'),
    params: flag('params'), collision: flag('collision'),
  });
  const report = auditCandidate({
    id, category, file: entry.source, stats,
    entry: { ...existing, ...entry, params: entry.params ?? existing?.params, collision: entry.collision ?? existing?.collision },
    existingIds: existingIds.filter(item => item !== id),
  });
  printReport(report);
  if (flag('json')) console.log(JSON.stringify(report, null, 2));
  if (!report.pass) process.exitCode = 1;
  return report;
}

async function commandAdd() {
  const id = flag('id');
  const category = flag('category') || parseCustomId(id)?.category;
  if (!id || !category) throw new Error('add 需要 --id <类别>.<slug>');
  if (!CUSTOM_LIMITS[category]) throw new Error(`未知类别：${category}`);
  const manifest = await loadManifest();
  const existingIds = manifest.presets.map(preset => preset.id);
  if (existingIds.includes(id)) throw new Error(`id 已存在：${id}（定制资产只能新增，不能覆盖）`);

  const { entry, stats } = await buildEntry(id, category, flag('file'), {
    displayName: flag('display-name'), license: flag('license'), author: flag('author'),
    params: flag('params'), collision: flag('collision'),
  });
  const report = auditCandidate({ id, category, file: entry.source, stats, entry, existingIds });
  printReport(report);
  if (!report.pass) {
    console.log('未登记：先修正上面 FAIL 的项，再跑一次 add。');
    process.exitCode = 1;
    return;
  }
  // 内置条目在前，定制按时间倒序；写回时保持数组扁平。
  const builtin = manifest.presets.filter(preset => preset.origin !== 'custom');
  const custom = [entry, ...manifest.presets.filter(preset => preset.origin === 'custom')];
  manifest.presets = [...builtin, ...custom];
  await saveManifest(manifest);
  console.log(`已登记 ${id}（${entry.source}）。下一步：npm run build，然后重启 DSH。`);
}

async function commandArchive() {
  const id = flag('id');
  if (!id) throw new Error('archive 需要 --id <类别>.<slug>');
  const manifest = await loadManifest();
  const entry = manifest.presets.find(preset => preset.id === id);
  if (!entry) throw new Error(`清单里没有 ${id}`);
  if (entry.origin !== 'custom') throw new Error(`${id} 是内置资产，不能下线`);

  const stamp = new Date().toISOString().slice(0, 10);
  const folder = path.join(archiveRoot, stamp);
  await mkdir(folder, { recursive: true });
  const moved = [];
  const source = entry.source && entry.source.endsWith('.glb') ? path.join(root, entry.source) : null;
  if (source && existsSync(source)) {
    const target = path.join(folder, path.basename(source));
    await rename(source, target);
    moved.push(path.relative(root, target).replace(/\\/g, '/'));
  }
  manifest.presets = manifest.presets.filter(preset => preset.id !== id);
  await saveManifest(manifest);

  const logPath = path.join(folder, 'archive.json');
  const log = existsSync(logPath) ? JSON.parse(await readFile(logPath, 'utf8')) : [];
  log.push({ id, archivedAt: new Date().toISOString(), entry, moved });
  await writeFile(logPath, JSON.stringify(log, null, 2) + '\n');

  console.log(`已下线 ${id}`);
  if (moved.length) console.log(`  资产已移入 ${moved.join(', ')}`);
  console.log('  清单条目已移除；配置文件若仍指向它，下次打开鱼缸会自动回退到同类内置资产。');
  console.log(`  回退（恢复）步骤：把文件移回 ${entry.source}，再执行 node scripts/custom-asset.mjs add --id ${id} --file ${entry.source} --display-name "${entry.displayName}"`);
  console.log('  下一步：npm run build，然后重启 DSH。');
}

async function commandList() {
  const manifest = await loadManifest();
  const category = flag('category');
  const rows = manifest.presets.filter(preset => !category || preset.category === category);
  console.log(`\n${pad('id', 30)}${pad('类别', 8)}${pad('来源', 8)}${pad('面数', 8)}${pad('名称', 20)}`);
  for (const preset of rows) {
    console.log(`${pad(preset.id, 30)}${pad(preset.category, 8)}${pad(preset.origin === 'custom' ? 'AI 定制' : '内置', 8)}${pad(fmt(preset.triangles), 8)}${pad(preset.displayName, 20)}`);
  }
  const custom = rows.filter(preset => preset.origin === 'custom');
  console.log(`\n共 ${rows.length} 条，其中定制 ${custom.length} 条。\n`);
}

async function commandCheck() {
  const manifest = await loadManifest();
  const catalog = createCatalog(manifest.presets);
  const problems = [];
  for (const preset of manifest.presets) {
    if (preset.origin !== 'custom') continue;
    if (preset.category === 'feeding') continue;
    if (!preset.source || !preset.source.endsWith('.glb')) { problems.push(`${preset.id}: 缺少资产路径`); continue; }
    const absolute = path.join(root, preset.source);
    if (!existsSync(absolute)) { problems.push(`${preset.id}: 文件不存在 ${preset.source}`); continue; }
    const expectedDir = CATEGORY_DIR[preset.category];
    if (expectedDir && !preset.source.includes(`/${expectedDir}/`)) problems.push(`${preset.id}: 资产不在 assets-src/models/${expectedDir}/ 下`);
    try {
      const { stats } = await readAsset(absolute);
      const limits = CUSTOM_LIMITS[preset.category];
      if (stats.triangles > limits.triangles) problems.push(`${preset.id}: 面数 ${stats.triangles} 超预算 ${limits.triangles}`);
      if (stats.byteLength > limits.bytes) problems.push(`${preset.id}: 体积 ${stats.byteLength} 超预算 ${limits.bytes}`);
    } catch (error) {
      problems.push(`${preset.id}: ${error instanceof GlbError ? error.message : String(error)}`);
    }
  }
  // 有文件但没登记，说明上次 add 失败或漏了登记，构建会看不到它。
  for (const [dir, category] of Object.entries(CATEGORY_DIR)) {
    const folder = path.join(root, 'assets-src', 'models', dir);
    if (!existsSync(folder)) continue;
    const { readdir } = await import('node:fs/promises');
    for (const file of await readdir(folder)) {
      if (!file.toLowerCase().endsWith('.glb')) continue;
      const id = `${category}.${path.basename(file, path.extname(file))}`;
      if (!catalog.getPreset(id)) problems.push(`${id}: 文件在 assets-src 里，但清单没有登记（构建后不会出现）`);
    }
  }
  if (problems.length) {
    console.log('\n发现以下问题：');
    for (const problem of problems) console.log(`  - ${problem}`);
    process.exitCode = 1;
  } else {
    console.log(`\n清单与文件一致：${manifest.presets.length} 条，定制 ${manifest.presets.filter(p => p.origin === 'custom').length} 条。\n`);
  }
}

const commands = { list: commandList, audit: commandAudit, add: commandAdd, archive: commandArchive, check: commandCheck };
try {
  const run = commands[command];
  if (!run) throw new Error(`未知命令：${command}（可用：${Object.keys(commands).join(', ')}）`);
  await run();
} catch (error) {
  console.error(`\n${error.message}\n`);
  process.exitCode = 1;
}

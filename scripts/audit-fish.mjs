#!/usr/bin/env node
/**
 * 入缸体检 (fish admission audit)
 *
 * 对 assets/p2-src/*.glb 逐条测量准入标准里的可量化项，输出人读表格
 * 与 scripts/fish-audit.json。只解析 GLB 容器，不依赖 three / DOM。
 *
 * 用法：node scripts/audit-fish.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const srcDir = path.join(root, 'assets/p2-src');

/* ---------- 准入标准：改标准只改这段 ---------- */
export const STANDARD = Object.freeze({
  common: {
    maxTriangles: 4000,   // 20+ 生物同屏仍保 60fps
    minTriangles: 300,    // 低于此形体撑不住写实
    maxKb: 220,           // 单条未压缩体积，控制随包大小
  },
  // 注意：尺寸不参与判定。这批资产没有一件单位可信（100× 节点缩放 / 厘米当米），
  // 一律在接入时按目标体长重标定；物种是否"太大放不下"由生物学体长人工判定。
  // 鱼：横向游动，长/高比反映物种体形
  fish: { minAspect: 1.5, maxAspect: 6.5, needTexture: true, minTexturePx: 128, needAnim: true },
  // 底栖：贴底爬行，允许无骨骼动画，靠程序化步足
  bottom: { minAspect: 1.0, maxAspect: 4.5, needTexture: true, minTexturePx: 128, needAnim: false },
  // 直立游动（海马）：高大于长，比例判据反转
  upright: { minAspect: 0.35, maxAspect: 1.8, needTexture: true, minTexturePx: 128, needAnim: false },
  // 造景（海葵）：不做比例约束，允许静态 + 顶点着色器脉动
  decor: { minAspect: 0.3, maxAspect: 3.5, needTexture: false, minTexturePx: 0, needAnim: false },
});
/* --------------------------------------------------- */

/**
 * 单件豁免：只给"本项目自制、且走顶点着色器泳姿"的英雄鱼用。
 * 这类资产没有烘焙动画，面数与体积按"2 条同屏"而不是"20 条同屏"算，
 * 所以不套 common 的上限；豁免必须写清理由，避免变成"贴个 PASS"。
 */
const OVERRIDES = {
  'clownfish-ocellaris.glb': {
    maxTriangles: 20000,
    maxKb: 950,
    needAnim: false,
    reason: '本项目自制英雄鱼：用户多视角照片重建的 20k 面写实网格，泳姿由 src/clownfish.js 的分区权重驱动，无烘焙动画',
  },
  'neon-tetra.glb': {
    maxTriangles: 10000,
    maxKb: 400,
    needAnim: false,
    reason: '用户四视图参考的红绿灯：10k 面照片重建网格，5 条共享几何与贴图，泳姿由 src/neon-tetra.js 的分区权重驱动，无烘焙动画',
  },
};

const PROFILES = [
  [/^anemone/, 'decor'], [/^crawfish/, 'bottom'], [/^seahorse/, 'upright'],
];
const TRI_MODES = { 0: 'points', 1: 'lines', 2: 'line_loop', 3: 'line_strip', 4: 'triangles', 5: 'triangle_strip', 6: 'triangle_fan' };

function readGlb(file) {
  const buf = fs.readFileSync(file);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (dv.getUint32(0, true) !== 0x46546c67) throw new Error('not a GLB');
  let offset = 12, json = null, bin = null;
  while (offset < buf.byteLength) {
    const len = dv.getUint32(offset, true);
    const type = dv.getUint32(offset + 4, true);
    const body = buf.subarray(offset + 8, offset + 8 + len);
    if (type === 0x4e4f534a) json = JSON.parse(body.toString('utf8'));
    else if (type === 0x004e4942) bin = body;
    offset += 8 + len + ((4 - (len % 4)) % 4);
  }
  return { bytes: buf.byteLength, json, bin };
}

/** 贴图真实像素：直接读 PNG IHDR / JPEG SOF，不解码位图 */
function imageSize(bin, json, image) {
  if (!bin || image.bufferView === undefined) return null;
  const view = json.bufferViews[image.bufferView];
  const bytes = bin.subarray(view.byteOffset || 0, (view.byteOffset || 0) + view.byteLength);
  if (image.mimeType === 'image/png' && bytes[0] === 0x89 && bytes[1] === 0x50) {
    return { w: bytes.readUInt32BE(16), h: bytes.readUInt32BE(20) };
  }
  if (image.mimeType === 'image/jpeg') {
    let i = 2;
    while (i < bytes.length - 1) {
      if (bytes[i] !== 0xff) { i++; continue; }
      const marker = bytes[i + 1];
      const len = bytes.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { w: bytes.readUInt16BE(i + 7), h: bytes.readUInt16BE(i + 5) };
      }
      i += 2 + len;
    }
  }
  return null;
}

function audit(file) {
  const { bytes, json: g, bin } = readGlb(file);
  const name = path.basename(file);
  const report = { file: name, kb: Math.round(bytes / 1024) };

  /* 尺寸：只信顶点坐标。资产自带的 100× 节点缩放是 Blender 单位残留，不可信 */
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  const attrs = new Set();
  let tris = 0, nodeScale = 1;
  const modes = new Set();
  const walk = (idx, scale) => {
    const node = g.nodes[idx];
    const total = scale * (node.scale ? Math.abs(node.scale[0]) : 1);
    nodeScale = Math.max(nodeScale, total);
    if (node.mesh !== undefined) {
      for (const prim of g.meshes[node.mesh].primitives) {
        modes.add(prim.mode ?? 4);
        Object.keys(prim.attributes).forEach(a => attrs.add(a));
        const acc = g.accessors[prim.attributes.POSITION];
        const idxAcc = prim.indices !== undefined ? g.accessors[prim.indices] : null;
        tris += (prim.mode ?? 4) === 4 ? (idxAcc ? idxAcc.count : acc.count) / 3 : (idxAcc ? idxAcc.count : acc.count);
        for (let k = 0; k < 3; k++) {
          min[k] = Math.min(min[k], acc.min[k]);
          max[k] = Math.max(max[k], acc.max[k]);
        }
      }
    }
    for (const child of node.children || []) walk(child, total);
  };
  for (const idx of g.scenes[g.scene || 0].nodes) walk(idx, 1);

  // 三轴降序：最长=体长，次长=体高，最短=厚度
  const dim = max.map((v, i) => (v - min[i]) * 100).sort((a, b) => b - a);
  report.nodeScale = nodeScale;
  report.unitSuspect = Math.abs(nodeScale - 1) > 0.05;
  report.dimsCm = dim.map(v => +v.toFixed(2));
  report.lengthCm = +dim[0].toFixed(2);
  report.heightCm = +dim[1].toFixed(2);
  report.thickCm = +dim[2].toFixed(2);
  report.aspect = +(dim[0] / (dim[1] || 1)).toFixed(2);
  report.tris = Math.round(tris);
  report.modes = [...modes].map(m => TRI_MODES[m] || m);
  report.attributes = [...attrs];
  report.uv = attrs.has('TEXCOORD_0');
  report.skinned = (g.skins || []).length > 0;

  /* 材质 / 贴图 */
  const mats = g.materials || [];
  report.materials = mats.map(m => {
    const pbr = m.pbrMetallicRoughness || {};
    return {
      name: m.name || '(unnamed)',
      textured: !!pbr.baseColorTexture,
      color: pbr.baseColorFactor ? pbr.baseColorFactor.slice(0, 3).map(v => +v.toFixed(2)) : null,
      unlit: !!m.extensions?.KHR_materials_unlit,
      doubleSided: !!m.doubleSided,
    };
  });
  report.textures = (g.images || []).map(img => ({ ...(imageSize(bin, g, img) || { w: 0, h: 0 }), mime: img.mimeType }));
  report.texturePx = Math.max(0, ...report.textures.map(t => Math.min(t.w, t.h)));
  report.textured = report.texturePx > 0;
  report.outlineMats = report.materials
    .filter(m => !m.textured && m.doubleSided && m.color && m.color.every(v => v < 0.25))
    .map(m => m.name);

  /* 动画 */
  report.animations = (g.animations || []).map(a => {
    let dur = 0;
    const paths = {};
    const drift = [];
    for (const ch of a.channels) {
      dur = Math.max(dur, g.accessors[a.samplers[ch.sampler].input].max?.[0] ?? 0);
      paths[ch.target.path] = (paths[ch.target.path] || 0) + 1;
      if (ch.target.path === 'translation') {
        drift.push(g.nodes[ch.target.node]?.name || String(ch.target.node));
      }
    }
    return { name: a.name || '(unnamed)', duration: +dur.toFixed(3), channels: a.channels.length, paths, drift };
  });
  report.joints = (g.skins || []).reduce((n, s) => n + s.joints.length, 0);
  report.extensions = g.extensionsUsed || [];

  /* 判据 */
  const profile = (PROFILES.find(([re]) => re.test(name)) || [null, 'fish'])[1];
  const override = OVERRIDES[name] || null;
  const S = { ...STANDARD.common, ...STANDARD[profile], ...(override || {}) };
  report.profile = profile;
  report.override = override ? { reason: override.reason } : null;
  const drift = report.animations.flatMap(a => a.drift.map(n => `${a.name}→${n}`))
    .filter(id => /→(Armature|Root|RootNode|Scene)$/i.test(id));
  const checks = {
    aspect: report.aspect >= S.minAspect && report.aspect <= S.maxAspect,
    triangles: report.tris <= S.maxTriangles && report.tris >= S.minTriangles,
    weight: report.kb <= S.maxKb,
    texture: !S.needTexture || report.texturePx >= S.minTexturePx,
    animation: !S.needAnim || report.animations.length > 0,
    swimCycle: !S.needAnim || report.animations.some(a => /swim|normal|idle/i.test(a.name)),
    rootDrift: drift.length === 0,
    noOutline: report.outlineMats.length === 0,
  };
  // 单位异常不算"不合格"，算"接入时必须重标定"，单列出来
  report.checks = checks;
  report.notes = [];
  if (report.unitSuspect) report.notes.push(`节点缩放 ${report.nodeScale}×，接入需重标定`);
  if (!report.uv) report.notes.push('无 UV，贴图只能程序化');
  if (override) report.notes.push(`豁免：${override.reason}`);
  report.failures = Object.entries(checks).filter(([, ok]) => !ok).map(([k]) => k);
  report.verdict = report.failures.length === 0 ? 'PASS' : 'FAIL';
  return report;
}

const files = fs.readdirSync(srcDir).filter(f => f.endsWith('.glb')).sort();
const reports = files.map(f => audit(path.join(srcDir, f)));
fs.writeFileSync(path.join(root, 'scripts/fish-audit.json'),
  JSON.stringify({ generatedAt: new Date().toISOString(), standard: STANDARD, reports }, null, 2));

const pad = (s, n) => String(s).padEnd(n);
console.log(pad('文件', 18) + pad('类型', 8) + pad('体长', 8) + pad('高', 7) + pad('长/高', 7)
  + pad('面数', 6) + pad('体积', 7) + pad('贴图', 8) + pad('动画', 22) + '判定');
console.log('-'.repeat(108));
for (const r of reports) {
  const anim = r.animations.length
    ? `${r.animations.length}×${r.animations[0].name.replace(/^.*\|/, '')} ${r.animations[0].duration}s`
    : '无';
  console.log(
    pad(r.file, 18) + pad(r.profile, 8)
    + pad(r.lengthCm + 'cm', 8) + pad(r.heightCm + 'cm', 7) + pad(r.aspect, 7)
    + pad(r.tris, 6) + pad(r.kb + 'KB', 7)
    + pad(r.texturePx ? r.texturePx + 'px' : '无', 8) + pad(anim, 22)
    + (r.verdict === 'PASS' ? 'PASS' : `FAIL <${r.failures.join(',')}>`));
}
console.log('\n不合格说明：');
for (const r of reports.filter(x => x.failures.length)) {
  console.log(`  ${r.file.padEnd(18)} ${r.failures.join(', ')}${r.notes.length ? ' | ' + r.notes.join('；') : ''}`);
}
const exempted = reports.filter(x => x.override);
if (exempted.length) {
  console.log('\n按单件豁免放行：');
  for (const r of exempted) console.log(`  ${r.file.padEnd(18)} ${r.override.reason}`);
}
console.log('\nJSON -> scripts/fish-audit.json');

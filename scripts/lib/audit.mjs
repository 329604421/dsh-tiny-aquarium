/**
 * 定制资产的体检判据。
 *
 * 一条原则：**判据只写在体检里，不写在提示词的口头要求里**。skill 与提示词引用
 * 同一份 CUSTOM_LIMITS / TANK_BOX，体检脚本执行它们，三者不重复维护。
 */
import {
  CUSTOM_LIMITS, TANK_BOX, FEEDING_PARAMS, isValidCustomId, normalizeFeedingParams, parseCustomId,
} from '../../src/customize.js';

const near = (value, target, tolerance = 0.05) => Math.abs(value - target) <= Math.abs(target) * tolerance;

const check = (key, label, pass, detail = '') => ({ key, label, pass: !!pass, detail });

function sizeCheckBounds(stats, expected) {
  const size = stats?.bounds?.size;
  if (!size) return { pass: false, detail: '资产没有 POSITION min/max，无法测量尺寸' };
  // 资产按米导出（与运行时一致），清单与契约按厘米核对。
  const cm = size.map(value => value * 100);
  const ok = near(cm[0], expected[0]) && near(cm[1], expected[1]) && near(cm[2], expected[2]);
  return {
    pass: ok,
    detail: `实测 ${cm.map(value => value.toFixed(1)).join('×')} cm，要求 ${expected.join('×')} cm（±5%）`,
  };
}

/**
 * @param {object} input
 * @param {string} input.id 候选 id
 * @param {string} input.category tank|lamp|scape|fish|feeding
 * @param {string} [input.file] 资产相对路径，仅用于报告
 * @param {object} [input.stats] assetStats() 的结果；投喂习惯可缺省
 * @param {object} [input.entry] 将被写入清单的条目（含 params / collision / license）
 * @param {string[]} [input.existingIds] 清单里已有的 id
 */
export function auditCandidate({ id, category, file, stats, entry = {}, existingIds = [] }) {
  const limits = CUSTOM_LIMITS[category];
  const checks = [];
  const parsed = parseCustomId(id);

  checks.push(check('id-format', 'id 形如 <类别>.<slug> 且未被占用',
    isValidCustomId(id, category) && !existingIds.includes(id),
    !parsed ? '格式不合法：需要小写 kebab-case，例如 tank.relic-round'
      : parsed.category !== category ? `前缀必须是 ${category}.，当前是 ${parsed.category}.`
        : existingIds.includes(id) ? '与清单里已有条目重名（内置与定制都不能覆盖）' : 'ok'));
  if (!limits) return { id, category, pass: false, checks };

  // 构建按「文件名 = slug」把 GLB 内联成 `类别.slug` 的键，名字不一致就等于没登记。
  if (category !== 'feeding' && typeof file === 'string' && file) {
    const base = file.replace(/\\/g, '/').split('/').pop().replace(/\.glb$/i, '');
    checks.push(check('file-name', '文件名与 id 的 slug 一致', base === parsed?.slug,
      `${base}.glb ↔ ${parsed?.slug ?? '?'}（构建按文件名生成 id）`));
  }

  if (category === 'feeding') {
    const { repaired } = normalizeFeedingParams(entry.params ?? {});
    checks.push(check('feeding-range', '投喂参数全部落在允许区间内', repaired.length === 0,
      repaired.length ? `越界或乱序被回退：${repaired.join(', ')}` : 'ok'));
    checks.push(check('license', '许可与来源齐全',
      !!(entry.license && entry.author && entry.source), entry.license ? 'ok' : 'license / author / source 不能为空'));
    return { id, category, pass: checks.every(item => item.pass), checks, stats: null };
  }

  // 几何与贴图：任何一类都不能空着手进缸。
  checks.push(check('file', '资产文件可读且未超体积预算', !!stats && stats.byteLength <= limits.bytes,
    !stats ? '缺少资产文件或解析失败' : `${(stats.byteLength / 1024).toFixed(0)} KB / 上限 ${(limits.bytes / 1024).toFixed(0)} KB`));
  checks.push(check('geometry', '网格非空、面数在预算内', !!stats && stats.meshes > 0 && stats.triangles > 0 && stats.triangles <= limits.triangles,
    !stats ? '缺少资产文件' : `${stats.meshes} 个网格 / ${stats.triangles} 面（上限 ${limits.triangles}）`));
  const images = stats?.images ?? [];
  const biggest = images.reduce((max, image) => Math.max(max, image.width, image.height), 0);
  const external = images.filter(image => !image.embedded);
  checks.push(check('texture', '贴图内嵌且不超过尺寸上限',
    external.length === 0 && biggest <= limits.texture,
    external.length ? `有 ${external.length} 张外链贴图（uri），必须内嵌` : `${images.length} 张，最大边 ${biggest}px（上限 ${limits.texture}）`));
  checks.push(check('license', '许可与来源齐全', !!(entry.license && entry.author && entry.source),
    entry.license ? 'ok' : 'license / author / source 不能为空'));

  if (category === 'tank') {
    const size = sizeCheckBounds(stats, [TANK_BOX.width, TANK_BOX.height, TANK_BOX.depth]);
    checks.push(check('tank-box', '外框尺寸与固定水体契约一致', size.pass, size.detail));
    checks.push(check('tank-anchor', '锚点与朝向符合缸体约定',
      (entry.anchor ?? 'tank-local-bottom') === 'tank-local-bottom' && (entry.forward ?? '+z') === '+z',
      `anchor=${entry.anchor ?? 'tank-local-bottom'} forward=${entry.forward ?? '+z'}`));
  }

  if (category === 'lamp') {
    checks.push(check('lamp-anchor', '灯具挂在缸体局部坐标上',
      (entry.anchor ?? 'tank-local') === 'tank-local', `anchor=${entry.anchor ?? 'tank-local'}`));
    const params = entry.params ?? {};
    const colorOk = params.colorTemp === undefined || (params.colorTemp >= 2700 && params.colorTemp <= 6500);
    const intensityOk = params.intensity === undefined || (params.intensity >= 0.3 && params.intensity <= 2);
    checks.push(check('lamp-light', '色温与亮度在允许区间',
      colorOk && intensityOk, `colorTemp=${params.colorTemp ?? 4200}K intensity=${params.intensity ?? 1}`));
  }

  if (category === 'fish') {
    const params = entry.params ?? {};
    const lengthOk = params.targetLength >= 0.02 && params.targetLength <= 0.12;
    const countOk = params.count >= 1 && params.count <= 6;
    checks.push(check('fish-params', '体长与数量在缸内容量内', lengthOk && countOk,
      `体长 ${params.targetLength ?? '缺失'} m，数量 ${params.count ?? '缺失'}`));
    checks.push(check('fish-texture', '鱼皮有内嵌颜色贴图', images.length > 0, `${images.length} 张贴图`));
    const size = stats?.bounds?.size;
    const longest = size ? Math.max(...size) : 0;
    const shortest = size ? Math.min(...size) : 0;
    checks.push(check('fish-shape', '体形比例像鱼（最长边 ≥ 最短边 1.6 倍）',
      longest > 0 && longest / Math.max(shortest, 1e-6) >= 1.6,
      size ? `${size.map(value => value.toFixed(2)).join(' × ')}（资产自身单位）` : '无法测量'));
    checks.push(check('fish-animation', '不带内置动画剪辑（泳姿由顶点行波驱动）',
      !stats?.animations?.length,
      stats?.animations?.length
        ? `含动画 ${stats.animations.join(', ')}；与引擎的顶点泳姿叠加会双倍变形，请导出纯静态网格`
        : '无动画剪辑，由顶点行波驱动，需在预览里确认摆尾'));
  }

  if (category === 'scape') {
    const params = entry.params ?? {};
    const layout = Array.isArray(params.layout) ? params.layout : [];
    const collision = Array.isArray(entry.collision) ? entry.collision : [];
    checks.push(check('scape-layout', '给出摆放清单', layout.length > 0, `${layout.length} 处摆放`));
    checks.push(check('scape-collision', '给出占位体', collision.length > 0, `${collision.length} 个占位体`));
    const inside = collision.every(box => {
      const [cx, , cz] = box.center ?? [0, 0, 0];
      const [sx, sy, sz] = box.size ?? [0, 0, 0];
      return Math.abs(cx) + sx / 2 <= Math.abs(TANK_BOX.minX) + 0.001
        && Math.abs(cz) + sz / 2 <= Math.abs(TANK_BOX.minZ) + 0.001
        && sy <= TANK_BOX.waterY;
    });
    checks.push(check('scape-inside', '占位体不越出玻璃与水面', inside, inside ? 'ok' : '有占到缸外或水面之上的体积'));
    const maxFootprint = collision.reduce((max, box) => {
      const [sx, , sz] = box.size ?? [0, 0, 0];
      return Math.max(max, (sx * sz) / (TANK_BOX.width * TANK_BOX.depth));
    }, 0);
    checks.push(check('scape-passage', '最大实体不超过水面积的 55%（留出通行）', maxFootprint <= 0.55,
      `最大实体占底面积 ${(maxFootprint * 100).toFixed(0)}%`));
    const airStone = params.airStone;
    checks.push(check('scape-air', '出气点在缸内', !airStone || (
      Math.abs(airStone[0]) < Math.abs(TANK_BOX.minX) && Math.abs(airStone[2]) < Math.abs(TANK_BOX.minZ)
    ), airStone ? `airStone=${airStone.join(',')}` : '未声明，使用默认出气点'));
  }

  return { id, category, file, pass: checks.every(item => item.pass), checks, stats };
}

/** 供 CLI 与文档共用的一张参数表。 */
export const FEEDING_TABLE = Object.entries(FEEDING_PARAMS)
  .map(([key, spec]) => `${key}: ${spec.min}–${spec.max}（默认 ${spec.fallback}）· ${spec.label}`)
  .join('\n');

/**
 * 清单目录（presets.json）的运行时视图。
 *
 * P1～P4 的资产是写死在代码里的；P5 起清单成为唯一事实来源，定制条目与内置条目
 * 走同一份数据。这里不做 I/O，也不在模块加载时读 JSON：调用方把清单传进来
 * （浏览器里是打包后的 import，体检脚本里是 fs 读出来的对象），便于测试。
 */
import { DEFAULT_PRESET_IDS, normalizeFeedingParams, parseCustomId, TANK_BOX } from './customize.js';
import { SPACE } from './core.js';

/** 设置页的排序：内置在前，定制按时间倒序。 */
export const sortPresets = rows => {
  const builtin = rows.filter(preset => preset.origin !== 'custom');
  const custom = rows
    .filter(preset => preset.origin === 'custom')
    .sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? ''))
      || String(a.id).localeCompare(String(b.id)));
  return [...builtin, ...custom];
};

export function createCatalog(presets = []) {
  const rows = Array.isArray(presets) ? presets.filter(preset => preset && typeof preset.id === 'string') : [];
  /*
   * 内置造景在清单里是 `substrate.*` + `plant.*` 成对登记的（P3 的资产粒度），
   * 而设置页与配置用的是「造景预设」这个粒度。这里把成对的条目合成一条虚拟预设，
   * 让内置与定制走同一个列表，不必为定制再造一套数据结构。
   */
  const scapeGroups = new Map();
  for (const row of rows) {
    if (row.category !== 'substrate' && row.category !== 'plant') continue;
    const presetId = row.params?.presetId;
    if (typeof presetId !== 'string' || !presetId) continue;
    if (!scapeGroups.has(presetId)) {
      scapeGroups.set(presetId, {
        id: presetId, category: 'scape', origin: row.origin ?? 'builtin',
        displayName: row.displayName ?? presetId, parts: [],
      });
    }
    scapeGroups.get(presetId).parts.push(row.id);
  }
  const scapeRows = () => [...scapeGroups.values(), ...rows.filter(row => row.category === 'scape')];
  const rowsOf = category => (category === 'scape' ? scapeRows() : rows.filter(preset => preset.category === category));

  const listPresets = category => sortPresets(rowsOf(category));
  const getPreset = id => rows.find(preset => preset.id === id) ?? scapeGroups.get(id);
  const customPresets = category => listPresets(category).filter(preset => preset.origin === 'custom');
  const isCustom = id => getPreset(id)?.origin === 'custom';

  /** 配置里的 id 可能已下线、拼错或未打包：回退到该类默认条目，再退到第一条内置资产。 */
  function resolvePresetId(id, category) {
    const preset = getPreset(id);
    if (preset && preset.category === category) return { id: preset.id, preset, repaired: false };
    const preferred = getPreset(DEFAULT_PRESET_IDS[category]);
    const fallback = preferred?.category === category
      ? preferred
      : listPresets(category).find(item => item.origin !== 'custom');
    /*
     * 内置鱼种由 src/species.js 的 SPECIES 提供，清单里没有 `fish.*` 行，
     * 但调用方（配置归一化、设置页）仍需要拿到一个非空 id 才能工作。
     * 所以最后一档直接退回该类的默认 id，`preset` 为 null 让调用方自己决定
     * 要不要解释「这条没有清单条目」。
     */
    const fallbackId = fallback?.id ?? DEFAULT_PRESET_IDS[category] ?? '';
    return { id: fallbackId, preset: fallback ?? null, repaired: id !== fallbackId };
  }

  /** 只保留清单里真实存在、且确实属于该类的定制 id。 */
  function sanitizeCustomIds(ids, category) {
    if (!Array.isArray(ids)) return [];
    return ids.filter(id => {
      const parsed = parseCustomId(id);
      return parsed?.category === category && getPreset(id)?.origin === 'custom';
    });
  }

  function feedingPresetOf(id) {
    const preset = getPreset(id);
    if (!preset || preset.category !== 'feeding') {
      return { preset: STANDARD_FEEDING, repaired: id !== undefined && id !== STANDARD_FEEDING.id };
    }
    return { preset, repaired: false };
  }

  function feedingParamsOf(id) {
    const { preset, repaired } = feedingPresetOf(id);
    const { params, repaired: repairedKeys } = normalizeFeedingParams(preset.params ?? {});
    return { params, repaired: repaired || repairedKeys.length > 0, repairedKeys };
  }

  return {
    rows, count: rows.length, listPresets, getPreset, customPresets, isCustom,
    resolvePresetId, sanitizeCustomIds, feedingPresetOf, feedingParamsOf,
  };
}

/** 显示名：内置用本地化键，定制用清单里的字面名称。 */
export function displayNameOf(preset, t = key => key) {
  if (!preset) return '';
  const name = preset.displayName ?? preset.id;
  return name.startsWith('preset.') ? t(name) : name;
}

/** 定制条目在设置页显示的徽标文案键（内置条目返回空串）。 */
export const customBadgeKey = preset => (preset?.origin === 'custom' ? 'customBadge' : '');

/* -------------------------------------------------------------- 缸体与灯具 */

/**
 * 缸体始终使用固定模拟空间。定制条目允许写 bounds 供体检核对，
 * 但运行时坐标一律来自 TANK_BOX——「定制只改外观」是硬契约。
 */
export const tankBoxOf = () => TANK_BOX;

/** 灯具的照明参数；缺省与内置夹灯一致。 */
export function lampParamsOf(preset) {
  const params = preset?.params ?? {};
  const clamp = (value, min, max, fallback) => {
    const n = Number(value);
    return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
  };
  return {
    color: clamp(params.colorTemp, 2700, 6500, 4200),
    intensity: clamp(params.intensity, 0.3, 2, 1),
    angle: clamp(params.angle, 0.5, 1.15, Math.PI / 3.3),
    penumbra: clamp(params.penumbra, 0.1, 0.9, 0.7),
    target: Array.isArray(params.target) ? params.target.slice(0, 3) : [0, 0.05, 0],
  };
}

/* ------------------------------------------------------------------- 造景 */

/** 定制造景的摆放与占位；清单用厘米，运行时统一换成米。 */
export function scapeLayoutOf(preset) {
  const cm = value => (Number.isFinite(Number(value)) ? Number(value) / 100 : 0);
  const layout = Array.isArray(preset?.params?.layout) ? preset.params.layout : [];
  const collision = Array.isArray(preset?.collision) ? preset.collision : [];
  const airStone = Array.isArray(preset?.params?.airStone) ? preset.params.airStone : [-16, 2.1, -8];
  return {
    instances: layout.map((item, index) => ({
      id: `${preset.id}.${index}`,
      position: [cm(item.x), cm(item.y), cm(item.z)],
      scale: Number.isFinite(Number(item.scale)) ? Number(item.scale) : 1,
      rotY: ((Number(item.rotY) || 0) * Math.PI) / 180,
    })),
    collision: collision.map(box => {
      const volume = {
        type: box.type ?? 'box',
        kind: box.kind ?? 'solid',
        center: (box.center ?? [0, 0, 0]).map(cm),
      };
      if (volume.type === 'cylinder') {
        volume.radius = cm(box.radius);
        volume.height = cm(box.height);
      } else {
        volume.size = (box.size ?? [1, 1, 1]).map(cm);
      }
      return volume;
    }),
    airStone: airStone.slice(0, 3).map(cm),
    sway: Number.isFinite(Number(preset?.params?.sway)) ? Number(preset.params.sway) : 1,
  };
}

/* ------------------------------------------------------------------- 鱼群 */

/** 定制鱼种：把清单 params 补齐成 School 需要的物种对象。 */
export function customSpeciesOf(preset) {
  const params = preset?.params ?? {};
  const number = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
  return {
    id: preset.id,
    name: preset.displayName ?? preset.id,
    targetLength: number(params.targetLength, 0.05),
    count: Math.max(1, Math.min(6, Math.round(number(params.count, 2)))),
    facing: number(params.facing, -1),
    axis: {
      along: number(params.axis?.along, 0),
      lift: number(params.axis?.lift, 1),
      dorsal: number(params.axis?.dorsal, 1),
    },
    rig: typeof params.rig === 'string' ? params.rig : 'smooth',
    textured: params.textured !== false,
    cruise: number(params.cruise, 0.7),
    heightBase: number(params.heightBase, 0.1),
    heightStep: number(params.heightStep, 0.03),
    // 游动空间必须与内置鱼群完全同一份米制契约。TANK_BOX 是给清单/资产体检用的
    // 厘米制外框（没有 floorY），直接当 space 会让 floorY 变成 undefined，
    // 夹取后 y 成为 NaN；这里显式指向 core 的 SPACE。
    space: SPACE,
  };
}

export const STANDARD_FEEDING = Object.freeze({
  id: 'feeding.standard', category: 'feeding', origin: 'builtin', displayName: 'preset.feeding.standard', params: {},
});

import z from '@deepseek-ai/schemastery';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Token statistics persisted next to the other live preferences. The whole
 * object is volatile and written as one value: baselines and balances must
 * land together, or a restart would count the same tokens twice.
 */
const Ledger = z.object({
  v: z.number().default(1),
  epochAt: z.number().default(0),
  observed: z.number().default(0),
  pending: z.number().default(0),
  foodQueue: z.number().default(0),
  earned: z.number().default(0),
  exchanges: z.number().default(0),
  // Pellets that actually went into the tank; the settings page shows it so
  // "credited" and "queued" can be reconciled after a few feedings.
  delivered: z.number().default(0),
  // Whether the welcome stock has been handed out. Older payloads omit it,
  // which reads as "not yet" and grants it once on the next start.
  gifted: z.boolean().default(false),
  baseline: z.array(z.tuple([z.string(), z.number()])).default([]),
});

export const Config = z.object({
  schemaVersion: z.number().default(1).volatile(),
  tankPresetId: z.string().default('tank.clear-40').volatile(),
  lampPresetId: z.string().default('lamp.arch').volatile(),
  // P5 起造景/投喂可以是定制 id，不能再写死枚举；非法值由客户端回退到内置。
  scapePresetId: z.string().default('scape.jungle').volatile(),
  lightMode: z.union(['auto', 'on', 'off']).default('auto').volatile(),
  qualityMode: z.union(['auto', 'standard', 'eco']).default('auto').volatile(),
  feedingPresetId: z.string().default('feeding.standard').volatile(),
  // 定制鱼种是可选项：默认一只都不加，保持 P2 的两种鱼原样。
  customFishIds: z.array(z.string()).default([]).volatile(),
  // Zeroed defaults read as "never recorded": the client only resumes when
  // `epochAt` is a real timestamp, so a missing section still means a fresh install.
  ledger: Ledger.default({
    v: 1, epochAt: 0, observed: 0, pending: 0, foodQueue: 0, earned: 0, exchanges: 0,
    delivered: 0, gifted: false, baseline: [],
  }).volatile(),
});

const ROOT = path.resolve(fileURLToPath(new URL('../', import.meta.url)));

/** 日志前缀跟包名走，避免以后改名时又漏一处。 */
const PLUGIN_NAME = (() => {
  try {
    return JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).name;
  } catch {
    return 'dsh-tiny-aquarium';
  }
})();

/**
 * P5 定制的 skill 清单。正文放在 `skills/<name>/SKILL.md`，打包后一起发；
 * 注册时才把插件根目录的真实绝对路径写进正文——提示词里的 `<ROOT>` 就是它。
 */
const SKILLS = [
  {
    name: 'aquarium-custom-core',
    title: '小鱼缸定制 · 通用契约',
    description: '小鱼缸（Tiny Tank）定制的通用契约：插件路径、米制坐标、清单字段、id 规则、构建、体检、回退与禁止项。任何鱼缸定制任务都先加载这一份。',
    whenToUse: '用户要改缸体、灯具、造景、鱼种或投喂习惯时；准备写 assets-src 或 presets.json 之前。',
    directory: 'docs/guides',
  },
  {
    name: 'aquarium-custom-tank',
    title: '定制缸体（外壳）',
    description: '把鱼缸换成圆角缸、圆柱缸或任意外壳：只改外观，保留可变形水面、水面命中面、敲击面与固定水体范围。',
    whenToUse: '用户想要不同形状/比例/材质的鱼缸外壳时。',
    directory: 'docs/guides',
  },
  {
    name: 'aquarium-custom-lamp',
    title: '定制灯具',
    description: '换一盏灯（夹灯、吊灯、灯条）：灯体由资产提供，自发光、聚光灯、光域与开关联动由引擎按清单参数接线。',
    whenToUse: '用户想换灯的外形、色温或光域时。',
    directory: 'docs/guides',
  },
  {
    name: 'aquarium-custom-scape',
    title: '定制水草与造景',
    description: '新增一套造景预设：一个 GLB 素材按 layout 摆放多次，用 solid/soft 占位体约束鱼群，并给出出气点。',
    whenToUse: '用户想换底砂、石木、水草布局，或新增一套生态造景时。',
    directory: 'docs/guides',
  },
  {
    name: 'aquarium-custom-fish',
    title: '定制鱼群',
    description: '从参考图新增一个鱼种：单网格 + 内嵌贴图 + 朝向与行为参数，入缸后可游动、避让、觅食与受惊。',
    whenToUse: '用户想养一种内置红绿灯/小丑鱼之外的鱼时。',
    directory: 'docs/guides',
  },
  {
    name: 'aquarium-custom-feeding',
    title: '定制投喂习惯',
    description: '调整投喂与受惊手感：发现延迟、争抢半径、散开时长、急逃与平复时间，九个参数有硬区间，不改判定规则。',
    whenToUse: '用户觉得鱼吃得太慢/太凶、散得太快、受惊后恢复太久时。',
    directory: 'docs/guides',
  },
];

/** 正文里的 `{{ROOT}}` 与 `<ROOT>` 换成真实路径；缺文件时跳过而不是让整个插件起不来。 */
function loadSkillContent(name) {
  const file = path.join(ROOT, 'skills', name, 'SKILL.md');
  if (!existsSync(file)) return null;
  try {
    return readFileSync(file, 'utf8').replaceAll('{{ROOT}}', ROOT).replaceAll('<ROOT>', ROOT);
  } catch {
    return null;
  }
}

function registerSkills(ctx) {
  let registered = 0;
  for (const skill of SKILLS) {
    const body = loadSkillContent(skill.name);
    if (!body) {
      ctx.logger?.warn?.(`[${PLUGIN_NAME}] skill body missing: ${skill.name}`);
      continue;
    }
    const content = body;
    ctx.effect(() => ctx.skills.register({
      name: skill.name,
      description: skill.description,
      whenToUse: skill.whenToUse,
      content,
      resourceBase: { kind: 'directory', path: path.join(ROOT, skill.directory) },
      invocation: { modelInvocable: true, userInvocable: true },
    }));
    registered++;
  }
  ctx.logger?.info?.(`[${PLUGIN_NAME}] registered ${registered} customization skill(s) from ${ROOT}`);
}

export function apply(ctx) {
  ctx.inject(['settings'], child => {
    child.effect(() => child.settings.configure({ auto: false }, ctx.fiber));
  });
  // Skill 服务由 dsh-base 常驻挂载；没挂载时静默跳过，定制入口在界面上会说明原因。
  ctx.inject(['skills'], child => {
    registerSkills(child);
  });
}

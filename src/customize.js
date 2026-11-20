/**
 * P5 定制工厂的契约层。
 *
 * 这里只有数据与纯函数：五个可定制维度、id 与预算规则、九段式提示词模板、
 * 交接前置校验。宿主与客户端都不在这里做 I/O，所以可以直接被测试覆盖，
 * 也保证「提示词里写的东西」和「体检脚本检查的东西」是同一份常量。
 *
 * 术语：
 * - 维度（dimension）= 用户能点的那一个按钮（缸体/灯具/水草与造景/鱼群/投喂习惯）。
 * - 类别（category）= 清单里的资产分类，与 presets.json 的 `category` 一致。
 */

/** 每类资产的默认条目：配置里的 id 失效时回退到这里，而不是"列表第一条"。 */
export const DEFAULT_PRESET_IDS = Object.freeze({
  tank: 'tank.clear-40',
  lamp: 'lamp.arch',
  scape: 'scape.jungle',
  fish: 'fish.neon-tetra',
  feeding: 'feeding.standard',
});

/** 内置 id：定制资产永远新增，不得复用这些名字。 */
export const BUILTIN_IDS = Object.freeze([
  'tank.clear-40',
  'lamp.arch',
  'scape.moss',
  'scape.jungle',
  'scape.driftwood',
  'fish.neon-tetra',
  'fish.clownfish',
  'feeding.standard',
]);

/**
 * 每个类别的预算是「登记门槛」，不是建议值：体检脚本按同一张表判定，
 * 超预算的新条目不会被写进清单。
 */
export const CUSTOM_LIMITS = Object.freeze({
  tank: { triangles: 40000, bytes: 1_600_000, texture: 1024 },
  lamp: { triangles: 24000, bytes: 800_000, texture: 1024 },
  scape: { triangles: 60000, bytes: 1_600_000, texture: 1024 },
  fish: { triangles: 30000, bytes: 1_200_000, texture: 1024 },
  // 投喂习惯是参数预设，没有几何体；字节上限只用于挡住误写的巨型文件。
  feeding: { triangles: 0, bytes: 64_000, texture: 0 },
});

/** 缸体的模拟空间是固定契约：定制只改外观，不改水与鱼的坐标。 */
export const TANK_BOX = Object.freeze({
  width: 40, height: 30, depth: 25,
  waterY: 26.7, minX: -19.3, maxX: 19.3, minZ: -11.8, maxZ: 11.8,
});

const SLUG = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/** `tank.relic-round` → { category: 'tank', slug: 'relic-round' }，非法返回 null。 */
export function parseCustomId(id) {
  if (typeof id !== 'string') return null;
  const dot = id.indexOf('.');
  if (dot <= 0) return null;
  const category = id.slice(0, dot);
  const slug = id.slice(dot + 1);
  if (!Object.hasOwn(CUSTOM_LIMITS, category)) return null;
  if (slug.length < 2 || slug.length > 28 || !SLUG.test(slug)) return null;
  return { category, slug };
}

export function isValidCustomId(id, category) {
  const parsed = parseCustomId(id);
  if (!parsed) return false;
  if (category !== undefined && parsed.category !== category) return false;
  return !BUILTIN_IDS.includes(id);
}

/* --------------------------------------------------------------- 维度定义 */

/**
 * 每个维度的提示词都要能独立开工，所以这里把「改什么、不能改什么、要什么输入、
 * 落到哪个目录、跑哪条验收」一次性写死。新增维度只加一条记录。
 */
export const DIMENSIONS = Object.freeze([
  {
    id: 'tank',
    category: 'tank',
    title: '缸体',
    labelKey: 'customTank',
    hintKey: 'customTankHint',
    skills: ['aquarium-custom-core', 'aquarium-custom-tank'],
    goal: '换一个外观不同的缸体（形状、比例、边框、底座、玻璃质感），容积与水体范围保持不变。',
    promptGoal: '帮我给鱼缸换一个新缸体。',
    // 提示词里只留「用户真的需要自己说的那几项」。契约（尺寸、路径、体检、回报
    // 格式）都在 skill 正文里，由 `/skill` token 注入，不再重复写进输入框。
    fields: ['外形（方缸 / 圆角 / 异形）：', '材质与配色：', '参考图（拖进本会话）：'],
  },
  {
    id: 'lamp',
    category: 'lamp',
    title: '灯具',
    labelKey: 'customLamp',
    hintKey: 'customLampHint',
    skills: ['aquarium-custom-core', 'aquarium-custom-lamp'],
    goal: '换一盏外观不同的灯（夹灯、吊灯、灯条、壁灯均可），保留挂点、光域朝向与开关联动。',
    promptGoal: '帮我给鱼缸换一盏新灯。',
    fields: ['灯型（夹灯 / 吊灯 / 灯条）：', '材质与配色：', '色温（暖 / 中性 / 冷）：', '参考图（拖进本会话）：'],
  },
  {
    id: 'scape',
    category: 'scape',
    title: '水草与造景',
    labelKey: 'customScape',
    hintKey: 'customScapeHint',
    skills: ['aquarium-custom-core', 'aquarium-custom-scape'],
    goal: '新增一套完整造景预设（底砂、石、木、水草、出气点），并给出可游动空间的占位体。',
    promptGoal: '帮我给鱼缸加一套新造景。',
    fields: ['风格（石景 / 沉木 / 草缸）：', '前景 / 中景 / 后景各放什么：', '参考图（拖进本会话）：'],
  },
  {
    id: 'fish',
    category: 'fish',
    title: '鱼群',
    labelKey: 'customFish',
    hintKey: 'customFishHint',
    skills: ['aquarium-custom-core', 'aquarium-custom-fish'],
    goal: '新增一个鱼种（单网格 + 内嵌贴图），入缸后能游动、避让、觅食与受惊。',
    promptGoal: '帮我往缸里加一个新鱼种。',
    fields: ['鱼名：', '参考图（拖进本会话）：', '成体体长（cm）：', '数量：'],
  },
  {
    id: 'feeding',
    category: 'feeding',
    title: '投喂习惯',
    labelKey: 'customFeeding',
    hintKey: 'customFeedingHint',
    skills: ['aquarium-custom-core', 'aquarium-custom-feeding'],
    goal: '调整投喂与受惊的手感（发现延迟、争抢半径、散开时长、受惊与平复时间），不改判定规则。',
    promptGoal: '帮我调一套新的投喂手感。',
    fields: ['想要的手感（例如：发现慢一点、抢得更凶）：', '不能接受的变化（例如：不要有鱼抢不到食）：'],
  },
]);

export const getDimension = id => DIMENSIONS.find(dimension => dimension.id === id);

/* ------------------------------------------------------------- 投喂习惯参数 */

/**
 * 投喂与受惊的所有可调项。区间是硬边界：越界一律回退默认值并记账，
 * 不允许模型「调大一点试试」。键名与 feeding.js / startle.js 的常量同名。
 */
export const FEEDING_PARAMS = Object.freeze({
  noticeMin: { min: 0.1, max: 1.6, fallback: 0.25, label: '最早发现延迟（秒）' },
  noticeMax: { min: 0.3, max: 2.5, fallback: 1.0, label: '最晚发现延迟（秒）' },
  competeRadius: { min: 0.02, max: 0.1, fallback: 0.055, label: '争抢半径（米）' },
  scatterMin: { min: 1.2, max: 7, fallback: 3.2, label: '最短散开时长（秒）' },
  scatterMax: { min: 1.6, max: 9, fallback: 4.6, label: '最长散开时长（秒）' },
  fleeMin: { min: 0.2, max: 2, fallback: 0.55, label: '最短急逃时长（秒）' },
  fleeMax: { min: 0.3, max: 2.5, fallback: 0.9, label: '最长急逃时长（秒）' },
  settleMin: { min: 0.4, max: 3.5, fallback: 1.25, label: '最短平复时长（秒）' },
  settleMax: { min: 0.6, max: 4, fallback: 1.85, label: '最长平复时长（秒）' },
});

const PAIRS = [['noticeMin', 'noticeMax'], ['scatterMin', 'scatterMax'], ['fleeMin', 'fleeMax'], ['settleMin', 'settleMax']];

/** 缺省值 = 当前内置手感，便于「只改一项」时其余保持原样。 */
export function defaultFeedingParams() {
  return Object.fromEntries(Object.entries(FEEDING_PARAMS).map(([key, spec]) => [key, spec.fallback]));
}

/**
 * 把任意输入收成一份合法参数。返回 repaired 让调用方能把「哪些被回退」说清楚，
 * 而不是静默改数。
 */
export function normalizeFeedingParams(input = {}) {
  const value = input && typeof input === 'object' ? input : {};
  const params = {};
  const repaired = [];
  for (const [key, spec] of Object.entries(FEEDING_PARAMS)) {
    const raw = Number(value[key]);
    if (value[key] === undefined) { params[key] = spec.fallback; continue; }
    if (!Number.isFinite(raw) || raw < spec.min || raw > spec.max) { params[key] = spec.fallback; repaired.push(key); continue; }
    params[key] = raw;
  }
  for (const [minKey, maxKey] of PAIRS) {
    if (params[maxKey] < params[minKey]) {
      const swapped = params[minKey];
      params[minKey] = params[maxKey];
      params[maxKey] = swapped;
      repaired.push(maxKey);
    }
  }
  return { params, repaired };
}

/* ------------------------------------------------------------ 交接前置校验 */

/** 批次 id：时间戳 + 维度，写进提示词首行，用来忽略重复追加。 */
export function buildBatchId(dimensionId, now = Date.now()) {
  const stamp = Number.isFinite(now) ? Math.max(0, Math.floor(now)) : 0;
  return `${stamp.toString(36)}-${dimensionId}`;
}

/* --------------------------------------------------------------- 提示词模板 */

/**
 * 提示词只保留「用户真的需要自己说的那几样」：
 *
 * 1. 首行是 `/skill` token。宿主会把被指名、且 userInvocable 的 skill 正文
 *    直接注入本步（见 @deepseek-ai/dsh-tool-skill 的「用户显式调用」），
 *    所以路径白名单、单位、体检判据、回报格式这些契约都留在 skill 正文里，
 *    不再抄一遍到输入框。
 * 2. 一句「帮我做什么」，让用户一眼看懂这条草稿要干什么。
 * 3. 3～4 个空行：只有用户自己知道的那几项（参考图只能由他自己拖进来）。
 * 4. 末尾一行批次号，让模型忽略重复追加的同一段。
 *
 * @param {string} dimensionId
 * @param {object} context 只用 `now`（批次号），其余字段忽略
 */
export function buildPrompt(dimensionId, context = {}) {
  const dimension = getDimension(dimensionId);
  if (!dimension) throw new Error(`unknown customization dimension: ${dimensionId}`);
  const batchId = buildBatchId(dimensionId, context.now);
  const tokens = dimension.skills.map(name => `/${name}`).join(' ');
  const text = [
    `${tokens} ${dimension.promptGoal}`,
    '',
    ...dimension.fields,
    '',
    `（批次 ${batchId}：这段内容重复出现时只做一次）`,
  ].join('\n');
  return { batchId, dimension: dimension.id, text };
}

/* ------------------------------------------------------------ 交接前置校验 */

/**
 * 按钮能不能开新会话。返回原因码数组；空数组表示可以交接。
 * 只看客户端拿得到的事实，不猜宿主权限：真正的写盘授权发生在会话里。
 */
export function handoffBlockers(environment = {}) {
  const blockers = [];
  const api = environment.uiWorkspace;
  if (!api || typeof api.startSession !== 'function') {
    blockers.push('noHandoffApi');
  }
  const snapshot = environment.workspaces?.list?.getSnapshot?.();
  if (!snapshot) blockers.push('noWorkspaceList');
  else if (snapshot.phase === 'ready' && !(snapshot.items?.length > 0)) blockers.push('noWorkspace');
  if (environment.skillsReady === false) blockers.push('noSkills');
  return blockers;
}

/** 交接失败的原因码 → 文案键。 */
export const BLOCKER_KEYS = Object.freeze({
  noHandoffApi: 'customNoHandoff',
  noWorkspaceList: 'customNoWorkspaceList',
  noWorkspace: 'customNoWorkspace',
  noSkills: 'customNoSkills',
});

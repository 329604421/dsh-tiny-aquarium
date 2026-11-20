import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_PRESET_IDS, DIMENSIONS, FEEDING_PARAMS, TANK_BOX, buildBatchId, buildPrompt,
  defaultFeedingParams, handoffBlockers, isValidCustomId, normalizeFeedingParams, parseCustomId,
} from '../src/customize.js';
import { createCatalog, customSpeciesOf, lampParamsOf, scapeLayoutOf } from '../src/custom-catalog.js';

const manifest = JSON.parse(await readFile(fileURLToPath(new URL('../presets.json', import.meta.url)), 'utf8'));

/* ------------------------------------------------------------- id 与批次 */

test('P5 custom ids follow <category>.<slug> and reject everything else', () => {
  assert.deepEqual(parseCustomId('fish.rainbow'), { category: 'fish', slug: 'rainbow' });
  for (const bad of ['fish', 'fish.', '.rainbow', 'fish.Rainbow', 'fish.rain bow', 'unknown.rainbow', 'fish.a', 42, null]) {
    assert.equal(parseCustomId(bad), null, `should reject ${JSON.stringify(bad)}`);
  }
  assert.ok(isValidCustomId('scape.driftwood-cave', 'scape'));
  assert.equal(isValidCustomId('scape.driftwood-cave', 'fish'), false);
});

test('P5 batch ids are stable for a timestamp and stay distinct per dimension', () => {
  assert.equal(buildBatchId('tank', 1_700_000_000_000), buildBatchId('tank', 1_700_000_000_000));
  assert.notEqual(buildBatchId('tank', 1), buildBatchId('fish', 1));
  assert.ok(buildBatchId('tank', 1).endsWith('-tank'));
});

/* ---------------------------------------------------------------- 提示词 */

test('P5 prompt is a short /skill draft, not a copy of the skill', () => {
  for (const dimension of DIMENSIONS) {
    const { batchId, text, dimension: id } = buildPrompt(dimension.id, { now: 1_700_000_000_000 });
    assert.equal(id, dimension.id);
    const lines = text.split('\n');

    // 首行 = 一行 /skill token + 一句「帮我做什么」。宿主按空白切分这些 token，
    // 把对应 skill 的正文整段注入本步，所以这一行就是全部的「怎么干活」。
    for (const skill of dimension.skills) assert.ok(lines[0].startsWith(`/${skill}`) || lines[0].includes(` /${skill}`), `${dimension.id} 首行缺 /${skill}`);
    assert.ok(lines[0].includes(dimension.promptGoal));

    // 每个用户要填的项都是一行「标签：」，空着等他填。
    for (const field of dimension.fields) assert.ok(lines.includes(field), `${dimension.id} 缺空行 ${field}`);

    // 批次号仍在，用来忽略重复追加的同一段。
    assert.ok(text.includes(batchId));

    // 契约不再抄进输入框：路径、体检命令、回报格式都属于 skill 正文。
    for (const leaked of ['assets-src/', 'presets.json', 'custom-asset.mjs', 'npm run build', '【回报】']) {
      assert.ok(!text.includes(leaked), `${dimension.id} 的提示词又变长了：含 ${leaked}`);
    }
    // 硬上限：一旦有人往草稿里堆说明，这条会先红。
    assert.ok(text.length < 400, `${dimension.id} 提示词 ${text.length} 字符，太长了`);
  }
});

test('P5 prompt names only its own dimension skills', () => {
  const { text } = buildPrompt('fish');
  assert.ok(text.includes('/aquarium-custom-fish'));
  assert.ok(text.includes('/aquarium-custom-core'));
  assert.ok(!text.includes('aquarium-custom-lamp'));
  assert.ok(!text.includes('aquarium-custom-scape'));
});

test('P5 prompt is stable for a fixed timestamp so duplicates are recognisable', () => {
  const first = buildPrompt('tank', { now: 1_700_000_000_000 });
  const second = buildPrompt('tank', { now: 1_700_000_000_000 });
  assert.equal(first.text, second.text);
  assert.notEqual(first.text, buildPrompt('tank', { now: 1_700_000_001_000 }).text);
});

/* ------------------------------------------------------------ 交接前置校验 */

test('P5 handoff reports every missing capability instead of failing silently', () => {
  const startSession = () => {};
  const readyList = { phase: 'ready', items: [{ workspaceId: 'w' }] };
  assert.deepEqual(handoffBlockers({ uiWorkspace: { startSession }, workspaces: { list: { getSnapshot: () => readyList } } }), []);

  const codes = environment => handoffBlockers(environment).sort();
  assert.deepEqual(codes({}), ['noHandoffApi', 'noWorkspaceList']);
  assert.deepEqual(codes({ uiWorkspace: {}, workspaces: { list: { getSnapshot: () => readyList } } }), ['noHandoffApi']);
  assert.deepEqual(codes({ uiWorkspace: { startSession }, workspaces: { list: { getSnapshot: () => ({ phase: 'ready', items: [] }) } } }), ['noWorkspace']);
  assert.deepEqual(codes({ uiWorkspace: { startSession }, workspaces: { list: { getSnapshot: () => ({ phase: 'loading', items: [] }) } } }), []);
  assert.deepEqual(codes({ uiWorkspace: { startSession }, workspaces: { list: { getSnapshot: () => readyList } }, skillsReady: false }), ['noSkills']);
});

/* ---------------------------------------------------------------- 投喂参数 */

test('P5 feeding defaults all sit inside their own ranges', () => {
  const params = defaultFeedingParams();
  assert.deepEqual(Object.keys(params).sort(), Object.keys(FEEDING_PARAMS).sort());
  for (const [key, value] of Object.entries(params)) {
    const spec = FEEDING_PARAMS[key];
    assert.ok(value >= spec.min && value <= spec.max, `${key}=${value} outside [${spec.min}, ${spec.max}]`);
  }
});

test('P5 feeding normalisation repairs out-of-range values and swapped pairs', () => {
  const repaired = normalizeFeedingParams({ noticeMin: 99, scatterMax: -5, competeRadius: 0.06 });
  assert.deepEqual(repaired.repaired.sort(), ['noticeMin', 'scatterMax']);
  assert.equal(repaired.params.noticeMin, FEEDING_PARAMS.noticeMin.fallback);
  assert.equal(repaired.params.scatterMax, FEEDING_PARAMS.scatterMax.fallback);
  assert.equal(repaired.params.competeRadius, 0.06);

  // min > max 时对调，而不是把两个都打回缺省。
  const swapped = normalizeFeedingParams({ ...defaultFeedingParams(), noticeMin: 1.4, noticeMax: 0.4 });
  assert.ok(swapped.params.noticeMin <= swapped.params.noticeMax, 'pair must be ordered');
  assert.deepEqual(swapped.repaired, ['noticeMax']);

  // 缺项按缺省补，不算「修复」。
  const blank = normalizeFeedingParams({});
  assert.deepEqual(blank.repaired, []);
  assert.deepEqual(blank.params, defaultFeedingParams());
});

/* ------------------------------------------------------------------ 清单 */

test('P5 catalog resolves unknown ids to the per-category default, never to an empty void', () => {
  const catalog = createCatalog(manifest.presets);
  for (const category of ['tank', 'lamp', 'scape', 'fish']) {
    const resolved = catalog.resolvePresetId(`${category}.definitely-missing`, category);
    assert.ok(resolved.id, `${category} must resolve to something`);
    assert.equal(resolved.id, DEFAULT_PRESET_IDS[category], `${category} must fall back to its default`);
    assert.equal(resolved.repaired, true);
  }
});

test('P5 custom fish species shares the built-in metre space, not the centimetre tank box', () => {
  const species = customSpeciesOf({
    id: 'fish.probe', displayName: '探针鱼', params: { targetLength: 0.06, count: 3, cruise: 0.7 },
  });
  assert.equal(species.count, 3);
  assert.equal(species.targetLength, 0.06);
  // 这条守的是「TANK_BOX 是厘米制且没有 floorY」那次 NaN 事故：把厘米制外框当
  // 模拟空间会让 floorY 变成 undefined，夹取后 y 直接是 NaN。
  assert.equal(typeof species.space.floorY, 'number', 'space must carry floorY');
  assert.ok(Number.isFinite(species.space.floorY));
  assert.ok(species.space.waterY < 1, 'space must be in metres');
  assert.ok(species.space.maxX < 1 && species.space.minX > -1, 'space must be in metres');
  assert.ok(species.space.waterY > species.space.floorY);

  // 求解器那句 clamp 的结果必须仍是有限数，这是当初实际炸掉的那一行。
  const y = Math.max(species.space.floorY + 0.022, Math.min(species.space.waterY - 0.018, 0.05));
  assert.ok(Number.isFinite(y));
});

test('P5 custom species rounds the fish count into 1..6 and keeps unknown params inert', () => {
  assert.equal(customSpeciesOf({ id: 'fish.a', params: { count: 99 } }).count, 6);
  assert.equal(customSpeciesOf({ id: 'fish.a', params: { count: 0 } }).count, 1);
  assert.equal(customSpeciesOf({ id: 'fish.a', params: {} }).targetLength, 0.05);
  assert.equal(customSpeciesOf({ id: 'fish.a' }).id, 'fish.a');
});

test('P5 scape layout converts the centimetre manifest into metres', () => {
  const layout = scapeLayoutOf({
    id: 'scape.probe',
    params: { layout: [{ x: 10, y: 0, z: -5, scale: 2, rotY: 90 }], airStone: [-16, 2.1, -8], sway: 0.5 },
    collision: [{ type: 'cylinder', kind: 'soft', center: [10, 5, 0], radius: 4, height: 10 }],
  });
  assert.equal(layout.instances.length, 1);
  assert.deepEqual(layout.instances[0].position, [0.1, 0, -0.05]);
  assert.equal(layout.instances[0].scale, 2);
  assert.ok(Math.abs(layout.instances[0].rotY - Math.PI / 2) < 1e-9);
  assert.deepEqual(layout.airStone, [-0.16, 0.021, -0.08]);
  assert.equal(layout.collision[0].radius, 0.04);
  assert.equal(layout.collision[0].height, 0.1);
  assert.equal(layout.sway, 0.5);
});

test('P5 lamp parameters clamp into the shutter range and keep the built-in defaults', () => {
  const lamp = lampParamsOf({ id: 'lamp.x', params: { colorTemp: 12000, intensity: 0.01, angle: 9 } });
  assert.equal(lamp.color, 6500);
  assert.equal(lamp.intensity, 0.3);
  assert.ok(lamp.angle <= 1.15);
  assert.deepEqual(lamp.target, [0, 0.05, 0]);
  const bare = lampParamsOf({ id: 'lamp.y' });
  assert.equal(bare.color, 4200);
});

test('P5 tank box stays the fixed centimetre contract', () => {
  assert.deepEqual(TANK_BOX, {
    width: 40, height: 30, depth: 25, waterY: 26.7, minX: -19.3, maxX: 19.3, minZ: -11.8, maxZ: 11.8,
  });
});

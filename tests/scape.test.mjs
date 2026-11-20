import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { normalizeConfig } from '../src/core.js';
import { Config } from '../src/host.js';
import { createCatalog } from '../src/custom-catalog.js';
import {
  SCAPE_PRESETS, SCAPE_IDS, DEFAULT_SCAPE_ID, getScapePreset, getScapeCollision, scapeSummary, constrainToScape,
} from '../src/scape-data.js';

const manifest = JSON.parse(await readFile(fileURLToPath(new URL('../presets.json', import.meta.url)), 'utf8'));

test('P5 host schema keeps scapePresetId editable for custom ids', () => {
  assert.ok(Config.dict.scapePresetId, 'the host must project this field into configForms');
  for (const id of SCAPE_IDS) assert.doesNotThrow(() => Config.dict.scapePresetId(id));
  // P5：定制造景是任意 id，schema 只保证是字符串；存在性由清单目录判定。
  assert.doesNotThrow(() => Config.dict.scapePresetId('scape.driftwood-tunnel'));
});

test('P3 exposes exactly three distinct, persistent built-in scapes and the catalog repairs unknown ids', () => {
  assert.deepEqual(SCAPE_IDS, ['scape.moss', 'scape.jungle', 'scape.driftwood']);
  assert.equal(DEFAULT_SCAPE_ID, 'scape.jungle');
  assert.equal(normalizeConfig({ scapePresetId: 'scape.moss' }).config.scapePresetId, 'scape.moss');
  // 形状层面原样保留未知 id，回退交给 catalog——否则每次新增定制都要改归一化。
  assert.equal(normalizeConfig({ scapePresetId: 'scape.unknown' }).config.scapePresetId, 'scape.unknown');
  const catalog = createCatalog(manifest.presets);
  const repaired = catalog.resolvePresetId('scape.unknown', 'scape');
  assert.equal(repaired.id, DEFAULT_SCAPE_ID);
  assert.equal(repaired.repaired, true);
  assert.equal(normalizeConfig().config.scapePresetId, DEFAULT_SCAPE_ID);
  assert.ok(new Set(SCAPE_PRESETS.map(p => p.substrateId)).size === 3);
  assert.ok(new Set(SCAPE_PRESETS.map(p => p.plantId)).size === 3);
});

test('P3 layouts stay inside the glass and below the water surface', () => {
  for (const preset of SCAPE_PRESETS) {
    for (const rock of preset.rocks) {
      for (let axis = 0; axis < 3; axis++) {
        const limit = [20, 26.7, 12.5][axis];
        assert.ok(Math.abs(rock.center[axis]) + rock.size[axis] / 2 <= limit, `${preset.id} rock ${axis}`);
      }
    }
    for (const plant of preset.plants) {
      assert.ok(plant.center[1] + plant.height[1] <= 23, `${preset.id} plant height`);
      assert.ok(Math.abs(plant.center[0]) + plant.spread / 2 < 19, `${preset.id} plant x`);
      assert.ok(Math.abs(plant.center[2]) + plant.spread / 2 < 11.8, `${preset.id} plant z`);
      assert.ok(plant.count > 0 && plant.count <= 50, 'density cap');
    }
    for (const wood of preset.woods) {
      assert.equal(wood.points.length, wood.radii.length);
      wood.points.forEach((point, index) => {
        assert.ok(Math.abs(point[0]) + wood.radii[index] < 19.5, `${preset.id} wood x`);
        assert.ok(point[1] + wood.radii[index] < 25, `${preset.id} wood height`);
        assert.ok(Math.abs(point[2]) + wood.radii[index] < 12, `${preset.id} wood z`);
      });
    }
    const [x, y, z] = preset.airStone;
    assert.ok(Math.abs(x) < 19 && Math.abs(z) < 11.8 && y > 1.5 && y < 3);
  }
});

test('P3 collision data distinguishes solid and soft volumes and is directly consumable in metres', () => {
  for (const preset of SCAPE_PRESETS) {
    const collision = getScapeCollision(preset.id);
    assert.equal(collision.length, preset.rocks.length + preset.woods.length + preset.plants.length);
    assert.ok(collision.every(volume => volume.id.startsWith(preset.id)));
    assert.ok(collision.every(volume => volume.center.every(Number.isFinite)));
    assert.ok(collision.filter(volume => volume.kind === 'solid').every(volume => volume.type === 'box' && volume.size.every(value => value > 0)));
    assert.ok(collision.filter(volume => volume.kind === 'soft').every(volume => volume.type === 'cylinder' && volume.radius > 0 && volume.height > 0));
    assert.deepEqual(getScapeCollision(preset.id), collision, 'stable data, no per-frame regeneration');
  }
  assert.ok(getScapeCollision('scape.moss').every(volume => !volume.id.includes('.wood.')));
  assert.equal(getScapeCollision('scape.driftwood').filter(volume => volume.id.includes('.wood.')).length, 8);
  assert.ok(getScapeCollision('scape.jungle').filter(volume => volume.kind === 'soft').length > 6);
});

test('P3 manifest contains complete plant and substrate contracts synchronized with layouts', () => {
  for (const preset of SCAPE_PRESETS) {
    for (const [id, kind] of [[preset.substrateId, 'solid'], [preset.plantId, 'soft']]) {
      const entry = manifest.presets.find(item => item.id === id);
      assert.ok(entry, id);
      for (const field of ['category', 'version', 'file', 'displayName', 'bounds', 'anchor', 'forward', 'params', 'collision', 'origin', 'license', 'author', 'source']) {
        assert.ok(entry[field] !== undefined, `${id}.${field}`);
      }
      assert.equal(entry.origin, 'builtin');
      const runtime = getScapeCollision(preset.id).filter(volume => volume.kind === kind);
      assert.equal(entry.collision.length, runtime.length);
      entry.collision.forEach((volume, index) => {
        assert.equal(volume.type, runtime[index].type);
        volume.center.forEach((value, axis) => assert.ok(Math.abs(value - runtime[index].center[axis] * 100) < 0.011));
      });
    }
    const summary = scapeSummary(preset.id);
    assert.ok(summary.leaves > 40);
    assert.ok(summary.airStone.every(value => Math.abs(value) < 0.2));
  }
});

test('P3 centre guard pushes fish out of solids and dense stems without blocking open water', () => {
  const box = { type: 'box', kind: 'solid', center: [0, 0.1, 0], size: [0.04, 0.04, 0.04] };
  const pushed = constrainToScape({ x: 0, y: 0.1, z: 0 }, [box], 0.005);
  assert.ok(Math.abs(pushed.x) >= 0.025 || Math.abs(pushed.y - 0.1) >= 0.025 || Math.abs(pushed.z) >= 0.025);
  assert.deepEqual(constrainToScape({ x: 0.1, y: 0.2, z: 0.1 }, [box]), { x: 0.1, y: 0.2, z: 0.1 });
  const stem = { type: 'cylinder', kind: 'soft', center: [0, 0.1, 0], radius: 0.03, height: 0.1 };
  const aroundStem = constrainToScape({ x: 0.001, y: 0.1, z: 0 }, [stem], 0.005);
  assert.ok(Math.hypot(aroundStem.x, aroundStem.z) >= 0.0145);
});

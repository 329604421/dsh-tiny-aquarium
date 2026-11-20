import test from 'node:test';
import assert from 'node:assert/strict';
import { Gesture, Simulation, FixedClock, LIMITS, SPACE, ZOOM, clampZoom, effectiveLight, normalizeConfig } from '../src/core.js';

test('zoom clamps to the fitted overview and the closest allowed size', () => {
  assert.equal(ZOOM.min, 1);
  assert.equal(clampZoom(0.4), 1);
  assert.equal(clampZoom(1), 1);
  assert.equal(clampZoom(1.8), 1.8);
  assert.equal(clampZoom(9), ZOOM.max);
  assert.equal(clampZoom(Number.NaN), 1);
  assert.equal(clampZoom(Number.POSITIVE_INFINITY), 1);
});

test('P5 配置只校验形状，未知 id 交给清单目录回退', () => {
  const { config, repaired } = normalizeConfig({
    qualityMode: 'eco', fishSpeciesId: null, tankPresetId: 'tank.relic-round', scapePresetId: 42,
  });
  assert.equal(config.qualityMode, 'eco');
  // 定制 id 原样保留：是否存在由 catalog 判定，否则每次新增资产都要改这里。
  assert.equal(config.tankPresetId, 'tank.relic-round');
  assert.equal(config.scapePresetId, 'scape.jungle');
  assert.deepEqual(repaired, ['scapePresetId']);
  assert.equal('fishSpeciesId' in config, false);
  assert.equal(config.feedingPresetId, 'feeding.standard');
  assert.deepEqual(config.customFishIds, []);
});

test('自定义鱼种列表挡住非字符串项，保留合法 id', () => {
  const { config, repaired } = normalizeConfig({ customFishIds: ['fish.koi-red', 7, '', 'fish.b'] });
  assert.deepEqual(config.customFishIds, ['fish.koi-red', 'fish.b']);
  assert.deepEqual(repaired, []);
  const broken = normalizeConfig({ customFishIds: 'fish.koi-red' });
  assert.deepEqual(broken.config.customFishIds, []);
  assert.deepEqual(broken.repaired, ['customFishIds']);
});
test('drag never becomes tap, feed, or blank close; vertical motion also suppresses clicks', () => {
  for (const feeding of [false, true]) {
    for (const target of ['glass', 'water', 'blank']) {
      const g = new Gesture();
      g.begin(1, 0, 0, 'glass');
      g.move(1, 7, 0);
      assert.equal(g.end(1, 7, 0, target, feeding), 'none');
    }
  }
  const g = new Gesture();
  g.begin(1, 0, 0, 'water');
  g.move(1, 0, 7);
  assert.equal(g.end(1, 0, 7, 'water', true), 'none');
});
test('threshold includes pointerup movement and accumulated travel', () => {
  const g = new Gesture();
  g.begin(1, 0, 0, 'glass');
  assert.equal(g.end(1, 10, 0, 'glass', false), 'none');
  g.begin(1, 0, 0, 'glass');
  g.move(1, 4, 0);
  g.move(1, 0, 0);
  assert.equal(g.end(1, 0, 0, 'glass', false), 'none');
});
test('one primary action, no side-wall feeding or feeding-mode tapping', () => {
  const g = new Gesture();
  for (const [start, end, feeding, result] of [
    ['glass', 'glass', false, 'tap'], ['water', 'water', true, 'feed'],
    ['glass', 'water', true, 'none'], ['glass', 'glass', true, 'none'],
    ['blank', 'glass', false, 'none'], ['glass', 'blank', false, 'none'],
    ['blank', 'blank', true, 'close'], ['lamp', 'lamp', false, 'none'],
  ]) {
    g.begin(1, 10, 10, start);
    assert.equal(g.end(1, 10, 10, end, feeding), result);
  }
});
test('foreign pointer and cancellation cannot complete another pointer gesture', () => {
  const g = new Gesture();
  g.begin(1, 0, 0, 'glass');
  assert.equal(g.end(2, 0, 0, 'glass', false), 'none');
  assert.ok(g.current);
  g.cancel();
  assert.equal(g.end(1, 0, 0, 'glass', false), 'none');
});
test('food respects interval, actual water bounds, count cap and unique IDs', () => {
  const sim = new Simulation(() => 0.5);
  assert.equal(sim.feed({ x: 1, z: 0 }, 0), 'outside');
  assert.equal(sim.feed({ x: 0, z: 0 }, 0), 'added');
  assert.equal(sim.feed({ x: 0, z: 0 }, 149), 'throttled');
  for (let i = 1; i < 25; i++) assert.equal(sim.feed({ x: 0, z: 0 }, i * 150), 'added');
  assert.equal(sim.food.length, 100);
  assert.equal(new Set(sim.food.map(p => p.id)).size, 100);
  assert.equal(sim.feed({ x: 0, z: 0 }, 4000), 'full');
});
test('automatic batches land whole or not at all', () => {
  const sim = new Simulation(() => 0.5);
  assert.equal(sim.dropFood({ x: 1, z: 0 }, 5), 'outside');
  assert.equal(sim.dropFood({ x: 0, z: 0 }, 0), 'outside');
  assert.equal(sim.dropFood({ x: 0, z: 0 }, 5), 'added');
  assert.equal(sim.food.length, 5);
  assert.equal(sim.dropFood({ x: 0, z: 0 }, 96), 'full', 'a batch that does not fit is refused whole');
  assert.equal(sim.food.length, 5);
  assert.equal(sim.dropFood({ x: 0, z: 0 }, 95), 'added');
  assert.equal(sim.food.length, 100);
  assert.equal(sim.dropFood({ x: 0, z: 0 }, 5), 'full');
  const jar = new Simulation(() => 0.5);
  assert.equal(jar.feed({ x: 0, z: 0 }, 0), 'added', 'the manual jar still uses its own batch');
  assert.equal(jar.food.length, LIMITS.batch);
  assert.equal(LIMITS.autoFeedBatch, 5);
});
test('food visibly sinks, stays inside water, fades and expires', () => {
  const sim = new Simulation(() => 0.5);
  sim.feed({ x: SPACE.maxX, z: SPACE.maxZ }, 0);
  const initial = sim.food[0].y;
  for (let i = 0; i < 60 * 6; i++) sim.update(LIMITS.step);
  assert.ok(sim.food[0].y < initial - 0.1);
  assert.ok(sim.food.every(p => p.x <= SPACE.maxX && p.z <= SPACE.maxZ && p.y >= SPACE.floorY));
  for (let i = 0; i < 60 * 17; i++) sim.update(LIMITS.step);
  assert.ok(sim.food[0].alpha > 0 && sim.food[0].alpha < 1);
  for (let i = 0; i < 60 * 3; i++) sim.update(LIMITS.step);
  assert.equal(sim.food.length, 0);
});
test('P2 consumption is atomic and stale IDs never consume new food', () => {
  const sim = new Simulation();
  sim.feed({ x: 0, z: 0 }, 0);
  const id = sim.food[0].id;
  assert.equal(sim.consume(id), true);
  assert.equal(sim.consume(id), false);
  assert.equal(sim.food.length, 3);
  for (let i = 0; i < 1600; i++) sim.update(LIMITS.step);
  assert.equal(sim.consume(id + 1), false);
  sim.feed({ x: 0, z: 0 }, 10000);
  assert.ok(sim.food.every(p => p.id > id + 3));
});
test('tap events are local, throttled, bounded and unsubscribable', () => {
  const sim = new Simulation();
  let count = 0;
  const off = sim.onTap(event => { count++; assert.equal(event.intensity, 1); });
  assert.equal(sim.tap({ x: 0.1, y: 0.1, z: 0.12 }, { x: 0, y: 0, z: 1 }, 0), true);
  assert.equal(sim.tap({}, {}, 299), false);
  off();
  assert.equal(sim.tap({}, {}, 300), true);
  assert.equal(count, 1);
  for (let i = 0; i < 60; i++) sim.update(LIMITS.step);
  assert.equal(sim.taps.length, 0);
});
test('rotation remains continuous, water impulse is bounded and decays', () => {
  const sim = new Simulation();
  const start = sim.yaw;
  sim.rotate(Math.PI * 5);
  assert.equal(sim.yaw, start + Math.PI * 5);
  for (let i = 0; i < 15; i++) sim.update(LIMITS.step);
  const peak = Math.abs(sim.wave);
  const crossPeak = Math.abs(sim.waveCross);
  assert.ok(peak > 0.001);
  assert.ok(peak <= 0.011);
  assert.ok(crossPeak > 0.001);
  assert.ok(crossPeak <= 0.007);
  for (let i = 0; i < 240; i++) sim.update(LIMITS.step);
  assert.ok(Math.abs(sim.wave) < peak * 0.03);
  assert.ok(Math.abs(sim.waveCross) < crossPeak * 0.03);
});
test('fixed clock caps catch-up at three steps and discards hidden wall time', () => {
  const clock = new FixedClock();
  let total = 0;
  clock.tick(0, dt => total += dt);
  assert.equal(clock.tick(10000, dt => total += dt), 3);
  assert.ok(total <= 0.050001);
  clock.reset();
  assert.equal(clock.tick(20000, () => assert.fail()), 0);
});
test('manual light override wins; clearing it follows theme again', () => {
  assert.equal(effectiveLight('auto', true, null), true);
  assert.equal(effectiveLight('auto', false, null), false);
  assert.equal(effectiveLight('auto', true, false), false);
  assert.equal(effectiveLight('on', false, null), true);
  assert.equal(effectiveLight('off', true, null), false);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { Simulation, LIMITS, SPACE } from '../src/core.js';
import { FeedingBehavior, FeedingDirector, FEEDING } from '../src/feeding.js';
import { FEED_CURSOR, FEED_CURSOR_WATER } from '../src/feed-cursor.js';

function feedingSetup(position = { x: 0, y: SPACE.waterY, z: 0 }) {
  const sim = new Simulation(() => 0.5);
  sim.feed({ x: 0, z: 0 }, 0);
  const director = new FeedingDirector(sim);
  return { sim, director, position };
}

function advance(behavior, seconds, args) {
  const steps = Math.ceil(seconds / LIMITS.step);
  for (let i = 0; i < steps; i++) behavior.update(LIMITS.step, args);
}

test('near fish notices before distant fish and every response starts within one second', () => {
  const { director, position } = feedingSetup();
  const near = new FeedingBehavior(0, 11);
  const far = new FeedingBehavior(1, 12);
  const farPosition = { x: 0.18, y: 0.08, z: 0.11 };
  let nearAt = null;
  let farAt = null;
  for (let frame = 0; frame < 90; frame++) {
    const now = frame * LIMITS.step;
    near.update(LIMITS.step, { key: 'near', position, director });
    far.update(LIMITS.step, { key: 'far', position: farPosition, director });
    if (nearAt === null && (near.state === 'gather' || near.state === 'compete' || near.eaten)) nearAt = now;
    if (farAt === null && (far.state === 'gather' || far.state === 'compete' || far.eaten)) farAt = now;
  }
  assert.ok(nearAt !== null && farAt !== null);
  assert.ok(nearAt < farAt, `near ${nearAt}s should react before far ${farAt}s`);
  assert.ok(nearAt >= 0.2 && farAt <= 1.02);
});

test('a shared director spreads targets instead of collapsing the school onto one pellet', () => {
  const { director, position } = feedingSetup();
  const selected = new Set();
  const fish = Array.from({ length: 5 }, (_, index) => new FeedingBehavior(index, 30 + index));
  for (let frame = 0; frame < 80; frame++) {
    fish.forEach((behavior, index) => {
      behavior.update(LIMITS.step, { key: `fish-${index}`, position, director });
      if (behavior.targetFoodId !== null) selected.add(behavior.targetFoodId);
    });
  }
  assert.ok(selected.size >= 3, `expected several pellets to be targeted, got ${selected.size}`);
  assert.ok(fish.reduce((sum, behavior) => sum + behavior.eaten, 0) > 0);
});

test('competition consumes a pellet once and losers disperse when it was the last one', () => {
  const { sim, director, position } = feedingSetup();
  while (sim.food.length > 1) sim.consume(sim.food[0].id);
  const fish = [new FeedingBehavior(0, 51), new FeedingBehavior(1, 52)];
  for (let frame = 0; frame < 120; frame++) {
    fish.forEach((behavior, index) => behavior.update(LIMITS.step, {
      key: `rival-${index}`, position, director, eatRadius: 0.02,
    }));
  }
  assert.equal(sim.food.length, 0);
  assert.equal(fish.reduce((sum, behavior) => sum + behavior.eaten, 0), 1);
  assert.ok(fish.every(behavior => behavior.state === 'scatter'));
});

test('a stolen target causes a brief hover and then a different target selection', () => {
  const { sim, director, position } = feedingSetup();
  sim.consume(sim.food[0].id);
  sim.consume(sim.food[0].id);
  const behavior = new FeedingBehavior(0, 71);
  const args = { key: 'fish', position, director };
  behavior.enterNotice(0);
  behavior.update(LIMITS.step, args);
  const stolen = behavior.targetFoodId;
  assert.equal(sim.food.length, 2);
  assert.ok(stolen !== null);
  director.consume(stolen);
  behavior.update(LIMITS.step, args);
  assert.equal(behavior.state, 'notice');
  assert.ok(behavior.noticeDelay >= 0.12 && behavior.noticeDelay <= 0.32);
  let replacement = null;
  for (let frame = 0; frame < 30; frame++) {
    behavior.update(LIMITS.step, args);
    if (behavior.targetFoodId !== null) replacement = behavior.targetFoodId;
  }
  assert.ok(replacement !== null);
  assert.notEqual(replacement, stolen);
});

test('dispersal uses three loose groups, lasts 3-5 seconds, then returns to cruise', () => {
  const sim = new Simulation();
  const director = new FeedingDirector(sim);
  const position = { x: 0, y: SPACE.waterY - 0.02, z: 0 };
  const fish = [0, 1, 2].map(index => new FeedingBehavior(index, 90 + index));
  fish.forEach(behavior => behavior.beginScatter(position, SPACE));
  assert.equal(new Set(fish.map(behavior => `${Math.round(behavior.target.x * 100)}:${Math.round(behavior.target.z * 100)}`)).size, 3);
  for (const behavior of fish) {
    assert.ok(behavior.scatterDuration >= FEEDING.scatterMin && behavior.scatterDuration <= FEEDING.scatterMax);
    advance(behavior, 4.8, { key: `scatter-${behavior.index}`, position, director });
    assert.equal(behavior.state, 'cruise');
    assert.equal(behavior.target, null);
  }
});

test('fresh food recalls fish that just started to disperse', () => {
  const { director, position } = feedingSetup();
  const behavior = new FeedingBehavior(0, 120);
  behavior.beginScatter(position, SPACE);
  advance(behavior, 0.6, { key: 'recall', position, director });
  assert.notEqual(behavior.state, 'scatter');
  assert.ok(['notice', 'gather', 'compete'].includes(behavior.state));
});

test('feeding cursors are local tilted jars with a stronger pouring angle over water', () => {
  assert.notEqual(FEED_CURSOR, FEED_CURSOR_WATER);
  const resting = decodeURIComponent(FEED_CURSOR);
  const pouring = decodeURIComponent(FEED_CURSOR_WATER);
  assert.match(resting, /rotate\(-18 16 16\)/);
  assert.match(pouring, /rotate\(-54 16 16\)/);
  assert.match(resting, /^url\("data:image\/svg\+xml,/);
  assert.match(pouring, / 7 7, pointer$/);
});

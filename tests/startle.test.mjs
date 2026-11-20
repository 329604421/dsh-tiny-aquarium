import test from 'node:test';
import assert from 'node:assert/strict';
import { SPACE, Simulation } from '../src/core.js';
import { StartleBehavior, STARTLE } from '../src/startle.js';
import { FeedingBehavior, FeedingDirector } from '../src/feeding.js';

const tapAt = (point = { x: SPACE.minX, y: 0.14, z: 0 }) => ({
  point, normal: { x: -1, y: 0, z: 0 }, time: 0, intensity: 1,
});
const advance = (behavior, seconds, args) => {
  for (let t = 0; t < seconds - 1e-9; t += 1 / 60) behavior.update(1 / 60, args);
};

test('a tap produces alert, directional flee, settle and calm exactly once', () => {
  const behavior = new StartleBehavior(0, 7);
  const position = { x: -0.12, y: 0.14, z: 0.01 };
  const tap = tapAt();
  behavior.update(1 / 60, { position, taps: [tap] });
  assert.equal(behavior.state, 'alert');
  assert.equal(behavior.events, 1);
  assert.equal(behavior.justTriggered, true);
  assert.ok((behavior.target.x - position.x) * (position.x - tap.point.x) > 0, 'escape points away from the glass');
  advance(behavior, 0.2, { position, taps: [tap] });
  assert.equal(behavior.state, 'flee');
  assert.equal(behavior.events, 1, 'the retained visual tap must not retrigger the fish');
  advance(behavior, 1, { position, taps: [] });
  assert.equal(behavior.state, 'settle');
  advance(behavior, 2, { position, taps: [] });
  assert.equal(behavior.state, 'calm');
  assert.equal(behavior.target, null);
});

test('near fish react sooner and all escape targets remain inside the water', () => {
  const near = new StartleBehavior(0, 11);
  const far = new StartleBehavior(1, 11);
  const tap = tapAt();
  near.update(1 / 60, { position: { x: -0.16, y: 0.14, z: 0 }, taps: [tap] });
  far.update(1 / 60, { position: { x: 0.16, y: 0.14, z: 0.08 }, taps: [tap] });
  assert.ok(near.reactionDelay < far.reactionDelay);
  assert.ok(near.reactionDelay <= 0.14 && far.reactionDelay <= 0.14);
  for (const behavior of [near, far]) {
    assert.ok(behavior.target.x >= SPACE.minX && behavior.target.x <= SPACE.maxX);
    assert.ok(behavior.target.z >= SPACE.minZ && behavior.target.z <= SPACE.maxZ);
    assert.ok(behavior.target.y > SPACE.floorY && behavior.target.y < SPACE.waterY);
    assert.ok(behavior.fleeDuration >= STARTLE.fleeMin && behavior.fleeDuration <= STARTLE.fleeMax);
  }
});

test('individual tangential offsets prevent an identical school-wide escape vector', () => {
  const tap = tapAt({ x: 0, y: 0.14, z: SPACE.minZ });
  const position = { x: 0, y: 0.14, z: -0.06 };
  const a = new StartleBehavior(0, 21);
  const b = new StartleBehavior(1, 22);
  a.update(1 / 60, { position, taps: [tap] });
  b.update(1 / 60, { position, taps: [tap] });
  assert.notDeepEqual(a.target, b.target);
});

test('a new tap can retrigger a fleeing fish without replaying an old event', () => {
  const behavior = new StartleBehavior(0, 5);
  const position = { x: 0, y: 0.14, z: 0 };
  const first = tapAt();
  behavior.update(1 / 60, { position, taps: [first] });
  advance(behavior, 0.3, { position, taps: [first] });
  assert.equal(behavior.events, 1);
  const second = tapAt({ x: SPACE.maxX, y: 0.14, z: 0 });
  behavior.update(1 / 60, { position, taps: [first, second] });
  assert.equal(behavior.events, 2);
  assert.equal(behavior.state, 'alert');
  assert.equal(behavior.source.x, SPACE.maxX);
});

test('fright interrupts feeding, releases its claim and allows fresh discovery after settling', () => {
  const sim = new Simulation(() => 0.5);
  sim.dropFood({ x: 0, z: 0 }, 1);
  const director = new FeedingDirector(sim);
  const feeding = new FeedingBehavior(0, 2);
  const position = { x: -0.1, y: 0.14, z: 0 };
  advance(feeding, 1.2, { key: 'neon:0', position, director });
  assert.equal(feeding.state, 'gather');
  assert.equal(director.owners.get('neon:0'), 1);
  feeding.interrupt(director, 'neon:0');
  assert.equal(feeding.state, 'cruise');
  assert.equal(feeding.targetFoodId, null);
  assert.equal(director.owners.has('neon:0'), false);
  feeding.update(1 / 60, { key: 'neon:0', position, director });
  assert.equal(feeding.state, 'notice');
});

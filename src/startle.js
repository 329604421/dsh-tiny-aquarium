import { SPACE } from './core.js';
import { normalizeFeedingParams } from './customize.js';

/** 受惊节奏，与 feeding 共用同一份预设（「投喂习惯」包含惊吓手感）。 */
export const STARTLE = {
  fleeMin: 0.55,
  fleeMax: 0.9,
  settleMin: 1.25,
  settleMax: 1.85,
};

const STARTLE_BASE = { ...STARTLE };

export function applyStartlePreset(params) {
  const { params: next } = normalizeFeedingParams(params ?? {});
  STARTLE.fleeMin = next.fleeMin;
  STARTLE.fleeMax = next.fleeMax;
  STARTLE.settleMin = next.settleMin;
  STARTLE.settleMax = next.settleMax;
  return { ...STARTLE };
}

export function resetStartlePreset() {
  Object.assign(STARTLE, STARTLE_BASE);
}

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const length = vector => Math.hypot(vector.x, vector.y, vector.z);

/**
 * A tap is a short, positional fright rather than a global animation flag.
 * Every fish sees the same event, but reacts after a distance-dependent delay
 * and escapes along its own offset vector. The simulation owns tap lifetime;
 * this class only remembers which events this particular fish already heard.
 */
export class StartleBehavior {
  constructor(index, seed = 1) {
    this.index = index;
    this.random = mulberry(seed);
    this.state = 'calm';
    this.stateTime = 0;
    this.reactionDelay = 0;
    this.fleeDuration = STARTLE.fleeMin;
    this.settleDuration = STARTLE.settleMin;
    this.intensity = 0;
    this.target = null;
    this.source = null;
    this.events = 0;
    this.justTriggered = false;
    this.seen = new WeakSet();
  }

  get active() { return this.state !== 'calm'; }

  trigger(tap, position, space) {
    const source = tap.point;
    const away = {
      x: position.x - source.x,
      y: (position.y - source.y) * 0.32,
      z: position.z - source.z,
    };
    const d = length(away);
    if (d < 1e-5) {
      away.x = -tap.normal.x;
      away.y = -tap.normal.y * 0.2;
      away.z = -tap.normal.z;
    }
    const magnitude = Math.max(1e-5, length(away));
    away.x /= magnitude;
    away.y /= magnitude;
    away.z /= magnitude;

    // A little tangential variation prevents the school from becoming one
    // straight line, while the dominant direction remains away from the glass.
    const side = (this.random() - 0.5) * 0.85;
    const direction = {
      x: away.x - away.z * side,
      y: away.y + (this.random() - 0.5) * 0.28,
      z: away.z + away.x * side,
    };
    const directionLength = Math.max(1e-5, length(direction));
    const distanceFromTap = Math.hypot(position.x - source.x, position.y - source.y, position.z - source.z);
    this.intensity = clamp(1.08 - distanceFromTap * 1.35, 0.55, 1);
    const escapeDistance = (0.115 + this.random() * 0.055) * this.intensity;
    const layer = (this.index % 3) - 1;
    const lateral = layer * 0.018;
    this.target = {
      x: clamp(position.x + direction.x / directionLength * escapeDistance - away.z * lateral,
        space.minX + 0.035, space.maxX - 0.035),
      y: clamp(position.y + direction.y / directionLength * escapeDistance + layer * 0.019,
        space.floorY + 0.04, space.waterY - 0.04),
      z: clamp(position.z + direction.z / directionLength * escapeDistance + away.x * lateral,
        space.minZ + 0.034, space.maxZ - 0.034),
    };
    this.source = { x: source.x, y: source.y, z: source.z };
    this.reactionDelay = clamp(0.018 + distanceFromTap * 0.24 + this.random() * 0.035, 0.02, 0.14);
    this.fleeDuration = STARTLE.fleeMin + this.random() * (STARTLE.fleeMax - STARTLE.fleeMin);
    this.settleDuration = STARTLE.settleMin + this.random() * (STARTLE.settleMax - STARTLE.settleMin);
    this.state = 'alert';
    this.stateTime = 0;
    this.events++;
    this.justTriggered = true;
  }

  update(dt, { position, taps = [], space = SPACE }) {
    this.justTriggered = false;
    for (const tap of taps) {
      if (this.seen.has(tap)) continue;
      this.seen.add(tap);
      this.trigger(tap, position, space);
    }
    if (!this.active) return this;
    this.stateTime += dt;
    if (this.state === 'alert' && this.stateTime >= this.reactionDelay) {
      this.state = 'flee';
      this.stateTime = 0;
    } else if (this.state === 'flee' && this.stateTime >= this.fleeDuration) {
      this.state = 'settle';
      this.stateTime = 0;
    } else if (this.state === 'settle' && this.stateTime >= this.settleDuration) {
      this.state = 'calm';
      this.stateTime = 0;
      this.target = null;
      this.source = null;
      this.intensity = 0;
    }
    return this;
  }

  dispose() {
    this.seen = new WeakSet();
    this.target = null;
    this.source = null;
  }
}

function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

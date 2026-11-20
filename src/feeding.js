import { SPACE } from './core.js';
import { normalizeFeedingParams } from './customize.js';

/**
 * 投喂节奏。P4 时是冻结常量；P5 起是「当前生效的预设」——行为类在每个状态切换时
 * 读取这些值，所以切换预设不需要重建场景，也不会让鱼瞬移。
 */
export const FEEDING = {
  noticeMin: 0.25,
  noticeMax: 1,
  competeRadius: 0.055,
  scatterMin: 3.2,
  scatterMax: 4.6,
};

const FEEDING_BASE = { ...FEEDING };

/** 应用一份投喂预设；越界值由 normalizeFeedingParams 回退，返回值便于诊断。 */
export function applyFeedingPreset(params) {
  const { params: next, repaired } = normalizeFeedingParams(params ?? {});
  FEEDING.noticeMin = next.noticeMin;
  FEEDING.noticeMax = next.noticeMax;
  FEEDING.competeRadius = next.competeRadius;
  FEEDING.scatterMin = next.scatterMin;
  FEEDING.scatterMax = next.scatterMax;
  return { ...FEEDING, repaired };
}

export function resetFeedingPreset() {
  Object.assign(FEEDING, FEEDING_BASE);
}

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const point = p => ({ x: p.x, y: p.y, z: p.z });

/**
 * Shared food claims keep both species interested in the same pellets without
 * sending every fish to exactly one coordinate. Claims influence target choice;
 * consumption itself remains atomic in Simulation, so a rival can still win.
 */
export class FeedingDirector {
  constructor(simulation) {
    this.simulation = simulation;
    this.owners = new Map();
    this.claims = new Map();
  }

  get food() { return this.simulation.food; }

  claim(key, id) {
    if (this.owners.get(key) === id) return;
    this.release(key);
    this.owners.set(key, id);
    if (!this.claims.has(id)) this.claims.set(id, new Set());
    this.claims.get(id).add(key);
  }

  release(key) {
    const id = this.owners.get(key);
    if (id === undefined) return;
    this.owners.delete(key);
    const claimed = this.claims.get(id);
    claimed?.delete(key);
    if (!claimed?.size) this.claims.delete(id);
  }

  nearest(position) {
    let best = null;
    let bestDistance = Infinity;
    for (const pellet of this.food) {
      if (pellet.state !== 'active') continue;
      const d = distance(position, pellet);
      if (d < bestDistance) { best = pellet; bestDistance = d; }
    }
    return best;
  }

  select(position, key) {
    let best = null;
    let bestScore = Infinity;
    for (const pellet of this.food) {
      if (pellet.state !== 'active') continue;
      const claimed = this.claims.get(pellet.id);
      const rivals = (claimed?.size ?? 0) - (claimed?.has(key) ? 1 : 0);
      // A loose crowd penalty spreads the school over several pellets. When
      // only one pellet remains, every fish may still converge and compete.
      const score = distance(position, pellet) + rivals * 0.042;
      if (score < bestScore) { best = pellet; bestScore = score; }
    }
    return best;
  }

  consume(id) {
    const consumed = this.simulation.consume(id);
    if (consumed) this.claims.delete(id);
    return consumed;
  }

  dispose() {
    this.owners.clear();
    this.claims.clear();
  }
}

/**
 * Per-fish feeding decisions. Movement stays in each species' established
 * controller; this class only owns notice/gather/compete/scatter transitions.
 */
export class FeedingBehavior {
  constructor(index, seed = 1) {
    this.index = index;
    this.random = mulberry(seed);
    this.state = 'cruise';
    this.stateTime = 0;
    this.noticeDelay = 0;
    this.scatterDuration = FEEDING.scatterMin;
    this.targetFoodId = null;
    this.target = null;
    this.lastFoodPoint = null;
    this.foodDistance = Infinity;
    this.eaten = 0;
  }

  get active() { return this.state !== 'cruise'; }

  enterNotice(delay) {
    this.state = 'notice';
    this.stateTime = 0;
    this.noticeDelay = delay;
    this.targetFoodId = null;
  }

  interrupt(director, key) {
    director?.release(key);
    this.state = 'cruise';
    this.stateTime = 0;
    this.targetFoodId = null;
    this.target = null;
    this.lastFoodPoint = null;
    this.foodDistance = Infinity;
  }

  beginScatter(position, space) {
    this.state = 'scatter';
    this.stateTime = 0;
    this.scatterDuration = FEEDING.scatterMin + this.random() * (FEEDING.scatterMax - FEEDING.scatterMin);
    this.targetFoodId = null;
    this.foodDistance = Infinity;
    const origin = this.lastFoodPoint ?? position;
    const group = this.index % 3;
    const angle = -2.45 + group * 2.45;
    const spread = 0.078 + this.random() * 0.025;
    const subgroup = Math.floor(this.index / 3) - 0.5;
    this.target = {
      x: clamp(origin.x + Math.cos(angle) * spread + subgroup * 0.012, space.minX + 0.035, space.maxX - 0.035),
      y: clamp(Math.max(position.y, origin.y) - 0.018 + (this.index % 2) * 0.012,
        space.floorY + 0.045, space.waterY - 0.035),
      z: clamp(origin.z + Math.sin(angle) * spread + subgroup * 0.008, space.minZ + 0.032, space.maxZ - 0.032),
    };
  }

  approachPoint(pellet, radius, space) {
    if (!radius) return point(pellet);
    const angle = this.index * 2.399963 + 0.45;
    return {
      x: clamp(pellet.x + Math.cos(angle) * radius, space.minX + 0.026, space.maxX - 0.026),
      y: pellet.y + ((this.index % 3) - 1) * radius * 0.22,
      z: clamp(pellet.z + Math.sin(angle) * radius, space.minZ + 0.026, space.maxZ - 0.026),
    };
  }

  update(dt, { key, position, director, space = SPACE, eatRadius = 0.02, approachRadius = 0.014 }) {
    this.stateTime += dt;

    if (this.state === 'cruise') {
      if (!director.food.length) return this;
      const nearest = director.nearest(position);
      const delay = clamp(0.18 + distance(position, nearest) * 1.7 + this.random() * 0.22,
        FEEDING.noticeMin, FEEDING.noticeMax);
      this.enterNotice(delay);
      this.target = point(nearest);
      return this;
    }

    if (this.state === 'scatter') {
      // Fresh food recalls a fish that has only just started to disperse.
      if (director.food.length && this.stateTime > 0.35) {
        const nearest = director.nearest(position);
        this.enterNotice(0.22 + this.random() * 0.25);
        this.target = point(nearest);
      } else if (this.stateTime >= this.scatterDuration) {
        this.state = 'cruise';
        this.target = null;
        this.lastFoodPoint = null;
      }
      return this;
    }

    if (!director.food.length) {
      director.release(key);
      this.beginScatter(position, space);
      return this;
    }

    if (this.state === 'notice') {
      const nearest = director.nearest(position);
      this.target = point(nearest);
      this.lastFoodPoint = point(nearest);
      this.foodDistance = distance(position, nearest);
      if (this.stateTime >= this.noticeDelay) {
        const selected = director.select(position, key);
        director.claim(key, selected.id);
        this.targetFoodId = selected.id;
        this.target = this.approachPoint(selected, approachRadius, space);
        this.state = 'gather';
        this.stateTime = 0;
      }
      return this;
    }

    const pellet = director.food.find(item => item.id === this.targetFoodId && item.state === 'active');
    if (!pellet) {
      // Another fish won this pellet. Hover briefly, then choose another one;
      // if that was the last pellet, join the staggered dispersal groups.
      director.release(key);
      this.targetFoodId = null;
      if (director.food.length) this.enterNotice(0.12 + this.random() * 0.2);
      else this.beginScatter(position, space);
      return this;
    }

    this.target = this.approachPoint(pellet, approachRadius, space);
    this.lastFoodPoint = point(pellet);
    this.foodDistance = distance(position, pellet);
    if (this.state === 'gather' && this.foodDistance <= FEEDING.competeRadius) {
      this.state = 'compete';
      this.stateTime = 0;
    }
    if (this.foodDistance <= eatRadius && director.consume(pellet.id)) {
      this.eaten++;
      director.release(key);
      this.targetFoodId = null;
      this.target = null;
      this.foodDistance = Infinity;
      if (director.food.length) this.enterNotice(0.08 + this.random() * 0.16);
      else this.beginScatter(position, space);
    }
    return this;
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

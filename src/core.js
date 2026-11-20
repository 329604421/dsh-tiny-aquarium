import { DEFAULT_SCAPE_ID } from './scape-data.js';

export const SPACE = Object.freeze({
  width: 0.4, height: 0.3, depth: 0.25, waterY: 0.267, floorY: 0.018,
  minX: -0.193, maxX: 0.193, minZ: -0.118, maxZ: 0.118,
});
export const LIMITS = Object.freeze({ food: 100, batch: 4, autoFeedBatch: 5, feedMs: 150, tapMs: 300, life: 25, step: 1 / 60 });
/** 1 is the fitted overview size; 3 is the closest the glass should get. */
export const ZOOM = Object.freeze({ min: 1, max: 2.2 });
export const clampZoom = value => clamp(Number.isFinite(value) ? value : ZOOM.min, ZOOM.min, ZOOM.max);
export const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
export const DEFAULT_CONFIG = Object.freeze({
  schemaVersion: 1, tankPresetId: 'tank.clear-40', lampPresetId: 'lamp.arch',
  scapePresetId: DEFAULT_SCAPE_ID, lightMode: 'auto', qualityMode: 'auto',
  feedingPresetId: 'feeding.standard', customFishIds: [],
});
/**
 * 只校验形状，不校验 id 是否"等于内置值"：P5 起缸体/灯具/造景/投喂都可能是定制 id，
 * 真正是否存在由清单目录（custom-catalog）判定并回退，这里负责挡住类型错误。
 */
export function normalizeConfig(value = {}) {
  if (!value || typeof value !== 'object') value = {};
  const config = { ...DEFAULT_CONFIG, customFishIds: [] };
  const repaired = [];
  for (const key of Object.keys(DEFAULT_CONFIG)) {
    if (value[key] === undefined) continue;
    if (key === 'customFishIds') {
      if (Array.isArray(value[key])) config.customFishIds = value[key].filter(id => typeof id === 'string' && id);
      else repaired.push(key);
      continue;
    }
    const valid = key === 'lightMode' ? ['auto', 'on', 'off'].includes(value[key])
      : key === 'qualityMode' ? ['auto', 'standard', 'eco'].includes(value[key])
        : key === 'schemaVersion' ? Number.isFinite(value[key])
          : typeof value[key] === 'string' && value[key].length > 0;
    if (valid) config[key] = value[key];
    else repaired.push(key);
  }
  return { config, repaired };
}

export class Gesture {
  begin(id, x, y, hit) {
    this.current = { id, x, y, startX: x, startY: y, distance: 0, dragged: false, hit };
  }
  move(id, x, y) {
    const g = this.current;
    if (!g || g.id !== id) return 0;
    const dx = x - g.x;
    g.distance += Math.hypot(dx, y - g.y);
    g.dragged ||= g.distance >= 6;
    g.x = x;
    g.y = y;
    return g.dragged && ['glass', 'water', 'body'].includes(g.hit) ? dx : 0;
  }
  end(id, x, y, hit, feeding) {
    if (this.current?.id !== id) return 'none';
    this.move(id, x, y);
    const g = this.current;
    this.current = null;
    if (g.dragged) return 'none';
    if (g.hit === 'blank') return hit === 'blank' ? 'close' : 'none';
    if (feeding) return g.hit === 'water' && hit === 'water' ? 'feed' : 'none';
    return g.hit === 'glass' && hit === 'glass' ? 'tap' : 'none';
  }
  cancel() { this.current = null; }
}

export class FixedClock {
  accumulator = 0;
  previous = null;
  reset() { this.previous = null; this.accumulator = 0; }
  tick(now, update) {
    if (this.previous === null) { this.previous = now; return 0; }
    this.accumulator += clamp((now - this.previous) / 1000, 0, LIMITS.step * 3);
    this.previous = now;
    let steps = 0;
    while (this.accumulator + 1e-10 >= LIMITS.step && steps < 3) {
      update(LIMITS.step);
      this.accumulator = Math.max(0, this.accumulator - LIMITS.step);
      steps++;
    }
    return steps;
  }
}

export class Simulation {
  constructor(random = Math.random) {
    this.random = random;
    this.food = [];
    this.taps = [];
    this.nextId = 1;
    this.time = 0;
    this.yaw = -0.35;
    this.wave = 0;
    this.waveVelocity = 0;
    this.waveCross = 0;
    this.waveCrossVelocity = 0;
    this.lastFeed = -Infinity;
    this.lastTap = -Infinity;
    this.tapListeners = new Set();
  }
  rotate(delta) {
    this.yaw += delta;
    this.waveVelocity = clamp(this.waveVelocity + delta * 0.065, -0.075, 0.075);
    this.waveCrossVelocity = clamp(this.waveCrossVelocity - delta * 0.043, -0.052, 0.052);
  }
  onTap(listener) { this.tapListeners.add(listener); return () => this.tapListeners.delete(listener); }
  tap(point, normal, now) {
    if (now - this.lastTap < LIMITS.tapMs) return false;
    this.lastTap = now;
    const event = Object.freeze({ point: Object.freeze({ ...point }), normal: Object.freeze({ ...normal }), time: this.time, intensity: 1 });
    this.taps.push(event);
    for (const listener of this.tapListeners) listener(event);
    return true;
  }
  /**
   * Drop a batch at one point. The whole batch lands or nothing does: the
   * automatic feeder must never turn five pellets into three.
   * @returns 'added', 'full' or 'outside'.
   */
  dropFood(point, count) {
    if (!Number.isFinite(count) || count <= 0) return 'outside';
    if (point.x < SPACE.minX || point.x > SPACE.maxX || point.z < SPACE.minZ || point.z > SPACE.maxZ) return 'outside';
    if (this.food.length + count > LIMITS.food) return 'full';
    for (let i = 0; i < count; i++) {
      this.food.push({
        id: this.nextId++, state: 'active', age: 0, alpha: 1,
        x: clamp(point.x + (this.random() - 0.5) * 0.014, SPACE.minX, SPACE.maxX),
        y: SPACE.waterY + 0.005 + this.random() * 0.007,
        z: clamp(point.z + (this.random() - 0.5) * 0.014, SPACE.minZ, SPACE.maxZ),
        radius: 0.0012 + this.random() * 0.0007,
        speed: 0.022 + this.random() * 0.012,
        phase: this.random() * Math.PI * 2,
      });
    }
    this.waveVelocity = clamp(this.waveVelocity + 0.005, -0.075, 0.075);
    this.waveCrossVelocity = clamp(this.waveCrossVelocity + 0.0025, -0.052, 0.052);
    return 'added';
  }
  /**
   * Drop a manual batch. The caller passes how many pellets the stock can
   * afford (the token ledger owns the stock), so a nearly empty jar still
   * feeds its last pellet instead of refusing the whole batch.
   * @returns 'added', 'full', 'outside' or 'throttled'.
   */
  feed(point, now, count = LIMITS.batch) {
    if (now - this.lastFeed < LIMITS.feedMs) return 'throttled';
    const want = clamp(Math.floor(Number.isFinite(count) ? count : LIMITS.batch), 1, LIMITS.batch);
    if (this.food.length + want > LIMITS.food) return 'full';
    const result = this.dropFood(point, want);
    if (result === 'added') this.lastFeed = now;
    return result;
  }
  // P2 consumes an ID atomically; expired or already eaten IDs return false.
  consume(id) {
    const index = this.food.findIndex(p => p.id === id && p.state === 'active');
    if (index < 0) return false;
    this.food[index].state = 'consumed';
    this.food.splice(index, 1);
    return true;
  }
  update(dt) {
    this.time += dt;
    this.waveVelocity += (-30 * this.wave - 2.8 * this.waveVelocity) * dt;
    this.wave = clamp(this.wave + this.waveVelocity * dt, -0.011, 0.011);
    this.waveCrossVelocity += (-41 * this.waveCross - 3.4 * this.waveCrossVelocity) * dt;
    this.waveCross = clamp(this.waveCross + this.waveCrossVelocity * dt, -0.007, 0.007);
    for (const p of this.food) {
      p.age += dt;
      p.y = Math.max(SPACE.floorY + p.radius, p.y - p.speed * dt);
      p.x = clamp(p.x + Math.sin(this.time * 1.2 + p.phase) * 0.0016 * dt, SPACE.minX, SPACE.maxX);
      p.z = clamp(p.z + Math.cos(this.time + p.phase) * 0.0012 * dt, SPACE.minZ, SPACE.maxZ);
      p.alpha = clamp((LIMITS.life - p.age) / 3, 0, 1);
    }
    this.food = this.food.filter(p => p.age < LIMITS.life);
    this.taps = this.taps.filter(p => this.time - p.time < 0.7);
  }
  dispose() { this.food.length = 0; this.taps.length = 0; this.tapListeners.clear(); }
}

export function effectiveLight(mode, dark, override) {
  return override ?? (mode === 'on' || (mode === 'auto' && dark));
}


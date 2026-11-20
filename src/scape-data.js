export const DEFAULT_SCAPE_ID = 'scape.jungle';

/**
 * P3 layout contract. All authored values are centimetres in tank-local space;
 * rendering and runtime queries convert them to metres at the boundary.
 * Rock sizes are full extents; plant roots sit on the substrate.
 */
export const SCAPE_PRESETS = Object.freeze([
  {
    id: 'scape.moss', nameKey: 'preset.scape.moss', descriptionKey: 'scapeMossHint',
    substrateId: 'substrate.moss-stones', plantId: 'plant.moss-cover',
    airStone: [-15, 2.1, -7.5],
    rocks: [
      { center: [-4, 7.2, -3], size: [8.2, 11.2, 6.8], rotation: [0.08, -0.35, -0.12], moss: 42 },
      { center: [2.2, 4.8, -1.8], size: [6.6, 6.8, 5.8], rotation: [-0.08, 0.42, 0.18], moss: 30 },
      { center: [-9.5, 3.7, 1.6], size: [7.4, 4.4, 5.8], rotation: [0.14, 0.2, -0.1], moss: 26 },
      { center: [7.2, 3.1, 1.8], size: [6.4, 3.4, 5.2], rotation: [-0.1, -0.5, 0.08], moss: 20 },
      { center: [-1.5, 2.5, 5.8], size: [5.2, 2.4, 3.8], rotation: [0.1, 0.5, 0], moss: 14 },
      { center: [12.8, 2.4, -5.8], size: [4.5, 2.6, 4], rotation: [0, 0.3, 0.12], moss: 12 },
    ],
    woods: [],
    plants: [
      { kind: 'carpet', center: [-10.5, 1.65, 6.3], count: 38, height: [1.1, 2.7], spread: 5.2, width: 0.2 },
      { kind: 'carpet', center: [7.8, 1.65, 6.8], count: 36, height: [1, 2.5], spread: 5.4, width: 0.18 },
      { kind: 'grass', center: [-13.8, 1.65, -5.8], count: 20, height: [5.5, 9.5], spread: 3.4, width: 0.3 },
      { kind: 'grass', center: [12.8, 1.65, -6.2], count: 16, height: [4.5, 8], spread: 3, width: 0.26 },
      { kind: 'stem', center: [-12.5, 1.65, -3.8], count: 6, height: [4.5, 7.5], spread: 2.8, width: 0.58 },
      { kind: 'broadleaf', center: [10.4, 1.65, -1.2], count: 14, height: [3.4, 5.8], spread: 3.2, width: 1.05 },
      { kind: 'carpet', center: [-1.5, 1.65, 4.2], count: 26, height: [0.8, 1.8], spread: 4.4, width: 0.16 },
    ],
  },
  {
    id: 'scape.jungle', nameKey: 'preset.scape.jungle', descriptionKey: 'scapeJungleHint',
    substrateId: 'substrate.jungle-stones', plantId: 'plant.jungle-mix',
    airStone: [-16, 2.1, -8],
    rocks: [
      { center: [-2.8, 4.5, -3.8], size: [6.4, 5.8, 5.2], rotation: [0.1, -0.25, -0.12], moss: 24 },
      { center: [2.4, 3.1, -2.4], size: [5.6, 3.4, 4.8], rotation: [-0.08, 0.4, 0.1], moss: 18 },
      { center: [-7.2, 2.6, 1.8], size: [4.4, 2.6, 3.8], rotation: [0.1, 0.2, 0], moss: 12 },
      { center: [9.8, 2.5, 3.8], size: [4.8, 2.4, 3.6], rotation: [0.08, -0.4, 0.12], moss: 10 },
    ],
    woods: [],
    plants: [
      { kind: 'grass', center: [-15.2, 1.65, -6.8], count: 34, height: [12, 21], spread: 4.2, width: 0.4 },
      { kind: 'grass', center: [15.2, 1.65, -7], count: 30, height: [10, 19], spread: 3.6, width: 0.36 },
      { kind: 'grass', center: [-6.8, 1.65, -8.8], count: 24, height: [8, 15], spread: 4, width: 0.32 },
      { kind: 'grass', center: [6.4, 1.65, -8.6], count: 22, height: [7, 14], spread: 3.8, width: 0.3 },
      { kind: 'stem', center: [-10.2, 1.65, -1.4], count: 10, height: [5, 10], spread: 3.6, width: 0.66 },
      { kind: 'stem', center: [-3.8, 1.65, -4.8], count: 8, height: [5, 9], spread: 3.4, width: 0.6, tint: 'red' },
      { kind: 'stem', center: [-1.5, 1.65, 1.8], count: 8, height: [3.8, 7.2], spread: 3.5, width: 0.62 },
      { kind: 'broadleaf', center: [11.8, 1.65, -2.6], count: 21, height: [4.2, 8.6], spread: 4, width: 1.5 },
      { kind: 'broadleaf', center: [-11.8, 1.65, 2.8], count: 14, height: [3.2, 6], spread: 3.2, width: 1.15 },
      { kind: 'carpet', center: [-8.8, 1.65, 7.2], count: 48, height: [1.1, 2.8], spread: 6, width: 0.18 },
      { kind: 'carpet', center: [7.8, 1.65, 7.6], count: 46, height: [1, 2.5], spread: 5.8, width: 0.17 },
      { kind: 'carpet', center: [1.2, 1.65, 5.8], count: 26, height: [0.8, 1.8], spread: 4.6, width: 0.15 },
    ],
  },
  {
    id: 'scape.driftwood', nameKey: 'preset.scape.driftwood', descriptionKey: 'scapeDriftwoodHint',
    substrateId: 'substrate.driftwood-stones', plantId: 'plant.driftwood-sparse',
    airStone: [-14.8, 2.1, -7.2],
    rocks: [
      { center: [10.8, 2.9, -1.8], size: [7.2, 3.2, 5.8], rotation: [0.08, 0.25, -0.08], moss: 18 },
      { center: [5.2, 2.4, 3.8], size: [5.4, 2.2, 4.2], rotation: [-0.08, -0.4, 0.06], moss: 12 },
      { center: [-8.5, 3.2, -2.8], size: [5.6, 3.8, 4.6], rotation: [0.1, 0.45, -0.1], moss: 14 },
      { center: [-2.8, 2.1, 6.8], size: [3.8, 1.6, 3], rotation: [0, 0.2, 0], moss: 8 },
    ],
    woods: [
      { points: [[10.5, 1.7, -2], [8.2, 5.8, -2.5], [5.2, 9.8, -3.1], [6.4, 13.8, -3.8], [3.8, 18.6, -4.5]], radii: [1.9, 1.5, 1.05, 0.58, 0.07] },
      { points: [[6.2, 8.4, -2.9], [1.8, 10.2, -2.2], [-1.2, 12.8, -2.5], [-0.4, 15.8, -3]], radii: [0.95, 0.62, 0.3, 0.055] },
      { points: [[5.8, 12.2, -3.6], [10.2, 13.2, -4.1], [13.4, 15.2, -4.5], [15.2, 17.4, -4.8]], radii: [0.68, 0.43, 0.23, 0.045] },
      { points: [[9.4, 3.1, -1.8], [5.8, 2.3, 0.8], [2.2, 1.9, 2.8]], radii: [1.1, 0.62, 0.07] },
      { points: [[10.8, 2.7, -2], [14.2, 2.1, 0.2], [17, 1.8, 2.4]], radii: [0.95, 0.48, 0.06] },
      { points: [[8.2, 5.6, -2.4], [12.8, 6.5, -0.2], [16.2, 9.2, 0.4]], radii: [0.72, 0.38, 0.05] },
      { points: [[1.2, 11.2, -2.4], [2.4, 14.2, -1.2], [1.2, 16.7, -0.6]], radii: [0.36, 0.19, 0.035] },
      { points: [[12.8, 14.7, -4.4], [14.8, 13.4, -3.4], [16.8, 13.8, -2.6]], radii: [0.28, 0.15, 0.03] },
    ],
    plants: [
      { kind: 'broadleaf', center: [12.8, 1.65, 3.2], count: 21, height: [3.4, 6.6], spread: 3.8, width: 1.2 },
      { kind: 'broadleaf', center: [-8.8, 1.65, -1.8], count: 14, height: [2.8, 5], spread: 3, width: 0.95 },
      { kind: 'stem', center: [-13.2, 1.65, -5.8], count: 7, height: [5, 9], spread: 3.2, width: 0.58 },
      { kind: 'stem', center: [4.2, 1.65, -7.8], count: 5, height: [4, 7], spread: 2.8, width: 0.52, tint: 'red' },
      { kind: 'carpet', center: [-10.6, 1.65, 6.8], count: 38, height: [1.2, 3.2], spread: 5.2, width: 0.19 },
      { kind: 'carpet', center: [5.2, 1.65, 6.8], count: 30, height: [1, 2.5], spread: 4.6, width: 0.17 },
      { kind: 'grass', center: [1.8, 1.65, -6.8], count: 18, height: [3, 6.5], spread: 3, width: 0.24 },
    ],
  },
]);

export const SCAPE_IDS = Object.freeze(SCAPE_PRESETS.map(preset => preset.id));
export const getScapePreset = id => SCAPE_PRESETS.find(preset => preset.id === id) || SCAPE_PRESETS.find(preset => preset.id === DEFAULT_SCAPE_ID);
const metres = values => values.map(value => value / 100);

/** Simplified runtime volumes, in metres. P4 can consume this list directly. */
export function getScapeCollision(id) {
  const preset = getScapePreset(id);
  const volumes = preset.rocks.map((rock, index) => ({
    id: `${preset.id}.rock.${index}`, type: 'box', kind: 'solid',
    center: metres(rock.center), size: metres(rock.size),
  }));
  for (const [index, plant] of preset.plants.entries()) {
    const height = plant.height[1];
    volumes.push({
      id: `${preset.id}.plant.${index}`, type: 'cylinder', kind: 'soft',
      center: metres([plant.center[0], plant.center[1] + height / 2, plant.center[2]]),
      radius: (plant.spread * 0.58 + 0.5) / 100, height: height / 100,
    });
  }
  for (const [index, wood] of preset.woods.entries()) {
    const radius = Math.max(...wood.radii);
    const min = [0, 1, 2].map(axis => Math.min(...wood.points.map(point => point[axis])) - radius);
    const max = [0, 1, 2].map(axis => Math.max(...wood.points.map(point => point[axis])) + radius);
    volumes.push({
      id: `${preset.id}.wood.${index}`, type: 'box', kind: 'solid',
      center: metres(min.map((value, axis) => (value + max[axis]) / 2)),
      size: metres(min.map((value, axis) => max[axis] - value)),
    });
  }
  return volumes;
}

/** Minimal P3 centre-point guard; P4 replaces this with sampled path planning. */
export function constrainToScape(position, collision, margin = 0.007) {
  const result = { x: position.x, y: position.y, z: position.z };
  for (let pass = 0; pass < 2; pass++) {
    for (const volume of collision) {
      if (volume.type === 'box' && volume.kind === 'solid') {
        const half = volume.size.map(value => value / 2 + margin);
        const delta = [result.x - volume.center[0], result.y - volume.center[1], result.z - volume.center[2]];
        if (!delta.every((value, axis) => Math.abs(value) < half[axis])) continue;
        const penetration = delta.map((value, axis) => half[axis] - Math.abs(value));
        const axis = penetration.indexOf(Math.min(...penetration));
        const key = ['x', 'y', 'z'][axis];
        result[key] = volume.center[axis] + (delta[axis] < 0 ? -half[axis] : half[axis]);
      } else if (volume.type === 'cylinder' && volume.kind === 'soft') {
        // Soft leaves permit passage; only the dense central stem band repels fish.
        if (Math.abs(result.y - volume.center[1]) > volume.height / 2 + margin) continue;
        const dx = result.x - volume.center[0], dz = result.z - volume.center[2];
        const distance = Math.hypot(dx, dz);
        const core = volume.radius * 0.32 + margin;
        if (distance >= core) continue;
        const nx = distance > 1e-6 ? dx / distance : 1, nz = distance > 1e-6 ? dz / distance : 0;
        result.x = volume.center[0] + nx * core;
        result.z = volume.center[2] + nz * core;
      }
    }
  }
  return result;
}

export function scapeSummary(id) {
  const preset = getScapePreset(id);
  return {
    id: preset.id, airStone: metres(preset.airStone), collision: getScapeCollision(id),
    rocks: preset.rocks.length, woodBranches: preset.woods.length,
    plantClusters: preset.plants.length, leaves: preset.plants.reduce((sum, plant) => sum + plant.count, 0),
  };
}

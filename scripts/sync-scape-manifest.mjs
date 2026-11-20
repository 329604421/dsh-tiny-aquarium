import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { SCAPE_PRESETS, getScapeCollision, scapeSummary } from '../src/scape-data.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const file = root + 'presets.json';
const manifest = JSON.parse(await readFile(file, 'utf8'));
const round = value => Math.round(value * 100) / 100;
const collisionCm = volume => ({
  type: volume.type, kind: volume.kind,
  center: volume.center.map(value => round(value * 100)),
  ...(volume.size ? { size: volume.size.map(value => round(value * 100)) } : {}),
  ...(volume.radius !== undefined ? { radius: round(volume.radius * 100) } : {}),
  ...(volume.height !== undefined ? { height: round(volume.height * 100) } : {}),
});
const generated = [];
for (const preset of SCAPE_PRESETS) {
  const summary = scapeSummary(preset.id);
  const collision = getScapeCollision(preset.id);
  const common = {
    version: 1, file: 'client.scene.js', sourceType: 'procedural',
    bounds: [40, 24, 24], anchor: 'tank-local-bottom', forward: '+y',
    origin: 'builtin', license: 'MIT', author: 'DSH Eco Aquarium contributors', source: 'src/scape-data.js',
  };
  generated.push({
    ...common, id: preset.substrateId, category: 'substrate', displayName: preset.nameKey,
    collision: collision.filter(volume => volume.kind === 'solid').map(collisionCm),
    params: { presetId: preset.id, rocks: summary.rocks, woodBranches: summary.woodBranches },
  });
  generated.push({
    ...common, id: preset.plantId, category: 'plant', displayName: preset.nameKey,
    collision: collision.filter(volume => volume.kind === 'soft').map(collisionCm),
    params: {
      presetId: preset.id, clusters: summary.plantClusters, leaves: summary.leaves,
      sway: { amplitudeCm: 0.38, frequencyHz: 0.15, rootWeight: 0, tipWeight: 1 },
      maxHeightCm: 20, maxSpreadCm: 5.4,
    },
  });
}
manifest.presets = [...manifest.presets.filter(entry => entry.source !== 'src/scape-data.js'), ...generated];
await writeFile(file, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
console.log(`presets.json: ${generated.length} P3 asset entries synchronized`);

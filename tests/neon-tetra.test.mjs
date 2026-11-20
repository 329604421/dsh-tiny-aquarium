import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyNeonTetraVertex } from '../src/neon-tetra.js';
import { SPECIES } from '../src/species.js';
import { REGION } from '../src/clownfish.js';

test('P2 neon tetra replaces retired silverfish with a five-fish 4cm school', () => {
  assert.equal(SPECIES.silverfish, undefined);
  assert.equal(SPECIES.neonTetra.id, 'neon-tetra');
  assert.equal(SPECIES.neonTetra.count, 5);
  assert.equal(SPECIES.neonTetra.targetLength, 0.04);
  assert.equal(SPECIES.neonTetra.rig, 'neon-tetra');
});

test('P2 neon tetra anatomical regions are distinct and fin tips are normalized', () => {
  assert.deepEqual(classifyNeonTetraVertex(0.10, 0, 0), { region: REGION.BODY, tip: 0 });
  assert.equal(classifyNeonTetraVertex(1.0, 0, 0).region, REGION.CAUDAL);
  assert.ok(Math.abs(classifyNeonTetraVertex(1.0, 0, 0).tip - 1) < 1e-12);
  assert.equal(classifyNeonTetraVertex(0.48, 1, 0).region, REGION.DORSAL);
  assert.equal(classifyNeonTetraVertex(0.48, 1, 0).tip, 1);
  assert.equal(classifyNeonTetraVertex(0.64, -1, 0).region, REGION.ANAL);
  assert.equal(classifyNeonTetraVertex(0.64, -1, 0).tip, 1);
  assert.equal(classifyNeonTetraVertex(0.42, -1, 0).region, REGION.PELVIC);
  assert.equal(classifyNeonTetraVertex(0.42, -1, 0).tip, 1);
});

test('P2 neon tetra pectoral fins are lateral, paired and do not cover the flank', () => {
  const left = classifyNeonTetraVertex(0.29, -0.15, -0.90);
  const right = classifyNeonTetraVertex(0.29, -0.15, 0.90);
  assert.equal(left.region, REGION.PECTORAL);
  assert.equal(right.region, REGION.PECTORAL);
  assert.equal(left.tip, right.tip);
  assert.equal(left.pin, 0.29);
  assert.equal(classifyNeonTetraVertex(0.29, -0.15, 0.40).region, REGION.BODY);
});

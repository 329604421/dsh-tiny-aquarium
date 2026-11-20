import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { normalize } from '../../src/fish.js';
import { bakeNeonTetraAttributes, neonTetraMaterial, createNeonTetraState } from '../../src/neon-tetra.js';
import { SPECIES } from '../../src/species.js';
import glb from '../../assets/p2-src/neon-tetra.glb';

// Row 0: side / head / top / three-quarter. Row 1: four swim phases.
// Row 2: head / neon stripe / tail peduncle / fin close-ups.
const SIZE = 420;
const COLS = 4;
const ROWS = 3;
async function main() {
  const canvas = document.createElement('canvas');
  canvas.width = SIZE * COLS;
  canvas.height = SIZE * ROWS;
  document.body.append(canvas);
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setSize(canvas.width, canvas.height, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.04;
  renderer.setScissorTest(true);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x7f8f8b);
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.add(new THREE.HemisphereLight(0xe1f5f2, 0x726b4b, 1.2));
  const sun = new THREE.DirectionalLight(0xffffff, 1.25);
  sun.position.set(-0.4, 0.7, 0.5);
  scene.add(sun);
  const spot = new THREE.SpotLight(0xffe8be, 0.44, 1.3, Math.PI / 3.3, 0.7, 2);
  spot.position.set(0.035, 0.351, 0.018);
  spot.target.position.set(0, 0.05, 0);
  scene.add(spot, spot.target);

  const loader = new GLTFLoader();
  const buffer = glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength);
  const gltf = await new Promise((resolve, reject) => loader.parse(buffer, '', resolve, reject));
  const rig = bakeNeonTetraAttributes(gltf.scene);
  const state = createNeonTetraState(0.4);
  const info = { meshes: [], tris: 0, verts: 0, regionCounts: {} };
  gltf.scene.traverse(node => {
    if (!node.isMesh) return;
    node.material = neonTetraMaterial(node.material, state, rig);
    node.castShadow = true;
    node.frustumCulled = false;
    const geometry = node.geometry;
    const tris = geometry.index ? geometry.index.count / 3 : geometry.attributes.position.count / 3;
    info.tris += tris;
    info.verts += geometry.attributes.position.count;
    const regions = geometry.attributes.aRegion?.array || [];
    for (const value of regions) info.regionCounts[value] = (info.regionCounts[value] || 0) + 1;
    info.meshes.push({ name: node.name, tris });
  });
  const species = SPECIES.neonTetra;
  const { outer } = normalize(gltf.scene, species.targetLength, species.facing);
  scene.add(outer);
  outer.updateMatrixWorld(true);
  info.fittedSize = new THREE.Box3().setFromObject(outer).getSize(new THREE.Vector3()).toArray();

  const d = 0.083;
  const views = [
    { pos: [0, 0.003, d], up: [0, 1, 0], fov: 30 },
    { pos: [d, 0.002, 0], up: [0, 1, 0], fov: 30 },
    { pos: [0, d, 0.0001], up: [0, 0, 1], fov: 30 },
    { pos: [d * 0.65, d * 0.20, d * 0.76], up: [0, 1, 0], fov: 30 },
  ];
  const swim = { pos: [d * 0.12, d * 0.08, d], up: [0, 1, 0], fov: 28 };
  const closeups = [
    { target: [0.015, 0.001, 0.002], offset: [0.010, 0.006, 0.020], fov: 20 },
    { target: [0.004, 0.001, 0.003], offset: [0.002, 0.005, 0.021], fov: 20 },
    { target: [-0.016, 0.000, 0.000], offset: [-0.006, 0.005, 0.019], fov: 20 },
    { target: [-0.003, 0.004, 0.000], offset: [0.006, 0.013, 0.018], fov: 20 },
  ];
  function renderCell(col, row, view) {
    const camera = new THREE.PerspectiveCamera(view.fov, 1, 0.001, 10);
    camera.position.set(...view.pos);
    camera.up.set(...(view.up || [0, 1, 0]));
    if (view.target) camera.lookAt(...view.target); else camera.lookAt(0, 0, 0);
    renderer.setViewport(col * SIZE, (ROWS - 1 - row) * SIZE, SIZE, SIZE);
    renderer.setScissor(col * SIZE, (ROWS - 1 - row) * SIZE, SIZE, SIZE);
    renderer.render(scene, camera);
  }
  state.time.value = 0.4;
  state.row.value = 0;
  views.forEach((view, col) => renderCell(col, 0, view));
  for (let col = 0; col < COLS; col++) {
    const t = col * Math.PI * 0.5;
    state.time.value = t;
    state.row.value = t * 1.4;
    renderCell(col, 1, swim);
  }
  state.time.value = 0.4;
  state.row.value = 0;
  closeups.forEach((closeup, col) => {
    const target = new THREE.Vector3(...closeup.target);
    const pos = target.clone().add(new THREE.Vector3(...closeup.offset));
    renderCell(col, 2, { pos: pos.toArray(), target: target.toArray(), fov: closeup.fov });
  });
  window.__neonTetra = info;
  window.__ready = true;
}
main().catch(error => { console.error(error); window.__error = String(error); });

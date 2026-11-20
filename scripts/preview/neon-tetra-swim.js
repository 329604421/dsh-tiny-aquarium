import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { normalize } from '../../src/fish.js';
import { bakeNeonTetraAttributes, neonTetraMaterial, createNeonTetraState } from '../../src/neon-tetra.js';
import { SPECIES } from '../../src/species.js';
import glb from '../../assets/p2-src/neon-tetra.glb';

const SIZE = 400;
const COLS = 6;
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
  renderer.setScissorTest(true);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x7f8f8b);
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.add(new THREE.HemisphereLight(0xe1f5f2, 0x726b4b, 1.2));
  const sun = new THREE.DirectionalLight(0xffffff, 1.25);
  sun.position.set(-0.4, 0.7, 0.5);
  scene.add(sun);
  const loader = new GLTFLoader();
  const buffer = glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength);
  const gltf = await new Promise((resolve, reject) => loader.parse(buffer, '', resolve, reject));
  const rig = bakeNeonTetraAttributes(gltf.scene);
  const state = createNeonTetraState(0);
  gltf.scene.traverse(node => {
    if (!node.isMesh) return;
    node.material = neonTetraMaterial(node.material, state, rig);
    node.frustumCulled = false;
  });
  const species = SPECIES.neonTetra;
  const { outer } = normalize(gltf.scene, species.targetLength, species.facing);
  scene.add(outer);
  const d = 0.078;
  const cameras = [
    new THREE.PerspectiveCamera(32, 1, 0.001, 10),
    new THREE.PerspectiveCamera(32, 1, 0.001, 10),
    new THREE.PerspectiveCamera(32, 1, 0.001, 10),
  ];
  cameras[0].position.set(0, 0.002, d); cameras[0].lookAt(0, 0, 0);
  cameras[1].position.set(d * 0.30, d * 0.16, d * 0.95); cameras[1].lookAt(0, 0, 0);
  cameras[2].position.set(0, d, 0.0001); cameras[2].up.set(0, 0, 1); cameras[2].lookAt(0, 0, 0);
  for (let row = 0; row < ROWS; row++) for (let col = 0; col < COLS; col++) {
    const t = (col / COLS) * Math.PI * 2;
    state.time.value = t;
    state.row.value = t * 1.4;
    renderer.setViewport(col * SIZE, (ROWS - 1 - row) * SIZE, SIZE, SIZE);
    renderer.setScissor(col * SIZE, (ROWS - 1 - row) * SIZE, SIZE, SIZE);
    renderer.render(scene, cameras[row]);
  }
  window.__neonTetra = { phases: COLS, views: ['side', 'three-quarter', 'top'] };
  window.__ready = true;
}
main().catch(error => { console.error(error); window.__error = String(error); });

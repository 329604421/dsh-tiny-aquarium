import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { normalize } from '../../src/fish.js';
import { bakeNeonTetraAttributes } from '../../src/neon-tetra.js';
import { REGION } from '../../src/clownfish.js';
import { SPECIES } from '../../src/species.js';
import glb from '../../assets/p2-src/neon-tetra.glb';

const SIZE = 460;
async function main() {
  const canvas = document.createElement('canvas');
  canvas.width = SIZE * 4;
  canvas.height = SIZE;
  document.body.append(canvas);
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setSize(canvas.width, canvas.height, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.setScissorTest(true);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x2a3230);
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.add(new THREE.HemisphereLight(0xe1f5f2, 0x726b4b, 1.2));
  const sun = new THREE.DirectionalLight(0xffffff, 1.25);
  sun.position.set(-0.4, 0.7, 0.5);
  scene.add(sun);
  const loader = new GLTFLoader();
  const buffer = glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength);
  const gltf = await new Promise((resolve, reject) => loader.parse(buffer, '', resolve, reject));
  bakeNeonTetraAttributes(gltf.scene);
  const palette = {
    [REGION.BODY]: new THREE.Color(0x2c3a35),
    [REGION.DORSAL]: new THREE.Color(0xff4b45),
    [REGION.ANAL]: new THREE.Color(0xffa51f),
    [REGION.CAUDAL]: new THREE.Color(0x49e05e),
    [REGION.PECTORAL]: new THREE.Color(0x3ca9ff),
    [REGION.PELVIC]: new THREE.Color(0xff4de0),
  };
  const counts = {};
  gltf.scene.traverse(node => {
    if (!node.isMesh) return;
    const regions = node.geometry.attributes.aRegion?.array;
    if (!regions) return;
    const colors = new Float32Array(regions.length * 3);
    for (let i = 0; i < regions.length; i++) {
      counts[regions[i]] = (counts[regions[i]] || 0) + 1;
      const color = palette[regions[i]] || palette[REGION.BODY];
      colors[i * 3] = color.r; colors[i * 3 + 1] = color.g; colors[i * 3 + 2] = color.b;
    }
    node.geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    node.material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.62, metalness: 0, side: THREE.DoubleSide });
    node.frustumCulled = false;
  });
  const species = SPECIES.neonTetra;
  const { outer } = normalize(gltf.scene, species.targetLength, species.facing);
  scene.add(outer);
  const d = 0.081;
  const views = [
    { pos: [0, 0, d], up: [0, 1, 0] },
    { pos: [0, 0, -d], up: [0, 1, 0] },
    { pos: [d * 0.65, d * 0.25, d * 0.76], up: [0, 1, 0] },
    { pos: [0, d, 0.0001], up: [0, 0, 1] },
  ];
  views.forEach((view, col) => {
    const camera = new THREE.PerspectiveCamera(30, 1, 0.001, 10);
    camera.position.set(...view.pos); camera.up.set(...view.up); camera.lookAt(0, 0, 0);
    renderer.setViewport(col * SIZE, 0, SIZE, SIZE);
    renderer.setScissor(col * SIZE, 0, SIZE, SIZE);
    renderer.render(scene, camera);
  });
  window.__neonTetra = { regionCounts: counts };
  window.__ready = true;
}
main().catch(error => { console.error(error); window.__error = String(error); });

import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { normalize } from '../../src/fish.js';
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
  renderer.toneMappingExposure = 1.04;
  renderer.setScissorTest(true);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x879792);
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.add(new THREE.HemisphereLight(0xe1f5f2, 0x726b4b, 1.2));
  const sun = new THREE.DirectionalLight(0xffffff, 1.25);
  sun.position.set(-0.4, 0.7, 0.5);
  scene.add(sun);
  const loader = new GLTFLoader();
  const buffer = glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength);
  const gltf = await new Promise((resolve, reject) => loader.parse(buffer, '', resolve, reject));
  const raw = new THREE.Box3().setFromObject(gltf.scene);
  const rawSize = raw.getSize(new THREE.Vector3());
  const { outer } = normalize(gltf.scene, 0.04, -1);
  scene.add(outer);
  outer.updateMatrixWorld(true);
  const fitted = new THREE.Box3().setFromObject(outer);
  const d = 0.085;
  const views = [
    { pos: [0, 0.002, d], up: [0, 1, 0] },
    { pos: [-d, 0.002, 0], up: [0, 1, 0] },
    { pos: [0, d, 0.0001], up: [0, 0, 1] },
    { pos: [d * 0.62, d * 0.20, d * 0.78], up: [0, 1, 0] },
  ];
  views.forEach((view, col) => {
    const camera = new THREE.PerspectiveCamera(30, 1, 0.001, 10);
    camera.position.set(...view.pos);
    camera.up.set(...view.up);
    camera.lookAt(0, 0, 0);
    renderer.setViewport(col * SIZE, 0, SIZE, SIZE);
    renderer.setScissor(col * SIZE, 0, SIZE, SIZE);
    renderer.render(scene, camera);
  });
  window.__neonTetra = {
    rawSize: rawSize.toArray(), rawMin: raw.min.toArray(), rawMax: raw.max.toArray(),
    fittedSize: fitted.getSize(new THREE.Vector3()).toArray(),
    meshes: gltf.scene.children.map(node => node.name),
  };
  window.__ready = true;
}
main().catch(error => { console.error(error); window.__error = String(error); });

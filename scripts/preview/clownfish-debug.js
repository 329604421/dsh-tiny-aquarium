import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { bakeSwimAttributes, REGION } from '../../src/clownfish.js';
import glb from '../../assets/p2-src/clownfish-ocellaris.glb';

// 鳍位/分区调试：按 aRegion 给顶点着色，直接看单网格资产有没有把身体误判成鳍。
const SIZE = 460;
const COLS = 4;
const ROWS = 1;

async function main() {
  const canvas = document.createElement('canvas');
  canvas.width = SIZE * COLS;
  canvas.height = SIZE * ROWS;
  document.body.append(canvas);
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setSize(SIZE * COLS, SIZE * ROWS, false);
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

  bakeSwimAttributes(gltf.scene);
  const palette = {
    [REGION.BODY]: new THREE.Color(0x2c3a35),
    [REGION.DORSAL]: new THREE.Color(0xff4b45),
    [REGION.ANAL]: new THREE.Color(0xffa51f),
    [REGION.CAUDAL]: new THREE.Color(0x49e05e),
    [REGION.PECTORAL]: new THREE.Color(0x3ca9ff),
    [REGION.PELVIC]: new THREE.Color(0xff4de0),
    [REGION.EYE]: new THREE.Color(0xffffff),
  };
  gltf.scene.traverse(node => {
    if (!node.isMesh) return;
    const regions = node.geometry.attributes.aRegion?.array;
    if (!regions) return;
    const colors = new Float32Array(regions.length * 3);
    for (let i = 0; i < regions.length; i++) {
      const color = palette[regions[i]] || palette[REGION.BODY];
      colors[i * 3] = color.r;
      colors[i * 3 + 1] = color.g;
      colors[i * 3 + 2] = color.b;
    }
    node.geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    node.material = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.62,
      metalness: 0,
      side: THREE.DoubleSide,
    });
    node.frustumCulled = false;
  });

  const box = new THREE.Box3().setFromObject(gltf.scene);
  const scale = 0.062 / Math.max(...box.getSize(new THREE.Vector3()).toArray());
  gltf.scene.scale.setScalar(scale);
  gltf.scene.updateMatrixWorld(true);
  const fitted = new THREE.Box3().setFromObject(gltf.scene);
  gltf.scene.position.sub(fitted.getCenter(new THREE.Vector3()));
  scene.add(gltf.scene);

  const d = 0.062 * 2.0;
  const cameras = [
    { pos: [0, 0, d], up: [0, 1, 0] },
    { pos: [0, 0, -d], up: [0, 1, 0] },
    { pos: [d * 0.7, d * 0.3, d * 0.7], up: [0, 1, 0] },
    { pos: [0, d, 0.0001], up: [0, 0, 1] },
  ];
  for (let col = 0; col < COLS; col++) {
    const camera = new THREE.PerspectiveCamera(30, 1, 0.001, 10);
    camera.position.set(...cameras[col].pos);
    camera.up.set(...cameras[col].up);
    camera.lookAt(0, 0, 0);
    renderer.setViewport(col * SIZE, 0, SIZE, SIZE);
    renderer.setScissor(col * SIZE, 0, SIZE, SIZE);
    renderer.render(scene, camera);
  }
  window.__ready = true;
}

main().catch(error => { console.error(error); window.__error = String(error); });

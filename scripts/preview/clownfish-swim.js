import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { bakeSwimAttributes, clownfishMaterial, createSwimState, classifyMesh } from '../../src/clownfish.js';
import glb from '../../assets/p2-src/clownfish-ocellaris.glb';

// 泳姿胶片：一个完整尾拍周期内的 6 个相位，侧视 + 3/4。
// 用来看脊柱行进波、尾鳍滞后、胸鳍划水是否连成一条动作，而不是各转各的。
const SIZE = 400;
const COLS = 6;
const ROWS = 3;

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

  const state = createSwimState(0);
  state.amp.value = 0.9;
  state.rowAmp.value = 0.85;
  bakeSwimAttributes(gltf.scene);
  gltf.scene.traverse(node => {
    if (!node.isMesh) return;
    node.material = clownfishMaterial(node.material, classifyMesh(node), state, {
      densePhotoMesh: node.userData.densePhotoMesh,
    });
    node.frustumCulled = false;
  });
  const box = new THREE.Box3().setFromObject(gltf.scene);
  const size = box.getSize(new THREE.Vector3());
  gltf.scene.scale.setScalar(0.062 / Math.max(size.x, size.y, size.z));
  gltf.scene.updateMatrixWorld(true);
  gltf.scene.position.sub(new THREE.Box3().setFromObject(gltf.scene).getCenter(new THREE.Vector3()));
  scene.add(gltf.scene);

  const d = 0.062 * 1.9;
  const cameras = [
    new THREE.PerspectiveCamera(32, 1, 0.001, 10),
    new THREE.PerspectiveCamera(32, 1, 0.001, 10),
    new THREE.PerspectiveCamera(32, 1, 0.001, 10),
  ];
  cameras[0].position.set(0, 0.002, d);
  cameras[0].lookAt(0, 0, 0);
  cameras[1].position.set(d * 0.35, d * 0.18, d * 0.92);
  cameras[1].lookAt(0, 0, 0);
  cameras[2].position.set(0, d, 0.0001);
  cameras[2].up.set(0, 0, 1);
  cameras[2].lookAt(0, 0, 0);

  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      const t = (col / COLS) * Math.PI * 2;
      state.time.value = t;
      state.row.value = t * 1.4;
      renderer.setViewport(col * SIZE, (ROWS - 1 - row) * SIZE, SIZE, SIZE);
      renderer.setScissor(col * SIZE, (ROWS - 1 - row) * SIZE, SIZE, SIZE);
      renderer.render(scene, cameras[row]);
    }
  }
  window.__ready = true;
}

main().catch(error => { console.error(error); window.__error = String(error); });

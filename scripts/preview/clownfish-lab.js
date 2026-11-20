import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { bakeSwimAttributes, clownfishMaterial, createSwimState, classifyMesh } from '../../src/clownfish.js';
import glb from '../../assets/p2-src/clownfish-ocellaris.glb';

// 小丑鱼资产调试台
// 第 0 行：四个角度
// 第 1 行：四个泳姿相位（看脊柱弯曲、鳍是否跟上）
// 第 2 行：胸鳍 / 头部 / 尾柄 / 鳞片四个近景
const SIZE = 420;
const COLS = 4;
const ROWS = 3;

async function main() {
  const canvas = document.createElement('canvas');
  canvas.width = SIZE * COLS;
  canvas.height = SIZE * ROWS;
  canvas.style.width = `${SIZE * COLS}px`;
  document.body.append(canvas);
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setSize(SIZE * COLS, SIZE * ROWS, false);
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

  const state = createSwimState(0.4);
  state.amp.value = 0.85;
  state.rowAmp.value = 0.95;
  bakeSwimAttributes(gltf.scene);
  const info = { meshes: [], tris: 0 };
  gltf.scene.traverse(node => {
    if (!node.isMesh) return;
    const region = classifyMesh(node);
    node.material = clownfishMaterial(node.material, region, state, {
      densePhotoMesh: node.userData.densePhotoMesh,
    });
    node.castShadow = true;
    node.frustumCulled = false;
    const geometry = node.geometry;
    const tris = geometry.index ? geometry.index.count / 3 : geometry.attributes.position.count / 3;
    info.tris += tris;
    const regionCounts = {};
    const regions = geometry.attributes.aRegion?.array;
    if (regions) {
      for (const value of regions) regionCounts[value] = (regionCounts[value] || 0) + 1;
    }
    info.meshes.push({ name: node.name, tris, region, regionCounts });
  });

  const box = new THREE.Box3().setFromObject(gltf.scene);
  const size = box.getSize(new THREE.Vector3());
  gltf.scene.scale.setScalar(0.062 / Math.max(size.x, size.y, size.z));
  gltf.scene.updateMatrixWorld(true);
  const fitted = new THREE.Box3().setFromObject(gltf.scene);
  gltf.scene.position.sub(fitted.getCenter(new THREE.Vector3()));
  scene.add(gltf.scene);

  const scale = 0.062 / Math.max(size.x, size.y, size.z);
  const d = 0.062 * 2.05;
  gltf.scene.updateMatrixWorld(true);
  const worldPoint = (x, y, z) => new THREE.Vector3(x, y, z).applyMatrix4(gltf.scene.matrixWorld);
  const views = [
    { pos: [0, 0.004, d], up: [0, 1, 0], fov: 30 },
    { pos: [d * 0.72, d * 0.22, d * 0.72], up: [0, 1, 0], fov: 30 },
    { pos: [0, d * 0.95, 0.0001], up: [0, 0, 1], fov: 30 },
    { pos: [-d, 0, 0], up: [0, 1, 0], fov: 30 },
  ];
  const swim = { pos: [d * 0.18, d * 0.10, d * 0.96], up: [0, 1, 0], fov: 30 };
  const closeups = [
    { target: worldPoint(0.212, 0.000, 0.050), offset: [0.018, 0.008, 0.030], fov: 20 },
    { target: worldPoint(0.060, 0.008, 0.020), offset: [0.008, 0.014, 0.026], fov: 20 },
    { target: worldPoint(0.790, 0.000, 0.000), offset: [0.020, 0.006, 0.026], fov: 20 },
    { target: worldPoint(0.430, 0.000, 0.070), offset: [0.014, 0.006, 0.024], fov: 18 },
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
  state.row.value = 0.0;
  for (let col = 0; col < COLS; col++) renderCell(col, 0, views[col]);

  for (let col = 0; col < COLS; col++) {
    const t = col * Math.PI * 0.5;
    state.time.value = t;
    state.row.value = t * 0.9;
    renderCell(col, 1, { ...swim, fov: 26 });
  }

  state.time.value = 0.4;
  state.row.value = 0.0;
  for (let col = 0; col < COLS; col++) {
    const view = closeups[col];
    const pos = view.target.clone().add(new THREE.Vector3(...view.offset));
    renderCell(col, 2, { pos: [pos.x, pos.y, pos.z], target: [view.target.x, view.target.y, view.target.z], fov: view.fov });
  }

  window.__clownfish = info;
  window.__ready = true;
}

main().catch(error => { console.error(error); window.__error = String(error); });

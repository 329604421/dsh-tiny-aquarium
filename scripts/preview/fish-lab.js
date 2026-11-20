// 鱼皮调色台：把同一条鱼按缸内光照条件渲染三视图，专门用来判断
// "背腹渐变够不够、鳞片看不看得见、有没有过曝"。眼睛判断的活，放大才准。
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { normalize } from '../../src/fish.js';
import { bakeNeonTetraAttributes, createNeonTetraState, neonTetraMaterial } from '../../src/neon-tetra.js';
import { SPECIES } from '../../src/species.js';
import glb from '../../assets/p2-src/neon-tetra.glb';

const SIZE = 420;
const views = 3;

async function main() {
  const canvas = document.createElement('canvas');
  canvas.width = SIZE * views;
  canvas.height = SIZE;
  document.body.append(canvas);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setSize(SIZE * views, SIZE, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.08;
  renderer.setScissorTest(true);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x8f9c98);
  // 缸内有一张 RoomEnvironment 生成的 PMREM，调试台必须同样给环境光，
  // 否则金属度与鳞片高光的判断会偏离真实画面
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.add(new THREE.HemisphereLight(0xe1f5f2, 0x726b4b, 1.2));
  const sun = new THREE.DirectionalLight(0xffffff, 1.25);
  sun.position.set(-0.4, 0.7, 0.5);
  scene.add(sun);
  // 只复刻缸内实际存在的光：灯罩聚光 + 半球光 + 平行光 + PMREM。
  // 多加一盏会让"过曝"变成调试台专属现象，判断就跑偏。
  const spot = new THREE.SpotLight(0xffe8be, 0.44, 1.3, Math.PI / 3.3, 0.7, 2);
  spot.position.set(0.035, 0.351, 0.018);
  spot.target.position.set(0, 0.05, 0);
  scene.add(spot, spot.target);

  const loader = new GLTFLoader();
  const buffer = glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength);
  const gltf = await new Promise((resolve, reject) => loader.parse(buffer, '', resolve, reject));

  const species = SPECIES.neonTetra;
  const rig = bakeNeonTetraAttributes(gltf.scene);
  const state = createNeonTetraState(0.3);
  const { outer } = normalize(gltf.scene, species.targetLength, species.facing);

  gltf.scene.traverse(n => {
    if (!n.isMesh) return;
    n.material = neonTetraMaterial(n.material, state, rig);
    n.frustumCulled = false;
  });
  scene.add(outer);

  const d = species.targetLength * 1.75;
  const cameras = [
    new THREE.PerspectiveCamera(33, 1, 0.001, 10),  // 正侧
    new THREE.PerspectiveCamera(33, 1, 0.001, 10),  // 斜上
    new THREE.PerspectiveCamera(33, 1, 0.001, 10),  // 正前（看头朝向）
  ];
  cameras[0].position.set(0, 0, d); cameras[0].lookAt(0, 0, 0);
  cameras[1].position.set(d * 0.62, d * 0.52, d * 0.62); cameras[1].lookAt(0, 0, 0);
  cameras[2].position.set(d, d * 0.12, 0); cameras[2].lookAt(0, 0, 0);

  for (let i = 0; i < views; i++) {
    renderer.setViewport(i * SIZE, 0, SIZE, SIZE);
    renderer.setScissor(i * SIZE, 0, SIZE, SIZE);
    renderer.render(scene, cameras[i]);
  }
  window.__ready = true;
}

main().catch(e => { console.error(e); window.__error = String(e); });

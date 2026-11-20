import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { SPACE, LIMITS, ZOOM, clamp, clampZoom, FixedClock, Gesture, Simulation } from './core.js';
import manifest from '../presets.json';
import neonTetraGlb from '../assets/p2-src/neon-tetra.glb';
import clownfishGlb from '../assets/p2-src/clownfish-ocellaris.glb';
import { CUSTOM_BUNDLES } from './custom-bundle.generated.js';
import {
  createCatalog, customSpeciesOf, lampParamsOf, scapeLayoutOf,
} from './custom-catalog.js';
import { School } from './fish.js';
import { SPECIES } from './species.js';
import { createScape } from './scape.js';
import { FeedingDirector, applyFeedingPreset } from './feeding.js';
import { applyStartlePreset } from './startle.js';
import { FEED_CURSOR, FEED_CURSOR_WATER } from './feed-cursor.js';

export { SPACE, LIMITS };

const catalog = createCatalog(manifest.presets);
const customLoader = new GLTFLoader();

/** 色温 → sRGB，用于把定制灯具的 2700–6500K 真正落到聚光灯上。 */
function kelvinColor(kelvin) {
  const temp = clamp(Number(kelvin) || 4200, 1000, 40000) / 100;
  const curve = (() => {
    if (temp <= 66) {
      return [
        255,
        99.4708025861 * Math.log(temp) - 161.1195681661,
        temp <= 19 ? 0 : 138.5177312231 * Math.log(temp - 10) - 305.0447927307,
      ];
    }
    return [
      329.698727446 * ((temp - 60) ** -0.1332047592),
      288.1221695283 * ((temp - 60) ** -0.0755148492),
      255,
    ];
  })();
  const [r, g, b] = curve.map(value => Math.max(0, Math.min(255, Math.round(value))));
  return (r << 16) | (g << 8) | b;
}

/** 定制资产在构建期内联成 Uint8Array；没打包时返回 null，由调用方回退。 */
function customBytes(id) {
  const bytes = CUSTOM_BUNDLES[id];
  return bytes instanceof Uint8Array ? bytes : null;
}

function parseCustom(id) {
  const bytes = customBytes(id);
  if (!bytes) return Promise.reject(new Error(`custom asset not bundled: ${id}`));
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return new Promise((resolve, reject) => {
    customLoader.parse(buffer, '', gltf => resolve(gltf.scene), reject);
  });
}

/** GLB 自带的材质不再改动，只统一阴影与剔除策略。 */
function prepareCustom(root) {
  root.traverse(node => {
    if (!node.isMesh) return;
    node.castShadow = true;
    node.receiveShadow = true;
    node.frustumCulled = false;
  });
  return root;
}

/** 定制对象是运行时创建的，必须自己释放，否则反复切换会涨显存。 */
function disposeCustom(root) {
  root.traverse(node => {
    if (!node.isMesh) return;
    node.geometry?.dispose?.();
    const materials = Array.isArray(node.material) ? node.material : [node.material];
    for (const material of materials) {
      if (!material) continue;
      for (const value of Object.values(material)) if (value?.isTexture) value.dispose?.();
      material.dispose?.();
    }
  });
}

/** Fine color and height variation keep the substrate from reading as white plastic. */
function createSandMaps() {
  const size = 256;
  const colors = new Uint8Array(size * size * 4);
  const heights = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = (y * size + x) * 4;
    const n = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
    const grain = n - Math.floor(n);
    const mottle = Math.sin(x * 0.047 + Math.sin(y * 0.031) * 2.1)
      * Math.cos(y * 0.043 - Math.sin(x * 0.029));
    const shade = clamp(0.86 + mottle * 0.09 + (grain - 0.5) * 0.2, 0.62, 1);
    colors[i] = 174 * shade;
    colors[i + 1] = 156 * shade;
    colors[i + 2] = 121 * shade;
    colors[i + 3] = 255;
    const height = clamp(128 + (grain - 0.5) * 100 + mottle * 16, 0, 255);
    heights[i] = heights[i + 1] = heights[i + 2] = height;
    heights[i + 3] = 255;
  }
  const map = new THREE.DataTexture(colors, size, size);
  map.colorSpace = THREE.SRGBColorSpace;
  const bumpMap = new THREE.DataTexture(heights, size, size);
  for (const texture of [map, bumpMap]) {
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(3, 2);
    texture.magFilter = THREE.LinearFilter;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.generateMipmaps = true;
    texture.needsUpdate = true;
  }
  return { map, bumpMap };
}

class Resources {
  items = new Set();
  own(item) { this.items.add(item); return item; }
  dispose() {
    for (const item of this.items) item.dispose();
    this.items.clear();
  }
}

export function createScene(container, options = {}) {
  const resources = new Resources();
  let renderer;
  let cleanup = () => resources.dispose();
  try {
    renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'high-performance' });
    cleanup = () => { resources.dispose(); renderer.dispose(); renderer.forceContextLoss(); renderer.domElement.remove(); };
    return setup(container, options, renderer, resources);
  } catch (error) {
    cleanup();
    throw error;
  }
}

function setup(container, options, renderer, resources) {
  const own = item => resources.own(item);
  // P5：缸体/灯具/造景/鱼群都可能来自定制清单；解析不到就回退同类内置资产。
  const tankChoice = catalog.resolvePresetId(options.tankPresetId, 'tank');
  const lampChoice = catalog.resolvePresetId(options.lampPresetId, 'lamp');
  const scapeChoice = catalog.resolvePresetId(options.scapePresetId, 'scape');
  const customTank = tankChoice.preset?.origin === 'custom' ? tankChoice.preset : null;
  const customLamp = lampChoice.preset?.origin === 'custom' ? lampChoice.preset : null;
  const customScape = scapeChoice.preset?.origin === 'custom' ? scapeChoice.preset : null;
  const customFish = catalog.sanitizeCustomIds(options.customFishIds, 'fish')
    .map(id => catalog.getPreset(id)).filter(Boolean);
  const customRoots = [];
  // 投喂习惯是模块级「当前预设」：进场景时套用一次，切预设时由 setFeedingPreset 就地更新。
  const feedingChoice = catalog.feedingParamsOf(options.feedingPresetId);
  applyFeedingPreset(feedingChoice.params);
  applyStartlePreset(feedingChoice.params);
  const scene = new THREE.Scene();
  const tank = new THREE.Group();
  scene.add(tank);
  const sim = new Simulation();
  const feedingDirector = new FeedingDirector(sim);
  const clock = new FixedClock();
  const gesture = new Gesture();
  const camera = new THREE.PerspectiveCamera(33, 1, 0.01, 10);
  const canvas = renderer.domElement;
  canvas.dataset.aquariumCanvas = '';
  canvas.setAttribute('aria-label', options.canvasLabel || 'Interactive aquarium');
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  container.append(canvas);

  let disposed = false;
  let raf = 0;
  let lost = false;
  let restoreTimer;
  let feeding = false;
  let dark = !!options.dark;
  let lightTarget = options.lightOn ?? dark;
  let light = lightTarget ? 1 : 0;
  let quality = options.quality || 'auto';
  let degraded = false;
  let intersecting = true;
  let lastRender = 0;
  let sampleStart = 0;
  let sampleFrames = 0;
  let fps = 60;
  let lowWindows = 0;
  let renders = 0;
  let width = 1;
  let height = 1;
  let focusY = 0.15;
  let fitDistance = 1;
  let zoom = 1;
  let lastFeedPoint = null;
  let feedRippleAt = -10;
  const listeners = [];
  const listen = (target, name, listener, opts) => {
    target.addEventListener(name, listener, opts);
    const remove = () => target.removeEventListener(name, listener, opts);
    listeners.push(remove);
    own({ dispose: remove });
  };
  const eco = () => quality === 'eco' || degraded;
  const hitObjects = [];
  const blockers = [];
  const geometries = {
    box: own(new THREE.BoxGeometry(1, 1, 1)),
    cylinder: own(new THREE.CylinderGeometry(1, 1, 1, 24)),
    sphere: own(new THREE.SphereGeometry(1, 10, 8)),
  };
  function mesh(geometry, material, position, scale, hitKind) {
    const m = new THREE.Mesh(geometry, material);
    m.position.set(...position);
    if (scale) m.scale.set(...scale);
    m.castShadow = false;
    m.receiveShadow = true;
    if (hitKind) { m.userData.kind = hitKind; hitObjects.push(m); }
    tank.add(m);
    return m;
  }
  const pbr = params => own(new THREE.MeshStandardMaterial(params));
  const edgeMat = pbr({ color: 0xd5e5e1, roughness: 0.09, metalness: 0.08, transparent: true, opacity: 0.36 });
  const glassMat = own(new THREE.MeshPhysicalMaterial({
    color: 0xedf7f4, roughness: 0.035, metalness: 0, transparent: true,
    opacity: 0.055, depthWrite: false, side: THREE.DoubleSide, envMapIntensity: 0.72,
    clearcoat: 0.75, clearcoatRoughness: 0.045, ior: 1.5, specularIntensity: 0.85,
  }));
  glassMat.onBeforeCompile = shader => {
    shader.fragmentShader = shader.fragmentShader.replace('#include <opaque_fragment>', `
      float edgeFresnel = pow(1.0 - abs(dot(normalize(normal), normalize(vViewPosition))), 3.0);
      diffuseColor.a = clamp(diffuseColor.a + edgeFresnel * 0.29, 0.0, 0.34);
      outgoingLight += vec3(0.12, 0.18, 0.17) * edgeFresnel;
      #include <opaque_fragment>`);
  };
  // Real glass thickness, open top, and all simulation coordinates in meters.
  // 定制缸体只替换外观：四片玻璃保留为不可见的命中面（隐藏的网格不参与射线），
  // 边框、角柱与底座才是可以整体藏起来的装饰件。
  const shellDecor = [];
  const glassPanels = [];
  const glassHitOnly = own(new THREE.MeshBasicMaterial({
    colorWrite: false, depthWrite: false, transparent: true, opacity: 0, side: THREE.DoubleSide,
  }));
  for (const z of [-0.125, 0.125]) glassPanels.push(mesh(geometries.box, glassMat, [0, 0.15, z], [0.4, 0.3, 0.003], 'glass'));
  for (const x of [-0.2, 0.2]) glassPanels.push(mesh(geometries.box, glassMat, [x, 0.15, 0], [0.003, 0.3, 0.25], 'glass'));
  shellDecor.push(mesh(geometries.box, glassMat, [0, 0.003, 0], [0.4, 0.006, 0.25], 'body'));
  for (const y of [0.004, 0.299]) {
    for (const z of [-0.125, 0.125]) shellDecor.push(mesh(geometries.box, edgeMat, [0, y, z], [0.403, 0.002, 0.003]));
    for (const x of [-0.2, 0.2]) shellDecor.push(mesh(geometries.box, edgeMat, [x, y, 0], [0.003, 0.002, 0.25]));
  }
  for (const x of [-0.2, 0.2]) for (const z of [-0.125, 0.125]) {
    shellDecor.push(mesh(geometries.box, edgeMat, [x, 0.15, z], [0.0014, 0.3, 0.0014]));
  }

  const pmrem = new THREE.PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  try {
    const environment = own(pmrem.fromScene(room, 0.025));
    scene.environment = environment.texture;
  } finally { room.dispose(); pmrem.dispose(); }

  const normalSize = 128;
  const normalData = new Uint8Array(normalSize * normalSize * 4);
  for (let y = 0; y < normalSize; y++) for (let x = 0; x < normalSize; x++) {
    const i = (y * normalSize + x) * 4;
    normalData[i] = 128 + 24 * Math.sin(x * Math.PI / 16 + Math.sin(y * Math.PI / 32));
    normalData[i + 1] = 128 + 24 * Math.cos(y * Math.PI / 16 + Math.sin(x * Math.PI / 32));
    normalData[i + 2] = 250;
    normalData[i + 3] = 255;
  }
  const normalMap = own(new THREE.DataTexture(normalData, normalSize, normalSize));
  normalMap.wrapS = normalMap.wrapT = THREE.RepeatWrapping;
  normalMap.magFilter = normalMap.minFilter = THREE.LinearFilter;
  normalMap.needsUpdate = true;
  const waterGeo = own(new THREE.PlaneGeometry(0.396, 0.246, 48, 32));
  waterGeo.rotateX(-Math.PI / 2);
  const waterMat = own(new THREE.MeshPhysicalMaterial({
    color: 0xa9d2ca, metalness: 0, roughness: 0.055, transparent: true, opacity: 0.16,
    depthWrite: false, side: THREE.DoubleSide, normalMap, normalScale: new THREE.Vector2(0.12, 0.12),
    envMapIntensity: 1.05, clearcoat: 1, clearcoatRoughness: 0.035, ior: 1.333, specularIntensity: 1,
  }));
  // Water itself stays clear face-on; only grazing reflections gain density.
  waterMat.onBeforeCompile = shader => {
    shader.fragmentShader = shader.fragmentShader.replace('#include <opaque_fragment>', `
      float waterFresnel = pow(1.0 - abs(dot(normalize(normal), normalize(vViewPosition))), 2.4);
      diffuseColor.a = clamp(diffuseColor.a + waterFresnel * 0.4, 0.0, 0.56);
      #include <opaque_fragment>`);
  };
  const water = mesh(waterGeo, waterMat, [0, SPACE.waterY, 0]);
  water.renderOrder = 1;
  // Keep only the deforming surface: fixed meniscus rails expose the old waterline while rotating.
  // The interaction surface remains flat; visual waves are bounded below the rim.
  const hitMat = own(new THREE.MeshBasicMaterial({ visible: true, colorWrite: false, depthWrite: false, side: THREE.FrontSide }));
  const hitGeo = own(new THREE.PlaneGeometry(SPACE.maxX * 2, SPACE.maxZ * 2));
  hitGeo.rotateX(-Math.PI / 2);
  mesh(hitGeo, hitMat, [0, SPACE.waterY + 0.002, 0], null, 'water');
  const volumeMat = own(new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, side: THREE.BackSide,
    uniforms: { uDark: { value: dark ? 1 : 0 } },
    vertexShader: 'varying vec3 vLocal; void main(){vLocal=position;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
    fragmentShader: 'varying vec3 vLocal; uniform float uDark; void main(){float depth=pow(clamp(1.-(vLocal.y+.5),0.,1.),.8);vec3 tint=mix(vec3(.36,.61,.56),vec3(.08,.24,.22),uDark);gl_FragColor=vec4(tint,.012+depth*.043);}',
  }));
  mesh(geometries.box, volumeMat, [0, SPACE.waterY / 2, 0], [0.394, SPACE.waterY, 0.244]);

  const sandMaps = createSandMaps();
  own(sandMaps.map); own(sandMaps.bumpMap);
  const anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  sandMaps.map.anisotropy = sandMaps.bumpMap.anisotropy = anisotropy;
  const sandMat = pbr({
    color: 0xffffff, map: sandMaps.map, bumpMap: sandMaps.bumpMap, bumpScale: 0.0011, roughness: 0.94,
  });
  const sand = mesh(geometries.box, sandMat, [0, 0.008, 0], [0.39, 0.013, 0.24], 'body');
  sand.receiveShadow = true;
  const sandTopGeo = own(new THREE.PlaneGeometry(0.389, 0.239, 56, 36));
  sandTopGeo.rotateX(-Math.PI / 2);
  const sandPositions = sandTopGeo.attributes.position;
  for (let i = 0; i < sandPositions.count; i++) {
    const x = sandPositions.getX(i), z = sandPositions.getZ(i);
    const height = Math.sin(x * 91 + Math.cos(z * 47)) * Math.cos(z * 83 - x * 19) * 0.00042
      + Math.sin(x * 37 + z * 53) * 0.0002;
    sandPositions.setY(i, height);
  }
  sandTopGeo.computeVertexNormals();
  mesh(sandTopGeo, sandMat, [0, 0.0153, 0]);
  const grainGeo = own(new THREE.IcosahedronGeometry(1, 0));
  const grains = new THREE.InstancedMesh(grainGeo, sandMat, 520);
  const dummy = new THREE.Object3D();
  const color = new THREE.Color();
  // Deterministic procedural assets: no network images or environment maps.
  let seed = 17;
  const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  for (let i = 0; i < 520; i++) {
    const sx = 0.0012 + random() * 0.0021;
    const sy = 0.0007 + random() * 0.0012;
    dummy.position.set((random() - 0.5) * 0.38, 0.0155 + sy * 0.55, (random() - 0.5) * 0.23);
    dummy.scale.set(sx, sy, sx * (0.75 + random() * 0.45));
    dummy.rotation.set(random() * Math.PI, random() * Math.PI, random() * Math.PI);
    dummy.updateMatrix();
    grains.setMatrixAt(i, dummy.matrix);
    grains.setColorAt(i, color.setHSL(0.095 + random() * 0.025, 0.08 + random() * 0.14, 0.28 + random() * 0.25));
  }
  grains.receiveShadow = true;
  tank.add(grains);
  own(grains);
  const pebbleMat = pbr({ color: 0xffffff, roughness: 0.88, metalness: 0.02 });
  const pebbles = new THREE.InstancedMesh(own(new THREE.DodecahedronGeometry(1, 0)), pebbleMat, 18);
  for (let i = 0; i < 18; i++) {
    const size = 0.0028 + random() * 0.0045;
    const cluster = i < 11;
    dummy.position.set(cluster ? -0.145 + (random() - 0.5) * 0.065 : (random() - 0.5) * 0.34,
      0.016 + size * 0.36, cluster ? -0.068 + (random() - 0.5) * 0.055 : (random() - 0.5) * 0.19);
    dummy.scale.set(size, size * (0.45 + random() * 0.25), size * (0.75 + random() * 0.4));
    dummy.rotation.set(random() * 2, random() * Math.PI, random());
    dummy.updateMatrix();
    pebbles.setMatrixAt(i, dummy.matrix);
    const tone = 0.13 + random() * 0.18;
    pebbles.setColorAt(i, color.setRGB(tone * 1.05, tone, tone * 0.88));
  }
  pebbles.castShadow = true;
  pebbles.receiveShadow = true;
  tank.add(pebbles);
  own(pebbles);
  const baseMat = pbr({ color: 0x29312e, roughness: 0.58, metalness: 0.28 });
  // 底座同样负责「空白处的拖动/关闭」判定，所以定制缸体时只换材质、不隐藏。
  glassPanels.push(mesh(own(new RoundedBoxGeometry(0.409, 0.008, 0.259, 2, 0.0015)), baseMat, [0, -0.003, 0], null, 'body'));
  const shadowCanvas = document.createElement('canvas');
  shadowCanvas.width = shadowCanvas.height = 256;
  const shadowContext = shadowCanvas.getContext('2d');
  const shadowGradient = shadowContext.createRadialGradient(128, 128, 32, 128, 128, 126);
  shadowGradient.addColorStop(0, 'rgba(0,0,0,0.72)');
  shadowGradient.addColorStop(0.62, 'rgba(0,0,0,0.38)');
  shadowGradient.addColorStop(1, 'rgba(0,0,0,0)');
  shadowContext.fillStyle = shadowGradient;
  shadowContext.fillRect(0, 0, 256, 256);
  const shadowMap = own(new THREE.CanvasTexture(shadowCanvas));
  const contactShadow = mesh(own(new THREE.PlaneGeometry(0.57, 0.37)), own(new THREE.MeshBasicMaterial({
    map: shadowMap, transparent: true, opacity: dark ? 0.2 : 0.34, depthWrite: false,
  })), [0, -0.0072, 0]);
  contactShadow.rotation.x = -Math.PI / 2;

  // Low-contrast moving caustics tie the light, water and substrate together.
  const causticMat = own(new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { uTime: { value: 0 }, uStrength: { value: 0.25 } },
    vertexShader: 'varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
    fragmentShader: `varying vec2 vUv;uniform float uTime;uniform float uStrength;
      void main(){
        vec2 p=(vUv-.5)*vec2(9.,6.);float t=uTime*.32;
        float a=sin(p.x*1.35+sin(p.y*1.1+t)*1.4+t);
        float b=sin(p.y*1.6+sin(p.x*1.25-t*.8)*1.2-t*.7);
        float c=pow(clamp(1.-abs(a+b)*.62,0.,1.),6.);
        float edge=smoothstep(0.,.08,vUv.x)*smoothstep(0.,.08,1.-vUv.x)*smoothstep(0.,.1,vUv.y)*smoothstep(0.,.1,1.-vUv.y);
        gl_FragColor=vec4(1.,.91,.7,c*edge*.075*uStrength);
      }`,
  }));
  const caustics = mesh(own(new THREE.PlaneGeometry(0.386, 0.236)), causticMat, [0, 0.0175, 0]);
  caustics.rotation.x = -Math.PI / 2;

  /**
   * 定制造景：几何来自 GLB，摆放与占位来自清单。返回值与 createScape 同形，
   * 上层（气泡、碰撞、快照、省电）不需要知道它是内置还是定制。
   */
  function createCustomScape(preset) {
    const layout = scapeLayoutOf(preset);
    const group = new THREE.Group();
    group.name = preset.id;
    tank.add(group);
    const motion = { uPlantTime: { value: 0 }, uPlantStrength: { value: 1 } };
    const stats = {
      id: preset.id, instances: layout.instances.length, rocks: 0, woodBranches: 0,
      plantClusters: layout.instances.length, leaves: 0, mossInstances: 0, pebbleInstances: 0,
      plantTriangles: 0,
    };
    parseCustom(preset.id)
      .then(root => {
        if (disposed) { disposeCustom(root); return; }
        prepareCustom(root);
        customRoots.push(root);
        if (!layout.instances.length) {
          group.add(root);
        } else {
          layout.instances.forEach((instance, index) => {
            const node = index === 0 ? root : root.clone(true);
            node.position.set(...instance.position);
            node.rotation.y = instance.rotY;
            node.scale.setScalar(instance.scale);
            group.add(node);
          });
        }
        options.onCustomAsset?.({ id: preset.id, category: 'scape', instances: Math.max(1, layout.instances.length) });
      })
      .catch(error => options.onCustomError?.({
        id: preset.id, category: 'scape', message: String(error?.message ?? error),
      }));

    return {
      id: preset.id,
      group,
      airStone: { x: layout.airStone[0], y: layout.airStone[1], z: layout.airStone[2] },
      collision: layout.collision,
      motion,
      stats,
      update(time, eco = false) {
        motion.uPlantTime.value = eco ? Math.floor(time * 15) / 15 : time;
        motion.uPlantStrength.value = eco ? 0.58 : layout.sway;
      },
      setQuality() {},
    };
  }

  // P3: one complete procedural scape, with runtime collision data for P4.
  // P5: 定制造景走同一条数据通道——几何来自被打包的 GLB，占位体与摆放出清单。
  const scape = customScape
    ? createCustomScape(customScape)
    : createScape(tank, scapeChoice.id, { own, bumpMap: sandMaps.bumpMap });

  const lampMat = pbr({ color: 0x414b43, roughness: 0.34, metalness: 0.75 });
  const lampStem = mesh(geometries.cylinder, lampMat, [0.15, 0.184, -0.146], [0.003, 0.368, 0.003], 'lamp');
  const lampArm = mesh(geometries.box, lampMat, [0.15, 0.366, -0.065], [0.006, 0.006, 0.17], 'lamp');
  const lampTop = mesh(own(new RoundedBoxGeometry(0.242, 0.009, 0.036, 3, 0.002)), lampMat, [0.035, 0.366, 0.018], null, 'lamp');
  const bulbMat = pbr({ color: 0xfff4d2, emissive: 0xffe5b0, emissiveIntensity: 2, roughness: 0.3 });
  const bulb = mesh(geometries.box, bulbMat, [0.035, 0.36, 0.018], [0.227, 0.002, 0.028], 'lamp');
  blockers.push(lampStem, lampArm, lampTop, bulb);
  const spot = new THREE.SpotLight(0xffe8be, 0.6, 1.3, Math.PI / 3.3, 0.7, 2);
  spot.position.set(0.035, 0.351, 0.018);
  spot.target.position.set(0, 0.05, 0);
  spot.castShadow = true;
  spot.shadow.mapSize.set(1024, 1024);
  spot.shadow.camera.near = 0.02;
  spot.shadow.camera.far = 1;
  spot.shadow.bias = -0.00015;
  tank.add(spot, spot.target);
  const hemi = new THREE.HemisphereLight(0xe1f5f2, 0x726b4b, 1.2);
  const sun = new THREE.DirectionalLight(0xffffff, 1.25);
  sun.position.set(-0.4, 0.7, 0.5);
  scene.add(hemi, sun);
  const beamMat = own(new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    uniforms: { strength: { value: 0 } },
    vertexShader: 'varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
    fragmentShader: `varying vec2 vUv;uniform float strength;void main(){
      float sideFade=pow(max(0.,sin(fract(vUv.x*4.)*3.14159265)),2.);
      float endFade=smoothstep(0.,.18,vUv.y)*(1.-smoothstep(.82,1.,vUv.y));
      gl_FragColor=vec4(1.,.86,.56,sideFade*endFade*.04*strength);
    }`,
  }));
  // A strip lamp casts a rectangular, softly feathered field rather than a spotlight cone.
  const beamGeo = own(new THREE.CylinderGeometry(1, 1.8, 1, 4, 1, true));
  beamGeo.rotateY(Math.PI / 4);
  const beam = mesh(beamGeo, beamMat, [0.035, 0.201, 0.018], [0.16, 0.31, 0.024]);

  /*
   * 定制灯具：灯体换成资产，照明接线仍由引擎负责。灯管类节点（Bulb / Tube / Glow）
   * 换成自发光材质，随 light 一起亮；可见光域沿用内置几何，长条灯换成吊灯时直接隐藏，
   * 避免出现与灯体不符的圆锥。
   */
  let lampGain = 1;
  const customGlow = [];
  if (customLamp) {
    const params = lampParamsOf(customLamp);
    lampGain = params.intensity;
    parseCustom(customLamp.id)
      .then(root => {
        if (disposed) { disposeCustom(root); return; }
        prepareCustom(root);
        tank.add(root);
        customRoots.push(root);
        for (const item of [lampStem, lampArm, lampTop, bulb]) item.visible = false;
        beam.visible = false;
        spot.color.setHex(kelvinColor(params.color));
        spot.angle = params.angle;
        spot.penumbra = params.penumbra;
        spot.target.position.set(...params.target);
        root.traverse(node => {
          if (!node.isMesh || !/bulb|tube|glow|lamp_?light/i.test(node.name)) return;
          node.material = own(new THREE.MeshStandardMaterial({
            color: 0xfff6e2, emissive: 0xffe8be, emissiveIntensity: 1, roughness: 0.35, metalness: 0,
          }));
          customGlow.push(node.material);
        });
        options.onCustomAsset?.({ id: customLamp.id, category: 'lamp', colorTemp: params.color });
      })
      .catch(error => options.onCustomError?.({
        id: customLamp.id, category: 'lamp', message: String(error?.message ?? error),
      }));
  }

  /* 定制缸体：只替换外壳。四片玻璃与底座换成不可见材质，保住敲击与拖动判定。 */
  if (customTank) {
    parseCustom(customTank.id)
      .then(root => {
        if (disposed) { disposeCustom(root); return; }
        prepareCustom(root);
        tank.add(root);
        customRoots.push(root);
        for (const panel of glassPanels) panel.material = glassHitOnly;
        for (const decor of shellDecor) decor.visible = false;
        options.onCustomAsset?.({ id: customTank.id, category: 'tank' });
      })
      .catch(error => options.onCustomError?.({
        id: customTank.id, category: 'tank', message: String(error?.message ?? error),
      }));
  }

  const bubbleMat = own(new THREE.MeshPhysicalMaterial({
    color: 0xc5f1ed, metalness: 0.12, roughness: 0.08, transparent: true, opacity: 0.28,
    depthWrite: false, clearcoat: 1,
  }));
  const bubbles = new THREE.InstancedMesh(geometries.sphere, bubbleMat, 42);
  bubbles.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  tank.add(bubbles);
  own(bubbles);
  const airStoneMat = pbr({ color: 0x4b5048, roughness: 0.96, metalness: 0, bumpMap: sandMaps.bumpMap, bumpScale: 0.0007 });
  const airStone = mesh(geometries.cylinder, airStoneMat,
    [scape.airStone.x, scape.airStone.y, scape.airStone.z], [0.013, 0.01, 0.013]);
  const foodGeo = own(new THREE.IcosahedronGeometry(1, 0));
  const foodAlpha = new THREE.InstancedBufferAttribute(new Float32Array(LIMITS.food).fill(1), 1);
  foodGeo.setAttribute('instanceOpacity', foodAlpha);
  const foodMat = pbr({ color: 0xb57435, roughness: 0.86, transparent: true });
  foodMat.onBeforeCompile = shader => {
    shader.vertexShader = 'attribute float instanceOpacity; varying float vOpacity;\n' + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvOpacity=instanceOpacity;');
    shader.fragmentShader = 'varying float vOpacity;\n' + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.a *= vOpacity;');
  };
  const food = new THREE.InstancedMesh(foodGeo, foodMat, LIMITS.food);
  food.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  food.count = 0;
  food.castShadow = true;
  food.frustumCulled = false;
  tank.add(food);
  own(food);
  const ringGeo = own(new THREE.RingGeometry(0.82, 1, 64));
  const rings = Array.from({ length: 4 }, () => {
    const material = own(new THREE.MeshBasicMaterial({
      color: 0xfff3d9, transparent: true, opacity: 0, depthWrite: false,
      side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
    }));
    const ring = mesh(ringGeo, material, [0, 0, 0]);
    ring.renderOrder = 5;
    return ring;
  });
  const feedRing = mesh(ringGeo, own(new THREE.MeshBasicMaterial({ color: 0xf1dbac, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide })), [0, SPACE.waterY + 0.004, 0]);
  feedRing.rotation.x = -Math.PI / 2;

  // P2：鱼群。各物种独立异步加载，单种失败不拖累其他鱼或 P1 缸体。
  const schools = [
    { school: new School(tank, SPECIES.neonTetra, { collision: scape.collision }), source: neonTetraGlb, ready: false },
    { school: new School(tank, SPECIES.clownfish, { seed: 2.35, collision: scape.collision, feedingIndexOffset: SPECIES.neonTetra.count }), source: clownfishGlb, ready: false },
  ];
  // P5：定制鱼种追加在两种内置鱼之后；喂食索引要接着排，否则会互相抢同一个槽位。
  let fishOffset = SPECIES.neonTetra.count + SPECIES.clownfish.count;
  customFish.forEach((preset, index) => {
    const bytes = customBytes(preset.id);
    if (!bytes) {
      options.onCustomError?.({ id: preset.id, category: 'fish', message: 'not bundled' });
      return;
    }
    const species = customSpeciesOf(preset);
    schools.push({
      school: new School(tank, species, {
        seed: 3.1 + index * 0.73, collision: scape.collision, feedingIndexOffset: fishOffset,
      }),
      source: bytes, ready: false, custom: preset.id,
    });
    fishOffset += species.count;
  });
  let fishReady = false;
  for (const entry of schools) {
    entry.school.load(entry.source)
      .then(() => {
        if (disposed) { entry.school.dispose(); return; }
        entry.ready = true;
        fishReady = true;
        // 预编译鱼皮/泳姿着色器，避免首帧编译卡顿被算进帧率采样。
        renderer.compile(scene, camera);
        sampleStart = 0;
        sampleFrames = 0;
        options.onFish?.(schools.reduce((sum, item) => sum + (item.ready ? item.school.fish.length : 0), 0));
      })
      .catch(error => {
        console.warn(`[aquarium] ${entry.school.species.id} load failed:`, error);
        options.onFishError?.(String(error?.message ?? error));
      });
  }

  const raycaster = new THREE.Raycaster();
  const mouse = new THREE.Vector2();
  const normal = new THREE.Vector3();
  const forward = new THREE.Vector3(0, 0, 1);
  const quaternion = new THREE.Quaternion();
  function pick(x, y) {
    const rect = canvas.getBoundingClientRect();
    mouse.set(((x - rect.left) / rect.width) * 2 - 1, -((y - rect.top) / rect.height) * 2 + 1);
    tank.updateMatrixWorld(true);
    raycaster.setFromCamera(mouse, camera);
    const hits = raycaster.intersectObjects(hitObjects, false);
    // In feeding mode the real water-plane hit wins over the front glass hit;
    // both still come from the same raycast, never screen-coordinate guessing.
    const hit = feeding ? (hits.find(item => item.object.userData.kind === 'water') || hits[0]) : hits[0];
    if (!hit) return { kind: 'blank' };
    const local = tank.worldToLocal(hit.point.clone());
    const localNormal = hit.face.normal.clone().transformDirection(hit.object.matrix);
    return { kind: hit.object.userData.kind, point: local, normal: localNormal };
  }
  function cursorForHit(hit) {
    if (feeding) return hit?.kind === 'water' ? FEED_CURSOR_WATER : FEED_CURSOR;
    return hit?.kind === 'glass' ? 'pointer' : ['water', 'body'].includes(hit?.kind) ? 'grab' : 'default';
  }
  function cancelPointer() {
    const id = gesture.current?.id;
    gesture.cancel();
    if (id !== undefined && canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id);
    canvas.style.cursor = feeding ? FEED_CURSOR : 'default';
  }
  listen(canvas, 'pointerdown', event => {
    if (event.button !== 0 || gesture.current || lost) return;
    const hit = pick(event.clientX, event.clientY);
    event.preventDefault();
    gesture.begin(event.pointerId, event.clientX, event.clientY, hit.kind);
    canvas.style.cursor = cursorForHit(hit);
    canvas.setPointerCapture(event.pointerId);
  });
  listen(canvas, 'pointermove', event => {
    if (gesture.current) {
      const dx = gesture.move(event.pointerId, event.clientX, event.clientY);
      if (dx) { sim.rotate(dx * 0.009); canvas.style.cursor = 'grabbing'; }
    } else {
      const hit = pick(event.clientX, event.clientY);
      canvas.style.cursor = cursorForHit(hit);
    }
  });
  listen(canvas, 'pointerup', event => {
    if (event.button !== 0 || gesture.current?.id !== event.pointerId) return;
    const hit = pick(event.clientX, event.clientY);
    const action = gesture.end(event.pointerId, event.clientX, event.clientY, hit.kind, feeding);
    cancelPointer();
    canvas.style.cursor = cursorForHit(hit);
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    if (action === 'close') options.onClose?.();
    if (action === 'tap' && sim.tap(hit.point, hit.normal, performance.now())) options.onTap?.();
    if (action === 'feed') {
      // 库存以「勺」计：一次点击只舀一勺，落进水里的是 LIMITS.batch 粒。
      // 一勺 = 一撮，视觉上是几粒；用户点一次不该把整罐倒空。
      const scoops = options.takeFood?.(1) ?? 1;
      if (!(scoops > 0)) { options.onFeed?.('empty', 0); return; }
      const result = sim.feed(hit.point, performance.now(), LIMITS.batch * scoops);
      if (result === 'added') { lastFeedPoint = hit.point.clone(); feedRippleAt = sim.time; }
      options.onFeed?.(result, scoops);
    }
  });
  listen(canvas, 'pointercancel', cancelPointer);
  listen(canvas, 'lostpointercapture', cancelPointer);
  listen(window, 'blur', cancelPointer);
  listen(canvas, 'pointerleave', () => { if (!gesture.current) canvas.style.cursor = feeding ? FEED_CURSOR : 'default'; });

  function applyQuality() {
    renderer.setPixelRatio(eco() ? 1 : Math.min(window.devicePixelRatio || 1, 1.75));
    renderer.shadowMap.enabled = !eco();
    bubbles.count = eco() ? 20 : 42;
    grains.count = eco() ? 240 : 520;
    pebbles.count = eco() ? 10 : 18;
    scape.setQuality(eco());
    resize();
  }
  function resize() {
    if (disposed) return;
    width = Math.max(1, container.clientWidth);
    height = Math.max(1, container.clientHeight);
    renderer.setSize(width, height);
    camera.aspect = width / height;
    // Frame the whole composition with margin: the tank, its lamp and the
    // floor shadow must stay inside a panel card instead of touching the edges.
    const vertical = THREE.MathUtils.degToRad(camera.fov / 2);
    fitDistance = Math.max(0.66 / (2 * Math.tan(vertical) * camera.aspect), 0.66 / (2 * Math.tan(vertical)));
    frameCamera();
    camera.updateProjectionMatrix();
  }
  /** The fitted distance is the minimum size; zoom dollies the camera in. */
  function frameCamera() {
    const distance = fitDistance / zoom;
    camera.position.set(0, focusY + distance * 0.28, distance * 0.96);
    camera.lookAt(0, focusY, 0);
    camera.updateMatrixWorld();
  }
  function setZoom(next) {
    const value = clampZoom(next);
    if (value === zoom) return value;
    zoom = value;
    frameCamera();
    options.onZoom?.(zoom);
    return zoom;
  }
  function animateMaterials() {
    light += ((lightTarget ? 1 : 0) - light) * 0.13;
    spot.intensity = light * 0.44 * lampGain;
    bulbMat.emissiveIntensity = 0.08 + light * 2.6;
    for (const material of customGlow) material.emissiveIntensity = 0.08 + light * 2.6;
    beamMat.uniforms.strength.value = light * (dark ? 0.85 : 0.28);
    hemi.intensity = dark ? 0.38 : 1.2;
    sun.intensity = dark ? 0.12 : 1.25;
    renderer.toneMappingExposure = (dark ? 0.78 : 1) + light * (dark ? 0.14 : 0.08);
    volumeMat.uniforms.uDark.value = dark ? 1 : 0;
    contactShadow.material.opacity = dark ? 0.2 : 0.34;
    causticMat.uniforms.uTime.value = eco() ? Math.floor(sim.time * 15) / 15 : sim.time;
    causticMat.uniforms.uStrength.value = ((dark ? 0.12 : 0.22) + light * (dark ? 0.85 : 0.48)) * (eco() ? 0.65 : 1);
    normalMap.offset.set(sim.time * 0.006, sim.time * 0.003);
    scape.update(sim.time, eco());
    const rippleAge = sim.time - feedRippleAt;
    const attr = waterGeo.attributes.position;
    for (let i = 0; i < attr.count; i++) {
      const x = attr.getX(i), z = attr.getZ(i);
      const micro = Math.sin(x * 70 + sim.time * 1.3) * Math.cos(z * 55 - sim.time) * (eco() ? 0.00018 : 0.00035);
      let ripple = 0;
      if (lastFeedPoint && rippleAge >= 0 && rippleAge < 1.4) {
        const distance = Math.hypot(x - lastFeedPoint.x, z - lastFeedPoint.z);
        ripple = Math.sin(distance * 260 - rippleAge * 17) * Math.exp(-rippleAge * 2.6 - distance * 9) * 0.0018;
      }
      const crossWave = sim.waveCross * 0.45 * Math.cos(z * 24 - x * 7 - sim.time * 1.7);
      attr.setY(i, micro + ripple + crossWave + sim.wave * Math.sin(x * 18 + z * 8 + sim.time * 2.2));
    }
    attr.needsUpdate = true;
    waterGeo.computeVertexNormals();
    tank.rotation.y = sim.yaw;
    for (let i = 0; i < bubbles.count; i++) {
      const phase = (sim.time * 0.11 + i / bubbles.count) % 1;
      const rise = Math.pow(phase, 1.18);
      dummy.position.set(scape.airStone.x + Math.sin(sim.time * 1.4 + i * 3) * (0.002 + 0.005 * phase),
        scape.airStone.y + 0.006 + rise * (SPACE.waterY - scape.airStone.y - 0.011),
        scape.airStone.z + Math.cos(i + sim.time * 0.85) * (0.0015 + phase * 0.003));
      const radius = (0.00065 + (i % 5) * 0.00028) * (0.85 + phase * 0.35);
      dummy.scale.setScalar(radius * Math.min(1, phase * 20, (1 - phase) * 12));
      dummy.updateMatrix();
      bubbles.setMatrixAt(i, dummy.matrix);
    }
    bubbles.instanceMatrix.needsUpdate = true;
    food.count = sim.food.length;
    for (let i = 0; i < sim.food.length; i++) {
      const p = sim.food[i];
      dummy.position.set(p.x, p.y, p.z);
      dummy.scale.set(p.radius, p.radius * 0.8, p.radius);
      dummy.rotation.set(p.phase + sim.time * 0.1, p.phase, 0);
      dummy.updateMatrix();
      food.setMatrixAt(i, dummy.matrix);
      foodAlpha.setX(i, p.alpha);
    }
    food.instanceMatrix.needsUpdate = true;
    foodAlpha.needsUpdate = true;
    rings.forEach((ring, i) => {
      const tap = sim.taps[i];
      ring.visible = !!tap;
      if (!tap) return;
      const age = sim.time - tap.time;
      ring.position.copy(tap.point);
      normal.copy(tap.normal).normalize();
      ring.position.addScaledVector(normal, 0.002);
      ring.quaternion.copy(quaternion.setFromUnitVectors(forward, normal));
      ring.scale.setScalar(0.012 + age * 0.15);
      ring.material.opacity = Math.max(0, 1 - age / 0.7) ** 1.4;
    });
    feedRing.visible = rippleAge < 0.9 && !!lastFeedPoint;
    if (feedRing.visible) {
      feedRing.position.set(lastFeedPoint.x, SPACE.waterY + 0.004, lastFeedPoint.z);
      feedRing.scale.setScalar(0.003 + rippleAge * 0.023);
      feedRing.material.opacity = (1 - rippleAge / 0.9) * 0.45;
    }
  }
  function frame(now) {
    raf = 0;
    if (disposed || lost || document.hidden || !intersecting) return;
    clock.tick(now, dt => {
      sim.update(dt);
      if (fishReady) for (const entry of schools) if (entry.ready) entry.school.update(dt, feedingDirector, sim.taps);
    });
    if (!eco() || now - lastRender >= 1000 / 30 - 1) {
      animateMaterials();
      renderer.render(scene, camera);
      lastRender = now;
      renders++;
      sampleFrames++;
    }
    if (!sampleStart) sampleStart = now;
    if (now - sampleStart >= 2000) {
      fps = sampleFrames * 1000 / (now - sampleStart);
      if (quality === 'auto' && !degraded && fps < 28) lowWindows++; else lowWindows = 0;
      if (lowWindows >= 2) { degraded = true; applyQuality(); options.onQuality?.(); }
      options.onStats?.({ fps: Math.round(fps), food: sim.food.length, eco: eco() });
      sampleFrames = 0;
      sampleStart = now;
    }
    raf = requestAnimationFrame(frame);
  }
  function pause() {
    cancelAnimationFrame(raf); raf = 0; clock.reset(); sampleStart = 0; sampleFrames = 0;
    cancelPointer();
  }
  function resume() {
    if (!disposed && !lost && !document.hidden && intersecting && !raf) {
      clock.reset();
      raf = requestAnimationFrame(frame);
    }
  }
  listen(document, 'visibilitychange', () => document.hidden ? pause() : resume());
  listen(canvas, 'webglcontextlost', event => {
    event.preventDefault();
    lost = true;
    pause();
    options.onContext?.('lost');
    restoreTimer = setTimeout(() => options.onContext?.('timeout'), 5000);
  });
  listen(canvas, 'webglcontextrestored', () => {
    clearTimeout(restoreTimer);
    // Rebuild procedural PMREM and every GPU allocation after a lost context.
    options.onContext?.('restored');
  });
  const resizeObserver = new ResizeObserver(resize);
  own({ dispose: () => resizeObserver.disconnect() });
  resizeObserver.observe(container);
  const intersectionObserver = new IntersectionObserver(entries => {
    intersecting = entries[0]?.isIntersecting ?? true;
    if (intersecting) resume(); else pause();
  });
  own({ dispose: () => intersectionObserver.disconnect() });
  intersectionObserver.observe(container);
  applyQuality();
  animateMaterials();
  renderer.render(scene, camera);
  resume();
  const api = {
    setFeeding(value) { feeding = value; cancelPointer(); },
    /**
     * 切换投喂习惯：只改行为权重，不重建场景。返回值带上被回退的参数名，
     * 便于界面如实说明「哪几项越界了」。
     */
    setFeedingPreset(params) {
      const feedingState = applyFeedingPreset(params);
      applyStartlePreset(params);
      return feedingState;
    },
    setLighting(isDark, on) { dark = isDark; lightTarget = on; },
    setQuality(value) { quality = value; degraded = false; lowWindows = 0; applyQuality(); },
    setZoom: value => setZoom(value),
    zoomBy: delta => setZoom(zoom * Math.exp(delta)),
    getZoom: () => zoom,
    onTap: listener => sim.onTap(listener),
    getFood: () => sim.food.map(p => ({ ...p })),
    consumeFood: id => feedingDirector.consume(id),
    getCollision: () => scape.collision.map(volume => ({ ...volume })),
    /**
     * Drop one automatic batch at a random spot on the surface. The caller owns
     * the token budget; the scene only reports whether the water accepted it.
     */
    feedAuto(count) {
      const x = SPACE.minX + Math.random() * (SPACE.maxX - SPACE.minX);
      const z = SPACE.minZ + Math.random() * (SPACE.maxZ - SPACE.minZ);
      const result = sim.dropFood({ x, z }, count);
      if (result === 'added') { lastFeedPoint = new THREE.Vector3(x, SPACE.waterY, z); feedRippleAt = sim.time; }
      return result;
    },
    snapshot: () => ({
      yaw: sim.yaw, wave: sim.wave, waveCross: sim.waveCross, time: sim.time, food: sim.food.map(p => ({ ...p })),
      taps: sim.taps.map(t => ({ ...t })), fps, renders, running: !!raf, light, quality, degraded, zoom,
      memory: { ...renderer.info.memory }, calls: renderer.info.render.calls,
      units: 'meters', presetCount: manifest.presets.length,
      custom: {
        tank: customTank?.id ?? null, lamp: customLamp?.id ?? null, scape: customScape?.id ?? null,
        fish: customFish.map(preset => preset.id), roots: customRoots.length,
      },
      scape: {
        id: scape.id, ...scape.stats,
        swayTime: scape.motion.uPlantTime.value, swayStrength: scape.motion.uPlantStrength.value,
      },
      collision: scape.collision.map(volume => ({ ...volume })),
      fish: schools.reduce((sum, entry) => sum + (entry.ready ? entry.school.fish.length : 0), 0),
      fishState: schools.flatMap(entry => entry.ready
        ? entry.school.fish.map(f => {
          const fwd = new THREE.Vector3(1, 0, 0).applyQuaternion(f.root.quaternion);
          return {
            species: entry.school.species.id, x: f.root.position.x, y: f.root.position.y, z: f.root.position.z,
            yaw: f.root.rotation.y, rx: f.root.rotation.x, rz: f.root.rotation.z,
            fx: fwd.x, fy: fwd.y, fz: fwd.z,
            behavior: f.startle?.active ? f.startle.state : f.feeding?.state ?? 'cruise',
            feeding: f.feeding?.state ?? 'cruise', reaction: f.startle?.state ?? 'calm',
            reactionTarget: f.startle?.target ? { ...f.startle.target } : null,
            reactionIntensity: f.startle?.intensity ?? 0, startles: f.startle?.events ?? 0,
            targetFoodId: f.feeding?.targetFoodId ?? null,
            foodDistance: Number.isFinite(f.feeding?.foodDistance) ? f.feeding.foodDistance : null,
            eaten: f.feeding?.eaten ?? 0,
            pilot: f.pilot ? { yaw: f.pilot.yaw, pitch: f.pilot.pitch, roll: f.pilot.roll, speed: f.pilot.speed, state: f.pilot.stateName } : null,
          };
        })
        : []),
    }),
    project(point) {
      tank.updateMatrixWorld(true);
      const v = tank.localToWorld(new THREE.Vector3(point.x, point.y, point.z)).project(camera);
      const rect = canvas.getBoundingClientRect();
      return { x: rect.left + (v.x + 1) * rect.width / 2, y: rect.top + (1 - v.y) * rect.height / 2 };
    },
    pick,
    dispose() {
      if (disposed) return;
      disposed = true;
      pause();
      clearTimeout(restoreTimer);
      resizeObserver.disconnect();
      intersectionObserver.disconnect();
      listeners.forEach(dispose => dispose());
      for (const entry of schools) entry.school.dispose();
      for (const root of customRoots) disposeCustom(root);
      customRoots.length = 0;
      feedingDirector.dispose();
      sim.dispose();
      spot.shadow.map?.dispose();
      scene.environment = null;
      resources.dispose();
      scene.clear();
      renderer.renderLists.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      canvas.remove();
    },
  };
  return api;
}


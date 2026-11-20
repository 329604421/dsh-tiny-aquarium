import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import {
  bakeSwimAttributes, clownfishMaterial, createSwimState,
  classifyMesh, ClownfishPilot, clownfishHomes,
} from './clownfish.js';
import {
  bakeNeonTetraAttributes, neonTetraMaterial, createNeonTetraState,
} from './neon-tetra.js';
import { constrainToScape } from './scape-data.js';
import { FeedingBehavior } from './feeding.js';
import { StartleBehavior } from './startle.js';

/**
 * 入缸管线：GLB -> 重标定 -> 程序化鱼皮 -> 群游行为。
 *
 * 三条设计约束（来自 docs/P2-入缸标准.md）：
 * 1. 单位不可信。Quaternius 带 100× 节点缩放、Google Poly 把厘米当米写，
 *    所以尺寸一律用"渲染后的实测包围盒"反推，不读任何资产元数据。
 * 2. 有动画的两条资产没有 UV，所以表面细节只能在物体空间做三平面投影，
 *    不能走贴图。
 * 3. 蒙皮网格必须用 SkeletonUtils.clone，普通 clone 会让整群鱼共用一套骨骼。
 */

const loader = new GLTFLoader();

/**
 * 身体的包围盒（排除鳍）。
 *
 * 体轴参数化必须只按"身体"归一化：群游鱼的背鳍可能把包围盒顶高近一倍，
 * 混进来以后鱼身永远只占 0~0.68，深色压不到背脊上，整条鱼就洗白了。
 */
export function bodyBounds(root) {
  const box = new THREE.Box3();
  root.updateMatrixWorld(true);
  root.traverse(node => {
    if (!node.isMesh || !node.geometry) return;
    if (/fin|eye/i.test(node.material?.name || '')) return;
    node.geometry.computeBoundingBox();
    box.union(node.geometry.boundingBox);
  });
  return { min: box.min.clone(), size: box.getSize(new THREE.Vector3()) };
}

/** 只量 bind pose。骨骼节点的位移会把包围盒撑出几倍，蒙皮变形不该进尺寸测量。 */
function measure(root, space = 'world', frame = null) {
  const box = new THREE.Box3();
  root.updateMatrixWorld(true);
  // frame 给定时量的是相对该节点的局部空间，避免缸体旋转污染测量结果
  const inverse = space === 'world' && frame
    ? new THREE.Matrix4().copy(frame.matrixWorld).invert() : null;
  root.traverse(node => {
    if (!node.isMesh || !node.geometry) return;
    node.geometry.computeBoundingBox();
    const b = node.geometry.boundingBox.clone();
    // world：带上节点变换（含 100× 缩放），用于反推真实渲染尺寸
    // local：只用几何自身坐标，用于着色器里的体轴参数化
    if (space === 'world') {
      b.applyMatrix4(inverse
        ? new THREE.Matrix4().multiplyMatrices(inverse, node.matrixWorld)
        : node.matrixWorld);
    }
    box.union(b);
  });
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  return { box, size, center };
}

/**
 * 把归一化体坐标烘成顶点属性 aBody（0..1）。
 *
 * 为什么不用 uniform 传包围盒：内置材质上新增的自定义 uniform 在部分渲染路径下
 * 不会被上传，实测 vBody 恒为 1、整条鱼洗白。绑进 attribute 后随几何走，
 * 蒙皮克隆也自动共享，最可靠。
 */
export function bakeBodyCoords(root, bounds) {
  root.traverse(node => {
    if (!node.isMesh || !node.geometry) return;
    const pos = node.geometry.attributes.position;
    const arr = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      arr[i * 3] = (pos.getX(i) - bounds.min.x) / (bounds.size.x || 1e-6);
      arr[i * 3 + 1] = (pos.getY(i) - bounds.min.y) / (bounds.size.y || 1e-6);
      arr[i * 3 + 2] = (pos.getZ(i) - bounds.min.z) / (bounds.size.z || 1e-6);
    }
    node.geometry.setAttribute('aBody', new THREE.BufferAttribute(arr, 3));
    // 鳍片标记随顶点走，省掉一个 uniform，也避免多材质共享 program 时串味
    const isFin = /fin/i.test(node.material?.name || '');
    node.geometry.setAttribute('aRegion', new THREE.BufferAttribute(new Float32Array(pos.count).fill(isFin ? 1 : 0), 1));
  });
}

/**
 * 程序化鱼皮：四层叠加，注入到标准 PBR 材质里，保留蒙皮、阴影与色调映射。
 *
 * 为什么不用贴图：这批资产要么没 UV（两条带骨骼动画的），要么只有 32px 占位图。
 * 在物体空间做，既不受 UV 缺失限制，也不占包体积。
 *
 * 四层分别解决四个"真鱼感"来源：
 * 反荫蔽（背深腹浅）→ 掠食者从上下看会误判轮廓；鳞片 → 各向异性高光；侧线 → 物种识别；虹彩 → 鳞膜干涉。
 */
export function skinMaterial(params, bounds, region) {
  const isFin = region > 0.5;
  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: isFin ? 0.55 : (params.roughness ?? 0.34),
    metalness: params.metalness ?? 0.08,
    // 环境是整张 PMREM，强度 1 会让低模的大平滑面色块被高光糊满
    envMapIntensity: isFin ? 0.5 : (params.envIntensity ?? 0.55),
    // 鱼鳍是半透明的膜：做成实心就成纸片，透明了还得双面才不穿帮
    transparent: isFin,
    opacity: isFin ? 0.72 : 1,
    depthWrite: !isFin,
    side: isFin ? THREE.DoubleSide : THREE.FrontSide,
  });

  const uniforms = {
    uAlong: { value: params.axis.along },
    uLift: { value: params.axis.lift },
    uDorsal: { value: params.axis.dorsal },
    uBack: { value: new THREE.Color(params.back) },
    uBelly: { value: new THREE.Color(params.belly) },
    uAccent: { value: new THREE.Color(params.accent ?? params.belly) },
    uScaleGrid: { value: new THREE.Vector2(params.scaleGrid?.[0] ?? 110, params.scaleGrid?.[1] ?? 34) },
    uScaleStrength: { value: params.scaleStrength ?? 0.28 },
    uLateral: { value: params.lateral ?? 0.55 },
    uIridescence: { value: params.iridescence ?? 0.3 },
    uStripe: { value: params.stripe ?? 0 },
  };

  material.onBeforeCompile = shader => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = `
      attribute vec3 aBody; attribute float aRegion;
      varying vec3 vBody; varying float vFishRegion;
    ` + shader.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
       // aBody 是 bind pose 的体坐标：纹理随骨骼变形而弯曲，正是鱼皮该有的行为
       vBody = aBody;
       vFishRegion = aRegion;`,
    );

    shader.fragmentShader = `
      uniform int uAlong; uniform int uLift; uniform float uDorsal;
      uniform vec3 uBack; uniform vec3 uBelly; uniform vec3 uAccent;
      uniform vec2 uScaleGrid; uniform float uScaleStrength;
      uniform float uLateral; uniform float uIridescence; uniform float uStripe;
      varying vec3 vBody; varying float vFishRegion;
      float fishAxis(vec3 p, int i) { return i == 0 ? p.x : (i == 1 ? p.y : p.z); }
    ` + shader.fragmentShader
      .replace('#include <map_fragment>', `#include <map_fragment>
        vec3 fishPos = clamp(vBody, 0.0, 1.0);
        float fishAlong = fishAxis(fishPos, uAlong);
        // 0 = 腹部，1 = 背部；dorsal 为 -1 时翻转，兼容 Z-up / Y-up 两种资产
        float fishLift = uDorsal > 0.0 ? fishAxis(fishPos, uLift) : 1.0 - fishAxis(fishPos, uLift);

        // 1) 反荫蔽：深色压在上 1/3，体侧溶入银白。过渡区偏低会让整条鱼显脏
        float fishShade = smoothstep(0.26, 0.94, fishLift);
        vec3 fishBase = mix(uBelly, uBack, fishShade);

        // 2) 鳞片：沿体轴错位排列的椭圆，中心亮、边缘暗；用逐格噪声打散规则感
        vec2 fishGrid = vec2(fishAlong * uScaleGrid.x, fishLift * uScaleGrid.y);
        fishGrid.y += mod(floor(fishGrid.x), 2.0) * 0.5;
        vec2 fishC = fract(fishGrid) - 0.5;
        float fishD = length(fishC * vec2(1.0, 1.25));
        float fishPlate = 1.0 - smoothstep(0.26, 0.52, fishD);
        float fishRim = smoothstep(0.26, 0.40, fishD) * (1.0 - smoothstep(0.40, 0.52, fishD));
        float fishGrain = fract(sin(dot(floor(fishGrid), vec2(12.9898, 78.233))) * 43758.5453);
        fishBase *= 1.0 - uScaleStrength * (0.6 - fishPlate) - uScaleStrength * 1.1 * fishRim
                  - uScaleStrength * 0.18 * (fishGrain - 0.5);

        // 3) 侧线：体侧纵向亮带，识鱼最强的单一线索
        float fishDelta = (fishLift - 0.56) / 0.045;
        fishBase = mix(fishBase, uAccent, exp(-fishDelta * fishDelta) * uLateral * 0.5);

        // 4) 竖向条纹（金鱼类备用，鱼苗为 0）
        float fishBars = 0.5 + 0.5 * sin(fishAlong * 18.0);
        fishBase *= 1.0 - uStripe * 0.35 * smoothstep(0.55, 1.0, fishBars) * fishShade;

        // 5) 虹彩：掠射角偏冷，模拟鳞膜干涉
        float fishFresnel = pow(1.0 - abs(dot(normalize(vNormal), normalize(vViewPosition))), 3.0);
        fishBase = mix(fishBase, fishBase * vec3(0.82, 1.0, 1.18), fishFresnel * uIridescence);

        // 鳍片半透明，避免整条鱼读成一个实心块
        if (vFishRegion > 0.5) fishBase = mix(fishBase, uAccent * 1.1, 0.45);

        diffuseColor.rgb = fishBase * 0.42;
      `)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        // 鳞片边缘更光滑、腹部更哑，高光才有"鳞"的形状
        roughnessFactor *= 1.0 - 0.35 * fishPlate + 0.2 * (1.0 - fishShade);
      `);
  };
  material.customProgramCacheKey = () => 'fish-skin-v1';
  return material;
}

/**
 * 保留 GLB 原始贴图的细节泳姿。用于静态模型，不覆盖 artist 做好的颜色。
 *
 * 顶点变形分成三个频段：身体行波、尾鳍滞后、胸鳍独立划水。三者共用
 * aBody 物体坐标，因此模型重标定后幅度仍按原始体长比例计算。
 */
export function texturedSwimMaterial(source, species, bounds, phase = 0) {
  const material = source.clone();
  material.roughness = Math.max(0.38, source.roughness ?? 0.5);
  material.metalness = 0;
  material.envMapIntensity = 0.48;
  material.side = THREE.DoubleSide;
  const { along, lift, dorsal = 1 } = species.axis;
  const lateral = 3 - along - lift;
  const motion = species.motion ?? {};
  const uniforms = {
    uSwimTime: { value: 0 },
    uSwimPhase: { value: phase },
    uSwimAlong: { value: along },
    uSwimLift: { value: lift },
    uSwimDorsal: { value: dorsal },
    uSwimLateral: { value: lateral },
    uSwimBodyLength: { value: bounds.size[['x', 'y', 'z'][along]] || 1 },
    uSwimBodyHeight: { value: bounds.size[['x', 'y', 'z'][lift]] || 1 },
    uSwimTailAtMax: { value: (species.facing ?? 1) > 0 ? 0 : 1 },
    uSwimStrength: { value: motion.strength ?? 1 },
  };
  material.onBeforeCompile = shader => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = `
      attribute vec3 aBody;
      uniform float uSwimTime; uniform float uSwimPhase;
      uniform int uSwimAlong; uniform int uSwimLift; uniform int uSwimLateral;
      uniform float uSwimDorsal; uniform float uSwimBodyLength; uniform float uSwimBodyHeight;
      uniform float uSwimTailAtMax; uniform float uSwimStrength;
      float swimAxis(vec3 p, int i) { return i == 0 ? p.x : (i == 1 ? p.y : p.z); }
      vec3 swimMask(int i) {
        return i == 0 ? vec3(1.0, 0.0, 0.0) : (i == 1 ? vec3(0.0, 1.0, 0.0) : vec3(0.0, 0.0, 1.0));
      }
    ` + shader.vertexShader.replace('#include <begin_vertex>', `
      #include <begin_vertex>
      float swimAlong = clamp(swimAxis(aBody, uSwimAlong), 0.0, 1.0);
      float swimLift = clamp(swimAxis(aBody, uSwimLift), 0.0, 1.0);
      float swimSide = clamp(swimAxis(aBody, uSwimLateral), 0.0, 1.0);
      float swimTail = abs(uSwimTailAtMax - swimAlong);
      float swimDorsal = uSwimDorsal > 0.0 ? swimLift : 1.0 - swimLift;
      float swimT = uSwimTime * 5.4 + uSwimPhase;

      // 头部仅保留极轻微回收，振幅向尾部平滑增加；二次谐波避免正弦木偶感。
      float swimBodyWeight = smoothstep(0.12, 0.96, swimTail);
      float swimWave = sin(swimT - swimTail * 2.65)
        + 0.16 * sin(swimT * 2.0 - swimTail * 5.3 + 0.45);
      float swimBody = swimWave * swimBodyWeight * swimBodyWeight;
      transformed += swimMask(uSwimLateral) * (swimBody * uSwimBodyLength * 0.035 * uSwimStrength);

      // 尾鳍比尾部身体晚半拍，并带很小的上下弹性，不像刚性扇子。
      float swimFin = smoothstep(0.73, 0.98, swimTail);
      float swimTailLag = sin(swimT - 3.35) + 0.2 * sin(swimT * 2.0 - 5.9);
      transformed += swimMask(uSwimLateral) * (swimFin * swimTailLag * uSwimBodyLength * 0.032 * uSwimStrength);
      transformed += swimMask(uSwimLift) * (swimFin * sin(swimT * 1.5 - 1.2) * uSwimBodyHeight * 0.014);

      // 胸鳍位于鳃后、腹部略下、体侧两端；只驱动该空间窗口里的顶点。
      float swimHead = 1.0 - swimTail;
      float swimPectoralX = exp(-pow((swimHead - 0.30) / 0.115, 2.0));
      float swimPectoralY = exp(-pow((swimDorsal - 0.42) / 0.22, 2.0));
      float swimPectoralZ = smoothstep(0.63, 0.96, abs(swimSide * 2.0 - 1.0));
      float swimPectoral = swimPectoralX * swimPectoralY * swimPectoralZ;
      float swimBeat = sin(uSwimTime * 10.8 + uSwimPhase * 1.7)
        + 0.22 * sin(uSwimTime * 21.6 + 0.8);
      transformed += swimMask(uSwimLift) * (swimPectoral * swimBeat * uSwimBodyHeight * 0.042 * uSwimStrength);
      transformed += swimMask(uSwimLateral) * (swimPectoral * cos(uSwimTime * 10.8 + uSwimPhase * 1.7) * uSwimBodyLength * 0.014);
    `);
    shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', `
      #include <map_fragment>
      // 缸内光量偏高：只压橙色区域，不把白带一起染灰。
      float clownOrange = smoothstep(0.07, 0.30, diffuseColor.r - diffuseColor.g);
      diffuseColor.rgb *= mix(vec3(1.0), vec3(0.86, 0.72, 0.66), clownOrange);
    `);
  };
  material.customProgramCacheKey = () => 'clownfish-swim-v1';
  material.userData.swimUniforms = uniforms;
  return material;
}

/** 把模型摆正：最长轴 -> +X（头朝前），几何中心归原点，体长 = targetLength */
export function normalize(root, targetLength, facing) {
  const outer = new THREE.Group();
  const orient = new THREE.Group();
  orient.add(root);
  outer.add(orient);

  const world = measure(root, 'world');
  const longest = world.size.x >= world.size.y && world.size.x >= world.size.z ? 'x'
    : world.size.y >= world.size.z ? 'y' : 'z';

  // 把体长轴转到 +X。Armature 通常带 -90°X（Z-up 转 Y-up），所以这里按实测最长轴转
  if (longest === 'y') orient.rotation.z = -Math.PI / 2;
  else if (longest === 'z') orient.rotation.y = Math.PI / 2;
  // facing === -1 表示头朝体长轴负端，需要 180° 掉头
  if (facing < 0) orient.rotation.y += Math.PI;

  const scale = targetLength / (world.size[longest] || 1);
  orient.scale.setScalar(scale);

  // 重新量一次再居中：旋转与缩放之后才是最终姿态
  outer.updateMatrixWorld(true);
  const fitted = measure(outer, 'world', outer);
  orient.position.sub(fitted.center);

  return { outer, orient, length: targetLength, box: fitted };
}

/**
 * 一群鱼。行为刻意做得很轻：共享一条解析路径（几个正弦叠加），每条鱼在
 * 路径周围带固定偏移与相位，从而"看起来像一群"而不引入 boids 的全部复杂度。
 */
export class School {
  constructor(tank, species, options = {}) {
    this.tank = tank;
    this.species = species;
    this.fish = [];
    this.time = 0;
    this.ready = false;
    this.seedParts = options.seed ?? 0.37;
    this.loadCount = species.count ?? 1;
    this.collision = options.collision ?? [];
    this.feedingIndexOffset = options.feedingIndexOffset ?? 0;
    this.textures = [];
  }

  async load(source) {
    // 打包后 glb 是内联的 Uint8Array（esbuild binary loader）；开发态也接受 URL
    const gltf = await new Promise((resolve, reject) => {
      if (typeof source === 'string') {
        loader.load(source, resolve, undefined, reject);
        return;
      }
      const buffer = source instanceof Uint8Array
        ? source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength)
        : source;
      loader.parse(buffer, '', resolve, reject);
    });
    const proto = gltf.scene;
    const isClown = this.species.rig === 'clownfish';
    const isNeon = this.species.rig === 'neon-tetra';
    const bounds = bodyBounds(proto);
    const skinParams = { ...this.species.skin, axis: this.species.axis };
    let neonRig = null;
    if (isClown) {
      bakeSwimAttributes(proto);
    } else if (isNeon) {
      neonRig = bakeNeonTetraAttributes(proto);
    } else {
      bakeBodyCoords(proto, bounds);
    }
    const homes = isClown ? clownfishHomes(this.species) : [];

    for (let i = 0; i < this.loadCount; i++) {
      const phase = (i / this.loadCount) * Math.PI * 2 + this.seedParts;
      const instance = this.loadCount > 1 ? cloneSkinned(proto) : proto;
      const { outer } = normalize(instance, this.species.targetLength, this.species.facing ?? 1);

      // 普通鱼使用程序化鱼皮；带高质量贴图的素材保留原色，仅叠加顶点泳姿。
      const motionUniforms = [];
      let state = null;
      let pilot = null;
      if (isClown) {
        state = createSwimState(phase);
        instance.traverse(node => {
          if (!node.isMesh) return;
          const region = classifyMesh(node);
          node.material = clownfishMaterial(node.material, region, state, {
            densePhotoMesh: node.userData.densePhotoMesh,
          });
          node.castShadow = true;
          node.frustumCulled = false;
        });
        pilot = new ClownfishPilot(this.species, i, homes[i % homes.length], 11 + i * 37 + this.seedParts * 100);
        pilot.position.copy(homes[i % homes.length]);
        // 首帧就落到领地，避免从缸心"闪现"过去
        pilot.applyTo(outer, state);
      } else if (isNeon) {
        state = createNeonTetraState(phase);
        instance.traverse(node => {
          if (!node.isMesh) return;
          node.material = neonTetraMaterial(node.material, state, neonRig);
          node.castShadow = true;
          node.frustumCulled = false;
        });
      } else {
        instance.traverse(node => {
          if (!node.isMesh) return;
          const isFin = /fin|tail_?fin|dorsal/i.test(node.material?.name || '');
          if (this.species.textured) {
            node.material = texturedSwimMaterial(node.material, this.species, bounds, phase);
            motionUniforms.push(node.material.userData.swimUniforms);
          } else {
            node.material = skinMaterial(skinParams, { min: bounds.min.clone(), size: bounds.size.clone() }, isFin ? 1 : 0);
          }
          node.castShadow = true;
          node.frustumCulled = false; // 蒙皮/顶点后包围盒会失准，避免离屏被裁掉
        });
      }

      const mixer = new THREE.AnimationMixer(instance);
      let action = null;
      if (!isClown && !isNeon && gltf.animations.length) {
        // 优先挑巡游循环，其次取第一条
        const clip = gltf.animations.find(c => /swim|normal|idle/i.test(c.name)) || gltf.animations[0];
        action = mixer.clipAction(clip);
        action.play();
        action.time = (i / this.loadCount) * clip.duration;
      }

      this.tank.add(outer);
      this.fish.push({
        root: outer,
        mixer,
        action,
        motionUniforms,
        state,
        pilot,
        phase,
        lane: (i % 2 === 0 ? 1 : -1) * (0.012 + (i % 3) * 0.009),
        // 物种可有各自的泳层与巡航速度，仍保留个体间的小差异
        height: (this.species.heightBase ?? 0.12) + (i % 3) * (this.species.heightStep ?? 0.028),
        speed: (this.species.cruise ?? 0.9) + (i % 4) * 0.06,
        position: this.pathAt(phase).clone(),
        previous: this.pathAt(phase).clone(),
        velocity: new THREE.Vector3(),
        returnFrom: null,
        startleReturnTime: null,
        swimClock: 0,
        feeding: new FeedingBehavior(this.feedingIndexOffset + i, 101 + i * 53 + this.seedParts * 100),
        startle: new StartleBehavior(this.feedingIndexOffset + i, 307 + i * 71 + this.seedParts * 100),
        heading: 0,
      });
    }
    this.ready = true;
    return this;
  }

  /** 解析路径：绕缸心的椭圆 + 三个不同周期的正弦抬升，避免"绕圈机器人"感 */
  pathAt(t) {
    const rx = 0.118, rz = 0.062;
    const a = t * 0.17;
    return new THREE.Vector3(
      Math.cos(a) * rx * (0.92 + 0.08 * Math.sin(t * 0.31)),
      Math.sin(t * 0.43 + 1.1) * 0.030 + Math.sin(t * 1.27) * 0.008,
      Math.sin(a * 1.13) * rz * (0.9 + 0.1 * Math.cos(t * 0.27)),
    );
  }

  update(dt, director = null, taps = []) {
    if (!this.ready) return;
    if (this.species.rig === 'clownfish') {
      this.time += dt;
      const pilots = this.fish.map(f => f.pilot);
      for (let i = 0; i < this.fish.length; i++) {
        const f = this.fish[i];
        const key = `${this.species.id}:${i}`;
        const startle = f.startle.update(dt, { position: f.pilot.position, taps, space: this.species.space });
        if (startle.justTriggered) {
          f.feeding.interrupt(director, key);
          f.pilot.enter('dart');
        }
        const wasActive = f.feeding.active;
        const behavior = !startle.active && director ? f.feeding.update(dt, {
          key, position: f.pilot.position, director,
          space: this.species.space, eatRadius: 0.029, approachRadius: 0.024,
        }) : null;
        if (!startle.active && wasActive && !f.feeding.active) f.pilot.enter('hover');
        f.pilot.update(dt, this.time, pilots, behavior, startle);
        f.pilot.position.copy(constrainToScape(f.pilot.position, this.collision, 0.009));
        f.pilot.applyTo(f.root, f.state);
      }
      return;
    }
    const isNeon = this.species.rig === 'neon-tetra';
    const { minX, maxX, minZ, maxZ, floorY, waterY } = this.species.space;
    const margin = 0.026; // 约半个体长，避免鱼头探出玻璃

    for (let i = 0; i < this.fish.length; i++) {
      const f = this.fish[i];
      f.previous.copy(f.position);
      const t = this.time * f.speed + f.phase;
      const path = this.pathAt(t);
      // 个体偏移：同一群鱼里的横向分层与垂直分层
      const sway = Math.sin(this.time * 1.7 + f.phase) * 0.006;
      path.x = THREE.MathUtils.clamp(path.x + sway, minX + margin, maxX - margin);
      path.y = THREE.MathUtils.clamp(path.y + f.height, floorY + 0.022, waterY - 0.018);
      path.z = THREE.MathUtils.clamp(path.z + f.lane, minZ + margin, maxZ - margin);
      path.copy(constrainToScape(path, this.collision, 0.007));

      const key = `${this.species.id}:${i}`;
      const wasStartled = f.startle.active;
      const startle = f.startle.update(dt, { position: f.position, taps, space: this.species.space });
      if (startle.justTriggered) {
        f.feeding.interrupt(director, key);
        f.returnFrom = null;
        f.startleReturnTime = null;
      }
      if (wasStartled && !startle.active) {
        f.returnFrom = f.position.clone();
        f.startleReturnTime = 0;
      }
      const behavior = !startle.active && director ? f.feeding.update(dt, {
        key, position: f.position, director,
        space: this.species.space, eatRadius: 0.021, approachRadius: 0.014,
      }) : null;
      const returning = behavior?.state === 'scatter'
        && behavior.stateTime >= behavior.scatterDuration - 1.15;

      if (startle.active) {
        f.returnFrom = null;
        f.startleReturnTime = null;
        const desired = new THREE.Vector3();
        if (startle.target && startle.state !== 'alert') {
          desired.set(startle.target.x - f.position.x, startle.target.y - f.position.y, startle.target.z - f.position.z);
          const targetDistance = desired.length();
          if (targetDistance > 1e-6) {
            desired.divideScalar(targetDistance);
            const speed = startle.state === 'flee' ? 0.19 + startle.intensity * 0.075 : 0.055;
            const brake = THREE.MathUtils.clamp(targetDistance / 0.04, startle.state === 'flee' ? 0.45 : 0.18, 1);
            desired.multiplyScalar(speed * brake);
          }
        }
        if (startle.state === 'flee') {
          desired.x += Math.sin(this.time * 15 + f.phase) * 0.009;
          desired.z += Math.cos(this.time * 13 + f.phase) * 0.009;
        }
        for (const other of this.fish) {
          if (other === f) continue;
          const away = f.position.clone().sub(other.position);
          const d = away.length();
          if (d > 1e-5 && d < 0.055) desired.addScaledVector(away.divideScalar(d), 0.038 * (1 - d / 0.055));
        }
        const response = startle.state === 'alert' ? 11 : startle.state === 'flee' ? 10 : 3.8;
        f.velocity.lerp(desired, Math.min(1, dt * response));
        f.position.addScaledVector(f.velocity, dt);
        f.position.x = THREE.MathUtils.clamp(f.position.x, minX + margin, maxX - margin);
        f.position.y = THREE.MathUtils.clamp(f.position.y, floorY + 0.022, waterY - 0.016);
        f.position.z = THREE.MathUtils.clamp(f.position.z, minZ + margin, maxZ - margin);
        f.position.copy(constrainToScape(f.position, this.collision, 0.007));
      } else if (returning) {
        // 散开的最后一秒融回解析群游路径，避免食物吃完后位置瞬移。
        if (!f.returnFrom) f.returnFrom = f.position.clone();
        const progress = THREE.MathUtils.clamp((behavior.stateTime - (behavior.scatterDuration - 1.15)) / 1.15, 0, 1);
        const eased = progress * progress * (3 - 2 * progress);
        f.position.copy(f.returnFrom).lerp(path, eased);
        f.position.copy(constrainToScape(f.position, this.collision, 0.007));
        f.velocity.copy(f.position).sub(f.previous).divideScalar(Math.max(dt, 1e-4));
      } else if (behavior?.active) {
        f.returnFrom = null;
        f.startleReturnTime = null;
        const desired = new THREE.Vector3();
        const target = behavior.target;
        const targetDistance = target ? Math.hypot(target.x - f.position.x, target.y - f.position.y, target.z - f.position.z) : 0;
        if (target && targetDistance > 1e-6) {
          desired.set(target.x - f.position.x, target.y - f.position.y, target.z - f.position.z).normalize();
          const maxSpeed = behavior.state === 'notice' ? 0.008
            : behavior.state === 'gather' ? 0.108 + f.speed * 0.014
              : behavior.state === 'compete' ? 0.083 + f.speed * 0.009 : 0.062;
          const brake = THREE.MathUtils.clamp(targetDistance / (behavior.state === 'compete' ? 0.022 : 0.05),
            behavior.state === 'compete' ? 0.32 : 0.16, 1);
          desired.multiplyScalar(maxSpeed * brake);
        }
        if (behavior.state === 'compete') {
          // 小幅侧向修正制造探头、错身与再冲刺，而不是钉在颗粒上抖动。
          desired.x += Math.sin(this.time * 7.2 + f.phase) * 0.0045;
          desired.z += Math.cos(this.time * 6.4 + f.phase) * 0.0045;
        }
        for (const other of this.fish) {
          if (other === f) continue;
          const away = f.position.clone().sub(other.position);
          const d = away.length();
          if (d > 1e-5 && d < 0.044) desired.addScaledVector(away.divideScalar(d), 0.022 * (1 - d / 0.044));
        }
        f.velocity.lerp(desired, Math.min(1, dt * (behavior.state === 'notice' ? 3.2 : 5.4)));
        f.position.addScaledVector(f.velocity, dt);
        f.position.x = THREE.MathUtils.clamp(f.position.x, minX + margin, maxX - margin);
        f.position.y = THREE.MathUtils.clamp(f.position.y, floorY + 0.022, waterY - 0.016);
        f.position.z = THREE.MathUtils.clamp(f.position.z, minZ + margin, maxZ - margin);
        f.position.copy(constrainToScape(f.position, this.collision, 0.007));
      } else if (f.startleReturnTime !== null && f.returnFrom) {
        f.startleReturnTime += dt;
        const progress = THREE.MathUtils.clamp(f.startleReturnTime / 1.05, 0, 1);
        const eased = progress * progress * (3 - 2 * progress);
        f.position.copy(f.returnFrom).lerp(path, eased);
        f.position.copy(constrainToScape(f.position, this.collision, 0.007));
        f.velocity.copy(f.position).sub(f.previous).divideScalar(Math.max(dt, 1e-4));
        if (progress >= 1) { f.returnFrom = null; f.startleReturnTime = null; }
      } else {
        f.returnFrom = null;
        f.startleReturnTime = null;
        f.position.copy(path);
        f.velocity.copy(f.position).sub(f.previous).divideScalar(Math.max(dt, 1e-4));
      }

      // 朝向由真实位移决定；发现阶段几乎悬停时也会先转向食物。
      const dir = f.position.clone().sub(f.previous);
      if (dir.lengthSq() < 1e-10 && behavior?.target && behavior.state === 'notice') {
        dir.set(behavior.target.x - f.position.x, behavior.target.y - f.position.y, behavior.target.z - f.position.z);
      }
      if (dir.lengthSq() > 1e-10) {
        const yaw = Math.atan2(-dir.z, dir.x);
        const pitch = Math.asin(THREE.MathUtils.clamp(dir.y / dir.length(), -0.6, 0.6));
        f.heading = yaw;
        const micro = this.species.textured ? 1 : 0;
        f.root.rotation.set(
          Math.sin(this.time * 5.4 + f.phase) * 0.008 * micro,
          yaw + Math.sin(this.time * 0.83 + f.phase) * 0.012 * micro,
          pitch * 0.32 + Math.sin(this.time * 0.67 + f.phase * 1.3) * 0.018 * micro,
        );
      }
      f.root.position.copy(f.position);
      const activity = THREE.MathUtils.clamp(f.velocity.length() / 0.12, 0, 1);
      if (isNeon && f.state) {
        f.swimClock += dt * (5.6 + f.speed * 1.1 + activity * 4.2);
        f.state.time.value = f.swimClock;
        f.state.row.value += dt * (10.2 + f.speed * 1.4 + activity * 3.2);
        const ampTarget = startle.state === 'flee' ? 0.92
          : behavior?.state === 'compete' ? 0.68 : 0.48 + activity * 0.15;
        f.state.amp.value += (ampTarget + 0.04 * Math.sin(this.time * 0.6 + f.phase) - f.state.amp.value) * Math.min(1, dt * 5);
      }
      for (const uniforms of f.motionUniforms) uniforms.uSwimTime.value = this.time * f.speed;
      f.mixer?.update(dt);
    }
    this.time += dt;
  }

  dispose() {
    for (const f of this.fish) {
      f.mixer?.stopAllAction();
      f.startle.dispose();
      this.tank.remove(f.root);
      f.root.traverse(node => {
        if (!node.isMesh) return;
        node.geometry?.dispose();
        node.material?.dispose();
      });
    }
    for (const texture of this.textures) texture.dispose();
    this.textures.length = 0;
    this.fish.length = 0;
  }
}

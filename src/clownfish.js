import * as THREE from 'three';

/**
 * 小丑鱼专用装配：分区材质 + 脊柱弯曲/鳍铰接的顶点变形 + 领地式游动。
 *
 * 为什么小丑鱼要单独一条路径（而不是继续用 fish.js 的 texturedSwimMaterial）：
 * 1. 旧方案只做横向位移，截面不跟着转，身体是"剪切"而不是"弯曲"，看起来像纸板。
 *    这里把脊柱当作曲线：每个截面按切线角旋转（位置与法线一起转），弯的是身体本身。
 * 2. 正式资产是照片重建的单张连通网格，没有独立鳍对象；bakeSwimAttributes 会把
 *    体轴、背腹、侧向坐标归一化后烘成 aBody / aRegion，鳍根到鳍缘的权重直接驱动
 *    胸鳍划水、腹鳍慢半拍、尾鳍滞后。程序化 7-mesh 版本可作为备选重建。
 * 3. 游动不该是匀速椭圆。小丑鱼是领地性的：悬停时靠胸鳍划水、短距离冲刺、
 *    转弯会侧倾；尾拍频率与速度挂钩。这些都需要一套真正的驾驶逻辑。
 */

export const REGION = Object.freeze({
  BODY: 0, DORSAL: 1, ANAL: 2, CAUDAL: 3, PECTORAL: 4, PELVIC: 5, EYE: 6,
});

const WHITE = new THREE.Color(0xf4f1e6);

export function classifyMesh(node) {
  const name = `${node.name} ${node.material?.name || ''}`.toLowerCase();
  if (name.includes('eye')) return REGION.EYE;
  if (name.includes('dorsal')) return REGION.DORSAL;
  if (name.includes('anal')) return REGION.ANAL;
  if (name.includes('caudal')) return REGION.CAUDAL;
  if (name.includes('pectoral')) return REGION.PECTORAL;
  if (name.includes('pelvic')) return REGION.PELVIC;
  return REGION.BODY;
}

/**
 * 体轴坐标烘焙：aBody.x 就是"体长方向的归一化位置"（0 吻端，1 尾柄）。
 * 尾鳍沿用 1.0；胸鳍/腹鳍/眼睛钉在各自的着生点，避免整片鳍被体轴弯折拉变形。
 */
export function bakeSwimAttributes(root) {
  root.updateMatrixWorld(true);
  const namedBody = root.getObjectByName('Body');
  let fallback = null;
  if (!namedBody) root.traverse(node => { if (!fallback && node.isMesh) fallback = node; });
  const body = namedBody || fallback;
  if (!body) throw new Error('clownfish asset has no mesh');
  body.geometry.computeBoundingBox();
  const box = body.geometry.boundingBox;
  const minX = box.min.x;
  const spanX = Math.max(1e-6, box.max.x - box.min.x);
  const centerY = (box.min.y + box.max.y) * 0.5;
  const centerZ = (box.min.z + box.max.z) * 0.5;
  const halfY = Math.max(1e-6, (box.max.y - box.min.y) * 0.5);
  const halfZ = Math.max(1e-6, (box.max.z - box.min.z) * 0.5);
  const densePhotoMesh = !namedBody;
  const clamp01 = value => THREE.MathUtils.clamp(value, 0, 1);

  root.traverse(node => {
    if (!node.isMesh || !node.geometry) return;
    const meshRegion = classifyMesh(node);
    const position = node.geometry.attributes.position;
    const bodyCoord = new Float32Array(position.count * 3);
    const regions = new Float32Array(position.count);
    let pin = null;
    if (!densePhotoMesh && (meshRegion === REGION.PECTORAL || meshRegion === REGION.PELVIC || meshRegion === REGION.EYE)) {
      let sum = 0;
      for (let i = 0; i < position.count; i++) sum += position.getX(i);
      pin = THREE.MathUtils.clamp((sum / position.count - minX) / spanX, 0, 1);
    }
    for (let i = 0; i < position.count; i++) {
      const x = position.getX(i), y = position.getY(i), z = position.getZ(i);
      let u = pin ?? clamp01((x - minX) / spanX);
      let region = meshRegion;
      let tip = 0;
      if (densePhotoMesh) {
        // 照片重建只有一个连通网格。这里按体轴/背腹/侧向的归一化位置识别鳍，
        // 不能写死模型单位——候选资产的体高约 0.61、体宽约 0.30。
        // aBody.y 同时是“鳍根 0 → 鳍缘 1”的权重，旋转和摆动都乘它，
        // 鳍根与身体接缝处才不会因为离散分区被拉开。
        const yn = (y - centerY) / halfY;
        const zn = (z - centerZ) / halfZ;
        if (u > 0.78) {
          region = REGION.CAUDAL;
          tip = (u - 0.78) / 0.22;
        } else if (u > 0.13 && u < 0.75 && yn > 0.52 && Math.abs(zn) < 0.42) {
          region = REGION.DORSAL;
          tip = (yn - 0.52) / 0.48;
        } else if (u > 0.18 && u < 0.47 && yn < -0.62 && Math.abs(zn) < 0.50) {
          region = REGION.PELVIC;
          u = 0.32;
          tip = (-yn - 0.62) / 0.38;
        } else if (u > 0.44 && u < 0.78 && yn < -0.62 && Math.abs(zn) < 0.38) {
          region = REGION.ANAL;
          tip = (-yn - 0.62) / 0.38;
        } else if (u > 0.18 && u < 0.47 && Math.abs(zn) > 0.58 && yn > -0.52 && yn < 0.34) {
          region = REGION.PECTORAL;
          u = 0.31;
          tip = (Math.abs(zn) - 0.58) / 0.42;
        }
        tip = clamp01(tip);
        // 鳍根用 0.001 而不是 0：着色器据此区分“鳍的根”与“身体坐标”。
        if (region !== REGION.BODY) tip = Math.max(tip, 0.001);
      }
      bodyCoord[i * 3] = u;
      bodyCoord[i * 3 + 1] = tip;
      bodyCoord[i * 3 + 2] = 0;
      regions[i] = region;
    }
    node.geometry.setAttribute('aBody', new THREE.BufferAttribute(bodyCoord, 3));
    node.geometry.setAttribute('aRegion', new THREE.BufferAttribute(regions, 1));
    node.userData.region = meshRegion;
    node.userData.densePhotoMesh = densePhotoMesh;
  });
  return { minX, spanX, densePhotoMesh };
}

export const VERT_HEAD = /* glsl */`
attribute vec3 aBody;
attribute float aRegion;
uniform float uSwimTime;
uniform float uSwimPhase;
uniform float uSwimAmp;
uniform float uRowPhase;
uniform float uRowAmp;
uniform vec3 uPectoralPivot;
uniform vec3 uPelvicPivot;
varying float vRegion;
varying vec3 vLocal;

float swimEnvelope(float u) {
  float e = smoothstep(0.04, 1.0, u);
  return e * e;
}
float swimOffset(float u) {
  float ph = (uSwimTime + uSwimPhase) - u * 2.35;
  float wave = sin(ph) + 0.16 * sin(2.0 * ph + 0.7);
  return 0.135 * uSwimAmp * swimEnvelope(u) * wave;
}
vec3 rotY(vec3 p, float a) {
  float c = cos(a), s = sin(a);
  return vec3(p.x * c + p.z * s, p.y, -p.x * s + p.z * c);
}
vec3 rotX(vec3 p, float a) {
  float c = cos(a), s = sin(a);
  return vec3(p.x, p.y * c - p.z * s, p.y * s + p.z * c);
}
`;

export const VERT_BEND = /* glsl */`
  vec3 fishP = transformed;
  vec3 fishN = objectNormal;
  float fishU = clamp(aBody.x, 0.0, 1.0);
  float fishV = aBody.y > 0.0 ? aBody.y : uv.y;
  float fishRegion = aRegion;
  float fishSide = position.z >= 0.0 ? 1.0 : -1.0;
  // 鳍根处权重为 0，越靠鳍缘越接近 1。单网格资产靠它避免鳍根被撕开。
  float finRoot = smoothstep(0.0, 0.26, fishV);

  if (fishRegion > 3.5 && fishRegion < 4.5) {
    // 胸鳍：绕肩关节划水（后掠 + 上扬，两个相位差 90° 才像划桨而不是扇风）
    vec3 pivot = vec3(uPectoralPivot.xy, uPectoralPivot.z * fishSide);
    vec3 local = fishP - pivot;
    float rowA = sin(uRowPhase) * 0.30 * uRowAmp * fishSide * finRoot;
    float rowB = sin(uRowPhase + 1.35) * 0.17 * uRowAmp * fishSide * finRoot;
    local = rotY(local, rowA);
    local = rotX(local, rowB);
    fishP = local + pivot;
    fishN = rotY(fishN, rowA);
    fishN = rotX(fishN, rowB);
  } else if (fishRegion > 4.5 && fishRegion < 5.5) {
    // 腹鳍：小幅摆动，跟着胸鳍的节拍但慢半拍
    vec3 pivot = vec3(uPelvicPivot.xy, uPelvicPivot.z * fishSide);
    vec3 local = fishP - pivot;
    local = rotY(local, sin(uRowPhase * 0.62 + 2.1) * 0.20 * uRowAmp * fishSide * finRoot);
    fishP = local + pivot;
  }

  // 脊柱弯曲：截面按该处的切线角旋转，再叠加中线位移。位置与法线一起转，
  // 所以高光是贴着弯曲的体表走的——这是"游得活"和"纸板在扭"的分界。
  float du = 0.014;
  float ua = max(fishU - du, 0.0);
  float ub = min(fishU + du, 1.0);
  float theta = atan((swimOffset(ub) - swimOffset(ua)) / max(ub - ua, 1e-4));
  theta = clamp(theta, -0.6, 0.6);
  float cz = cos(theta), sz = sin(theta);
  fishP.x += fishP.z * sz;
  fishP.z = fishP.z * cz + swimOffset(fishU);
  fishN = vec3(fishN.x * cz + fishN.z * sz, fishN.y, -fishN.x * sz + fishN.z * cz);

  // 鳍的自发摆动：越靠鳍缘幅度越大；尾鳍额外滞后半个相位，才像被水推着走
  float flutter = 0.0;
  if (fishRegion > 0.5 && fishRegion < 1.5) {
    flutter = 0.010 * uSwimAmp * pow(fishV, 2.0) * sin(uSwimTime + uSwimPhase + 1.8 - fishU * 3.0);
  } else if (fishRegion > 1.5 && fishRegion < 2.5) {
    flutter = 0.008 * uSwimAmp * pow(fishV, 2.0) * sin(uSwimTime + uSwimPhase + 2.4 - fishU * 2.4);
  } else if (fishRegion > 2.5 && fishRegion < 3.5) {
    float lag = (uSwimTime + uSwimPhase) - 2.2 - fishV * 2.6;
    flutter = 0.062 * uSwimAmp * pow(fishV, 1.55) * sin(lag);
  }
  fishP.z += flutter;
  fishN = vec3(fishN.x, fishN.y - flutter * 4.0 * fishV, fishN.z);

  transformed = fishP;
  objectNormal = fishN;
`;

const FRAG_EYE = /* glsl */`
  uniform vec2 uEyeCenter;
  uniform float uEyeRadius;
  varying vec3 vLocal;

  vec3 eyeColor() {
    vec2 q = (vLocal.xy - uEyeCenter) / uEyeRadius;
    float d = length(q);
    float pupil = 1.0 - smoothstep(0.54, 0.61, d);
    float limbus = smoothstep(0.56, 0.62, d) * (1.0 - smoothstep(0.90, 0.98, d));
    // 虹膜：外圈偏橙红，内圈偏暗棕，带一点放射状纹理
    float ang = atan(q.y, q.x);
    vec3 irisOuter = vec3(0.72, 0.28, 0.040);
    vec3 irisInner = vec3(0.30, 0.090, 0.012);
    vec3 iris = mix(irisInner, irisOuter, smoothstep(0.58, 0.92, d));
    iris *= 0.94 + 0.06 * sin(ang * 26.0);
    vec3 color = mix(vec3(0.008, 0.010, 0.012), iris, limbus);
    color = mix(color, vec3(0.045, 0.028, 0.018), smoothstep(0.92, 1.0, d));
    return color;
  }
`;

/**
 * 小丑鱼材质。一份 uniform 状态被 7 个 mesh 共享，鱼群更新时只动一份。
 * source 来自 GLB（提供 map / side / 贴图色彩空间），其余全部重写。
 */
export function clownfishMaterial(source, region, state, options = {}) {
  const isEye = region === REGION.EYE;
  const isFin = region !== REGION.BODY && region !== REGION.EYE;
  const dense = Boolean(options.densePhotoMesh);
  const material = new THREE.MeshPhysicalMaterial({
    map: isEye ? null : source.map,
    normalMap: isEye ? null : source.normalMap,
    normalScale: new THREE.Vector2(dense ? 0.70 : 0.82, dense ? 0.70 : 0.82),
    color: 0xffffff,
    roughness: isEye ? 0.05 : dense ? 0.64 : isFin ? 0.56 : 0.54,
    metalness: 0,
    clearcoat: isEye ? 1 : dense ? 0.045 : isFin ? 0.10 : 0.12,
    clearcoatRoughness: isEye ? 0.03 : dense ? 0.62 : isFin ? 0.46 : 0.42,
    envMapIntensity: isEye ? 1.1 : dense ? 0.16 : isFin ? 0.30 : 0.24,
    // 照片重建的鳍与身体在同一张开放网格里，单面会在侧视时露出破口。
    side: isFin || dense ? THREE.DoubleSide : THREE.FrontSide,
    transparent: false,
    ior: 1.4,
  });
  if (isEye) material.color.setHex(0x1a120c);

  material.onBeforeCompile = shader => {
    Object.assign(shader.uniforms, {
      uSwimTime: state.time,
      uSwimPhase: state.phase,
      uSwimAmp: state.amp,
      uRowPhase: state.row,
      uRowAmp: state.rowAmp,
      // 候选资产的肩关节位于体长 31%、体侧 z≈0.060；腹鳍根在 y≈-0.185。
      uPectoralPivot: { value: options.pectoralPivot || new THREE.Vector3(0.305, -0.005, 0.060) },
      uPelvicPivot: { value: options.pelvicPivot || new THREE.Vector3(0.320, -0.185, 0.025) },
      uEyeCenter: { value: new THREE.Vector2(0.082, 0.046) },
      uEyeRadius: { value: 0.034 },
    });
    shader.vertexShader = VERT_HEAD + shader.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
       vRegion = aRegion;
       vLocal = position;
       ${VERT_BEND}`,
    );
    if (isEye) {
      shader.fragmentShader = FRAG_EYE + shader.fragmentShader.replace(
        '#include <map_fragment>',
        `#include <map_fragment>
         diffuseColor.rgb = eyeColor();`,
      );
    } else if (!isFin) {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <map_fragment>',
        `#include <map_fragment>
         // 缸内光量把橙色往白里推：只压暖色区，白带/黑边保持中性。
         // 头部有照片烘焙出的淡粉高光（色相仍是橙、饱和度很低），单独把它拉回橙色，
         // 否则额头顶会像被闪光灯打爆；白带因为 r≈g≈b，不会被这段命中。
         float clownChroma = max(max(diffuseColor.r, diffuseColor.g), diffuseColor.b)
                           - min(min(diffuseColor.r, diffuseColor.g), diffuseColor.b);
         float clownOrange = smoothstep(0.06, 0.28, diffuseColor.r - diffuseColor.g);
         float clownPaleOrange = smoothstep(0.018, 0.11, diffuseColor.r - diffuseColor.g)
                               * (1.0 - smoothstep(0.10, 0.27, clownChroma));
         float clownWarm = max(clownOrange, clownPaleOrange * 0.82);
         diffuseColor.rgb *= mix(vec3(1.0), vec3(0.96, 0.66, 0.46), clownWarm);
         // 照片贴图把高光也烘进了颜色：轻微压住中性亮面，避免白带和体侧反光糊成一片。
         float clownLuma = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
         float clownNeutral = 1.0 - smoothstep(0.045, 0.18, clownChroma);
         diffuseColor.rgb *= 1.0 - 0.10 * clownNeutral * smoothstep(0.62, 0.92, clownLuma);`,
      ).replace(
        '#include <opaque_fragment>',
        `// 湿皮：掠射角带一点冷色反光，鱼身才不像哑光塑料
         float wetFresnel = pow(1.0 - clamp(dot(normalize(normal), normalize(vViewPosition)), 0.0, 1.0), 3.0);
         outgoingLight = mix(outgoingLight, outgoingLight * vec3(0.92, 0.98, 1.05), wetFresnel * 0.18);
         #include <opaque_fragment>`,
      );
    } else if (isFin) {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <map_fragment>',
        `#include <map_fragment>
         float finOrange = smoothstep(0.06, 0.26, diffuseColor.r - diffuseColor.g);
         diffuseColor.rgb *= mix(vec3(1.0), vec3(0.98, 0.68, 0.50), finOrange);`,
      );
    }
  };
  material.customProgramCacheKey = () => `clownfish-v1-${region}`;
  material.userData.region = region;
  return material;
}

/** 每帧要给 7 个材质喂的共享状态。 */
export function createSwimState(phase = 0) {
  return {
    time: { value: 0 },
    phase: { value: phase },
    amp: { value: 0.45 },
    row: { value: phase },
    rowAmp: { value: 0.7 },
  };
}

/**
 * 小丑鱼驾驶：领地悬停 → 短距离巡游 → 冲刺 → 悬停。
 *
 * 与红绿灯的解析路径不同，这里用"转向力 + 限加速度"：朝向永远不会瞬移，
 * 转弯时身体侧倾，尾拍频率跟着实际速度走。悬停时尾几乎不动、胸鳍持续划水。
 */
export class ClownfishPilot {
  constructor(species, index, home, seed) {
    this.species = species;
    this.index = index;
    this.home = home.clone();
    this.random = mulberry(seed);
    this.position = home.clone();
    this.velocity = new THREE.Vector3(0, 0, 0);
    this.target = home.clone();
    this.stateName = 'hover';
    this.stateTime = 0;
    this.stateDuration = 2 + this.random() * 2;
    this.yaw = this.random() * Math.PI * 2;
    this.pitch = 0;
    this.roll = 0;
    this.yawRate = 0;
    this.swimPhase = 0;
    this.rowPhase = this.random() * Math.PI * 2;
    this.amp = 0.35;
    this.rowAmp = 0.8;
    this.speed = 0;
    this.desired = new THREE.Vector3();
    this.wander = this.random() * 10;
    this.quaternion = new THREE.Quaternion();
    this.qy = new THREE.Quaternion();
    this.qz = new THREE.Quaternion();
    this.qx = new THREE.Quaternion();
    this.axisY = new THREE.Vector3(0, 1, 0);
    this.axisZ = new THREE.Vector3(0, 0, 1);
    this.axisX = new THREE.Vector3(1, 0, 0);
  }

  pickState() {
    const r = this.random();
    if (this.stateName === 'hover') {
      if (r < 0.62) this.enter('cruise');
      else this.enter('hover');
    } else if (this.stateName === 'cruise') {
      if (r < 0.4) this.enter('hover');
      else if (r < 0.7) this.enter('dart');
      else this.enter('cruise');
    } else {
      this.enter('hover');
    }
  }

  enter(name) {
    this.stateName = name;
    this.stateTime = 0;
    this.stateDuration = name === 'dart' ? 0.32 + this.random() * 0.22
      : name === 'cruise' ? 1.6 + this.random() * 2.2
        : 2.2 + this.random() * 2.6;
    if (name === 'hover') {
      this.target.copy(this.home).add(new THREE.Vector3(
        (this.random() - 0.5) * 0.07, (this.random() - 0.5) * 0.035, (this.random() - 0.5) * 0.05,
      ));
    } else {
      const radius = name === 'dart' ? 0.12 : 0.075;
      this.target.set(
        this.home.x + (this.random() - 0.5) * radius * 2,
        this.home.y + (this.random() - 0.5) * 0.06,
        this.home.z + (this.random() - 0.5) * radius,
      );
    }
  }

  update(dt, time, others, feeding = null, startle = null) {
    const { minX, maxX, minZ, maxZ, floorY, waterY } = this.species.space;
    const startled = !!startle?.active;
    const feedingActive = !startled && !!feeding?.active;
    this.stateTime += dt;
    if (!feedingActive && !startled && this.stateTime > this.stateDuration) this.pickState();

    // 悬停不是钉在原地：小丑鱼会沿着自己的领地慢慢绕圈、轻轻起伏。
    // 这条慢速轨道保证"看起来停着"时镜头里仍然有生命感。
    if (!feedingActive && !startled && this.stateName === 'hover') {
      const angle = time * 0.36 + this.index * 2.4;
      this.target.set(
        this.home.x + Math.cos(angle) * 0.024,
        this.home.y + Math.sin(time * 0.55 + this.index * 1.3) * 0.014,
        this.home.z + Math.sin(angle) * 0.020,
      );
    } else if (startled && startle.target) {
      this.target.set(startle.target.x, startle.target.y, startle.target.z);
    } else if (feedingActive && feeding.target) {
      this.target.set(feeding.target.x, feeding.target.y, feeding.target.z);
    }

    const targetSpeed = startled
      ? startle.state === 'alert' ? 0
        : startle.state === 'flee' ? 0.23 + startle.intensity * 0.04 : 0.05
      : feedingActive
        ? feeding.state === 'notice' ? 0.008
          : feeding.state === 'gather' ? 0.145
            : feeding.state === 'compete' ? 0.105 : 0.065
        : this.stateName === 'dart' ? 0.20
          : this.stateName === 'cruise' ? 0.065 : 0.022;

    // 目标方向 + 缓慢游荡；悬停时用低频摆动代替"钉死在一个点"
    this.wander += dt * 0.7;
    this.desired.copy(this.target).sub(this.position);
    const distance = this.desired.length();
    if (distance > 1e-5) this.desired.multiplyScalar(1 / distance);
    const wanderAmp = startled ? 0.06 : feedingActive ? 0.08 : this.stateName === 'hover' ? 0.55 : 0.18;
    this.desired.x += Math.sin(this.wander * 1.3 + this.index * 2.1) * wanderAmp * 0.22;
    this.desired.y += Math.sin(this.wander * 0.9 + this.index) * wanderAmp * 0.12;
    this.desired.z += Math.cos(this.wander * 1.1 + this.index * 1.7) * wanderAmp * 0.22;
    // 靠近目标就减速，避免绕着目标转圈；抢食保留一小段冲刺速度。
    const brake = THREE.MathUtils.clamp(distance / (feedingActive ? 0.024 : 0.03),
      startled && startle.state === 'flee' ? 0.45
        : feedingActive && feeding.state === 'compete' ? 0.38 : 0.25, 1);
    this.desired.multiplyScalar(targetSpeed * brake);

    // 与同缸小丑鱼保持距离（只有两条，简单的斥力就够）
    for (const other of others) {
      if (other === this) continue;
      const dx = this.position.x - other.position.x;
      const dy = this.position.y - other.position.y;
      const dz = this.position.z - other.position.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      const separation = feedingActive || startled ? 0.048 : 0.0045;
      if (d2 < separation * separation && d2 > 1e-9) {
        const inv = (feedingActive || startled ? 0.028 : 0.05) / Math.sqrt(d2);
        this.desired.x += dx * inv;
        this.desired.y += dy * inv * 0.6;
        this.desired.z += dz * inv;
      }
    }

    // 玻璃/水面软排斥：避免贴边硬拐弯
    const marginX = 0.055, marginZ = 0.045, marginY = 0.035;
    if (this.position.x < minX + marginX) this.desired.x += (minX + marginX - this.position.x) * 2.4;
    if (this.position.x > maxX - marginX) this.desired.x -= (this.position.x - (maxX - marginX)) * 2.4;
    if (this.position.z < minZ + marginZ) this.desired.z += (minZ + marginZ - this.position.z) * 2.4;
    if (this.position.z > maxZ - marginZ) this.desired.z -= (this.position.z - (maxZ - marginZ)) * 2.4;
    if (this.position.y < floorY + marginY) this.desired.y += (floorY + marginY - this.position.y) * 3.0;
    if (this.position.y > waterY - marginY) this.desired.y -= (this.position.y - (waterY - marginY)) * 3.0;

    // 限加速度：这是"不生硬"的关键，速度不能瞬间对准目标
    const response = startled ? startle.state === 'alert' ? 11 : startle.state === 'flee' ? 9 : 3.5
      : feedingActive ? 4.4 : 2.6;
    this.velocity.x += (this.desired.x - this.velocity.x) * Math.min(1, dt * response);
    this.velocity.y += (this.desired.y - this.velocity.y) * Math.min(1, dt * (startled ? response : feedingActive ? 3.8 : 2.2));
    this.velocity.z += (this.desired.z - this.velocity.z) * Math.min(1, dt * response);
    this.speed = this.velocity.length();
    this.position.addScaledVector(this.velocity, dt);
    this.position.x = THREE.MathUtils.clamp(this.position.x, minX + 0.035, maxX - 0.035);
    this.position.y = THREE.MathUtils.clamp(this.position.y, floorY + 0.028, waterY - 0.028);
    this.position.z = THREE.MathUtils.clamp(this.position.z, minZ + 0.032, maxZ - 0.032);

    // 朝向：由速度方向得到，偏航角限速逼近；俯仰跟着垂直速度
    const moving = this.speed > 0.004;
    const desiredYaw = moving ? Math.atan2(-this.velocity.z, this.velocity.x) : this.yaw;
    let deltaYaw = ((desiredYaw - this.yaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
    const maxTurn = (startled ? startle.state === 'flee' ? 8 : 5 : feedingActive ? 4.8 : this.stateName === 'hover' ? 1.4 : 3.6) * dt;
    deltaYaw = THREE.MathUtils.clamp(deltaYaw, -maxTurn, maxTurn);
    this.yaw += deltaYaw;
    this.yawRate += (deltaYaw / Math.max(dt, 1e-4) - this.yawRate) * Math.min(1, dt * 5);
    const desiredPitch = moving ? Math.max(-0.35, Math.min(0.35, this.velocity.y / Math.max(this.speed, 0.02) * 0.55)) : 0;
    this.pitch += (desiredPitch - this.pitch) * Math.min(1, dt * 4);
    // 转弯侧倾：速度越快倾角越大，悬停时保留一点呼吸式摆动
    const bankTarget = THREE.MathUtils.clamp(-this.yawRate * 0.18, -0.42, 0.42)
      + (this.stateName === 'hover' ? Math.sin(time * 0.9 + this.index * 1.7) * 0.05 : 0);
    this.roll += (bankTarget - this.roll) * Math.min(1, dt * 3.2);

    // 尾拍与胸鳍：速度越快尾拍越大越快；悬停时胸鳍负责主要推动
    const speedFactor = THREE.MathUtils.clamp(this.speed / 0.18, 0, 1);
    const ampTarget = 0.16 + 0.84 * speedFactor;
    this.amp += (ampTarget - this.amp) * Math.min(1, dt * 3.5);
    const freq = 2.1 + 5.6 * speedFactor;
    this.swimPhase += dt * Math.PI * 2 * freq;
    const rowFreq = startled ? startle.state === 'flee' ? 0.9 : 1.7
      : !feedingActive && this.stateName === 'hover' || feeding?.state === 'notice'
        ? 2.05 : 1.15 + 1.4 * (1 - speedFactor);
    this.rowPhase += dt * Math.PI * 2 * rowFreq;
    const rowTarget = THREE.MathUtils.clamp(0.35 + 0.75 * (1 - speedFactor), 0.2, 1.05);
    this.rowAmp += (rowTarget - this.rowAmp) * Math.min(1, dt * 2.4);

    this.qy.setFromAxisAngle(this.axisY, this.yaw + Math.sin(this.swimPhase + 0.6) * 0.030 * this.amp);
    this.qz.setFromAxisAngle(this.axisZ, this.pitch);
    this.qx.setFromAxisAngle(this.axisX, this.roll + Math.sin(this.swimPhase + 2.1) * 0.032 * this.amp);
    this.quaternion.copy(this.qy).multiply(this.qz).multiply(this.qx);
  }

  applyTo(root, state) {
    root.position.copy(this.position);
    root.quaternion.copy(this.quaternion);
    state.time.value = this.swimPhase;
    state.amp.value = this.amp;
    state.row.value = this.rowPhase;
    state.rowAmp.value = this.rowAmp;
  }
}

function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 两条鱼的领地：贴着左下的砂面，是真实小丑鱼待海葵附近的姿态。 */
export function clownfishHomes(species) {
  const { floorY } = species.space;
  return [
    new THREE.Vector3(-0.065, floorY + 0.085, 0.020),
    new THREE.Vector3(-0.010, floorY + 0.125, -0.028),
  ];
}

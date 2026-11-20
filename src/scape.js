import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { getScapePreset, getScapeCollision, scapeSummary } from './scape-data.js';

const cm = value => value / 100;
const vectorCm = values => new THREE.Vector3(...values.map(cm));
const UP = new THREE.Vector3(0, 1, 0);
const smoothstep = (a, b, value) => {
  const t = THREE.MathUtils.clamp((value - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function makeDetailMap(seed, woody = false) {
  const random = seededRandom(seed);
  const size = 256;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = (y * size + x) * 4;
    const grain = woody
      ? Math.sin(x * 0.31 + Math.sin(y * 0.045) * 3.2) * 30 + Math.sin(x * 0.83 + y * 0.018) * 15
      : Math.sin(x * 0.12 + y * 0.09) * 12 + Math.cos(x * 0.047 - y * 0.16) * 14;
    const value = THREE.MathUtils.clamp(128 + grain + (random() - 0.5) * (woody ? 35 : 72), 0, 255);
    data[i] = data[i + 1] = data[i + 2] = value;
    data[i + 3] = 255;
  }
  const texture = new THREE.DataTexture(data, size, size);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(woody ? 2 : 3, woody ? 5 : 2);
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}

/** Curved, folded botanical meshes. Every vertex carries its own sway weight. */
class PlantGeometryBuilder {
  constructor() {
    this.positions = [];
    this.colors = [];
    this.flex = [];
    this.phases = [];
    this.indices = [];
  }

  leaf({ root, height, width, angle, lean, phase, kind, random, tint = 'green' }) {
    const grass = kind === 'grass' || kind === 'carpet';
    const axis = kind === 'stemAxis';
    const segments = grass ? 13 : axis ? 7 : 10;
    const acrossCount = kind === 'broadleaf' ? 5 : 3;
    const start = this.positions.length / 3;
    const direction = new THREE.Vector3(Math.cos(angle), 0, Math.sin(angle));
    const side = new THREE.Vector3(-Math.sin(angle), 0, Math.cos(angle));
    const red = tint === 'red';
    const hue = axis ? 0.25 : red ? 0.025 + random() * 0.035
      : kind === 'broadleaf' ? 0.315 + random() * 0.035 : 0.255 + random() * 0.05;
    const baseColor = new THREE.Color().setHSL(hue,
      axis ? 0.34 : red ? 0.46 + random() * 0.12 : 0.48 + random() * 0.2,
      axis ? 0.16 : kind === 'broadleaf' ? 0.17 + random() * 0.045 : 0.19 + random() * 0.055,
      THREE.SRGBColorSpace);
    const tipColor = baseColor.clone().multiplyScalar(grass ? 1.65 : 1.35);
    for (let segment = 0; segment <= segments; segment++) {
      const t = segment / segments;
      const center = root.clone()
        .addScaledVector(direction, lean * Math.pow(t, grass ? 1.72 : 1.5))
        .add(new THREE.Vector3(0, height * t, 0));
      if (grass) center.y -= height * 0.1 * Math.pow(t, 4);
      center.addScaledVector(side, Math.sin(t * Math.PI) * lean * 0.12 * Math.sin(phase));
      const profile = axis ? Math.pow(Math.max(0.001, 1 - t), 0.42) : grass
        ? Math.pow(Math.max(0.001, 1 - t), 0.58) * (0.48 + Math.sin(t * Math.PI) * 0.52)
        : Math.pow(Math.max(0.001, Math.sin(t * Math.PI)), kind === 'broadleaf' ? 0.6 : 0.72) * (0.9 + t * 0.1);
      const halfWidth = width * profile * 0.5;
      for (let across = 0; across < acrossCount; across++) {
        const offset = acrossCount === 5 ? (across - 2) / 2 : across - 1;
        const point = center.clone().addScaledVector(side, offset * halfWidth);
        // Cupped lamina, a raised midrib and subtly undulating margins.
        point.addScaledVector(direction, (1 - Math.abs(offset)) * halfWidth * 0.14);
        point.y -= Math.abs(offset) * halfWidth * (kind === 'broadleaf' ? 0.16 : 0.07);
        if (!grass && !axis) point.addScaledVector(side,
          Math.sin(t * Math.PI * 6 + phase) * width * 0.025 * Math.abs(offset));
        point.x = THREE.MathUtils.clamp(point.x, -0.19, 0.19);
        point.z = THREE.MathUtils.clamp(point.z, -0.115, 0.115);
        this.positions.push(point.x, point.y, point.z);
        const vein = Math.abs(offset) < 0.1 ? 0.1 : 0;
        const color = baseColor.clone().lerp(tipColor, t * 0.86 + vein);
        this.colors.push(color.r, color.g, color.b);
        this.flex.push(Math.pow(t, axis ? 1.25 : 1.7));
        this.phases.push(phase);
      }
      if (segment < segments) {
        const a = start + segment * acrossCount;
        const b = a + acrossCount;
        for (let column = 0; column < acrossCount - 1; column++) {
          this.indices.push(a + column, b + column, a + column + 1,
            a + column + 1, b + column, b + column + 1);
        }
      }
    }
  }

  build() {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(this.positions, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(this.colors, 3));
    geometry.setAttribute('aFlex', new THREE.Float32BufferAttribute(this.flex, 1));
    geometry.setAttribute('aPhase', new THREE.Float32BufferAttribute(this.phases, 1));
    geometry.setIndex(this.indices);
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    return geometry;
  }
}

function makeRockGeometry(seed, mossAmount) {
  const geometry = mergeVertices(new THREE.IcosahedronGeometry(1, 3));
  const position = geometry.attributes.position;
  const colors = [];
  const low = new THREE.Color(0x29332f);
  const high = new THREE.Color(0x788077);
  const mossDark = new THREE.Color(0x17351c);
  const mossLight = new THREE.Color(0x527238);
  for (let index = 0; index < position.count; index++) {
    let x = position.getX(index), y = position.getY(index), z = position.getZ(index);
    const broad = Math.sin(x * 4.7 + seed) * Math.cos(y * 5.9 - z * 3.8 + seed * 0.3);
    const fine = Math.sin(x * 17.1 + z * 13.7 + seed) * Math.cos(y * 15.3 - seed);
    const scale = 1 + broad * 0.095 + fine * 0.022;
    // Slightly blocky superellipsoid: weathered stone, not a smooth potato.
    x = Math.sign(x) * Math.pow(Math.abs(x), 0.88) * scale;
    y = Math.sign(y) * Math.pow(Math.abs(y), 0.9) * scale;
    z = Math.sign(z) * Math.pow(Math.abs(z), 0.86) * scale;
    y = Math.max(-0.76, y);
    position.setXYZ(index, x, y, z);
    const grain = Math.sin(x * 29 + z * 23 + seed) * 0.04 + fine * 0.035;
    const shade = THREE.MathUtils.clamp(0.43 + y * 0.19 + broad * 0.12 + grain, 0.06, 0.9);
    const tint = low.clone().lerp(high, shade);
    const patchNoise = Math.sin(x * 8.2 + seed) + Math.cos(z * 9.7 - seed * 0.4) + fine * 0.7;
    const coverage = smoothstep(0.12, 0.72, y + patchNoise * 0.2) * Math.min(1, mossAmount / 24);
    if (coverage > 0) {
      const moss = mossDark.clone().lerp(mossLight, THREE.MathUtils.clamp(0.35 + fine * 0.5 + grain * 2, 0, 1));
      tint.lerp(moss, coverage * 0.88);
    }
    colors.push(tint.r, tint.g, tint.b);
  }
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.computeVertexNormals();
  return geometry;
}

/** Irregular tapered sweep with long bark furrows and asymmetric cross sections. */
function makeWoodGeometry(branch, seed) {
  const curve = new THREE.CatmullRomCurve3(branch.points.map(vectorCm));
  const segments = Math.max(22, (branch.points.length - 1) * 10);
  const radial = 14;
  const frames = curve.computeFrenetFrames(segments, false);
  const positions = [], colors = [], uvs = [], indices = [];
  const dark = new THREE.Color(0x211c16), light = new THREE.Color(0x65533e);
  for (let segment = 0; segment <= segments; segment++) {
    const t = segment / segments;
    const scaled = t * (branch.radii.length - 1);
    const lower = Math.min(branch.radii.length - 2, Math.floor(scaled));
    const mix = scaled - lower;
    const smoothMix = mix * mix * (3 - 2 * mix);
    const radius = cm(THREE.MathUtils.lerp(branch.radii[lower], branch.radii[lower + 1], smoothMix));
    const center = curve.getPointAt(t);
    for (let side = 0; side <= radial; side++) {
      const angle = side / radial * Math.PI * 2;
      const furrow = Math.sin(angle * 7 + t * 5 + seed) * 0.09 + Math.cos(angle * 3 - t * 8) * 0.055;
      const knot = 1 + Math.sin(t * 19 + seed) * 0.025;
      const offset = frames.normals[segment].clone().multiplyScalar(Math.cos(angle) * (1 + furrow))
        .addScaledVector(frames.binormals[segment], Math.sin(angle) * (0.88 - furrow * 0.35))
        .multiplyScalar(radius * knot);
      const point = center.clone().add(offset);
      positions.push(point.x, point.y, point.z);
      uvs.push(side / radial, t * 3);
      const shade = THREE.MathUtils.clamp(0.42 + Math.cos(angle - 0.65) * 0.2 - furrow * 0.8, 0.05, 0.85);
      const tint = dark.clone().lerp(light, shade);
      colors.push(tint.r, tint.g, tint.b);
      if (segment < segments && side < radial) {
        const a = segment * (radial + 1) + side;
        const b = a + radial + 1;
        indices.push(a, b, a + 1, a + 1, b, b + 1);
      }
    }
  }
  const tip = positions.length / 3;
  const end = curve.getPointAt(1);
  positions.push(end.x, end.y, end.z);
  colors.push(dark.r, dark.g, dark.b);
  uvs.push(0.5, 1);
  for (let side = 0; side < radial; side++) indices.push(tip, segments * (radial + 1) + side, segments * (radial + 1) + side + 1);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function addPlantCluster(builder, cluster, random) {
  const rosettes = [];
  for (let index = 0; index < cluster.count; index++) {
    const angle = random() * Math.PI * 2;
    const radius = Math.sqrt(random()) * cluster.spread * 0.5;
    const root = vectorCm([
      cluster.center[0] + Math.cos(angle) * radius,
      cluster.center[1] + random() * 0.12,
      cluster.center[2] + Math.sin(angle) * radius,
    ]);
    const height = cm(THREE.MathUtils.lerp(cluster.height[0], cluster.height[1], random()));
    const phase = random() * Math.PI * 2;
    if (cluster.kind === 'stem') {
      const stemAngle = random() * Math.PI * 2;
      const stemLean = height * (0.07 + random() * 0.1);
      builder.leaf({ root, height, width: cm(0.1), angle: stemAngle, lean: stemLean,
        phase, kind: 'stemAxis', random, tint: cluster.tint });
      const nodes = 3 + Math.floor(random() * 3);
      for (let node = 0; node < nodes; node++) {
        const t = 0.25 + node / Math.max(1, nodes - 1) * 0.58;
        const nodeRoot = root.clone().add(new THREE.Vector3(
          Math.cos(stemAngle) * stemLean * Math.pow(t, 1.5), height * t, Math.sin(stemAngle) * stemLean * Math.pow(t, 1.5)));
        for (let pair = 0; pair < 2; pair++) {
          const leafLength = height * (0.16 + random() * 0.08) * (1.1 - t * 0.35);
          builder.leaf({ root: nodeRoot, height: leafLength, width: cm(cluster.width * (0.8 + random() * 0.35)),
            angle: stemAngle + node * 2.35 + pair * Math.PI, lean: leafLength * (0.72 + random() * 0.25),
            phase: phase + node * 0.7 + pair, kind: 'stem', random, tint: cluster.tint });
        }
      }
      continue;
    }
    if (cluster.kind === 'broadleaf') {
      const rosette = Math.floor(index / 7);
      if (!rosettes[rosette]) rosettes[rosette] = { root, angle: random() * Math.PI * 2 };
      const leaf = index % 7;
      const base = rosettes[rosette];
      const outer = leaf / 6;
      const leafHeight = height * (1 - outer * 0.22);
      builder.leaf({ root: base.root, height: leafHeight, width: cm(cluster.width * (0.82 + random() * 0.3)),
        angle: base.angle + leaf * 2.39996 + (random() - 0.5) * 0.18,
        lean: leafHeight * (0.38 + outer * 0.42 + random() * 0.12), phase, kind: cluster.kind, random, tint: cluster.tint });
      continue;
    }
    const leafAngle = random() * Math.PI * 2;
    const leanRatio = cluster.kind === 'carpet' ? 0.4 + random() * 0.35 : 0.25 + random() * 0.35;
    builder.leaf({ root, height, width: cm(cluster.width * (0.7 + random() * 0.55)), angle: leafAngle,
      lean: height * leanRatio, phase, kind: cluster.kind, random, tint: cluster.tint });
  }
}

/** Build one complete P3 preset. Resources are owned by the enclosing scene. */
export function createScape(tank, id, context) {
  const { own } = context;
  const preset = getScapePreset(id);
  const random = seededRandom(9107 + preset.id.length * 131);
  const group = new THREE.Group();
  group.name = preset.id;
  tank.add(group);

  const rockBump = own(makeDetailMap(7401));
  const rockMat = own(new THREE.MeshStandardMaterial({
    color: 0xffffff, vertexColors: true, roughness: 0.88, metalness: 0.01,
    bumpMap: rockBump, bumpScale: 0.00125, envMapIntensity: 0.32,
  }));
  const mossTransforms = [];
  const normalMatrix = new THREE.Matrix3();
  for (const [index, rock] of preset.rocks.entries()) {
    const geometry = own(makeRockGeometry(index + preset.id.length * 3, rock.moss));
    const mesh = new THREE.Mesh(geometry, rockMat);
    mesh.position.copy(vectorCm(rock.center));
    mesh.scale.set(...rock.size.map(value => cm(value) * 0.5));
    mesh.rotation.set(...rock.rotation);
    mesh.updateMatrix();
    normalMatrix.getNormalMatrix(mesh.matrix);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.collisionId = `${preset.id}.rock.${index}`;
    group.add(mesh);
    const positions = geometry.attributes.position;
    const normals = geometry.attributes.normal;
    const stride = Math.max(1, Math.floor(positions.count / (rock.moss * 10)));
    for (let vertex = index % stride; vertex < positions.count; vertex += stride) {
      const normal = new THREE.Vector3().fromBufferAttribute(normals, vertex);
      if (normal.y < 0.24 || random() < 0.18) continue;
      const local = new THREE.Vector3().fromBufferAttribute(positions, vertex);
      const position = local.applyMatrix4(mesh.matrix);
      const worldNormal = normal.applyMatrix3(normalMatrix).normalize();
      position.addScaledVector(worldNormal, 0.0003);
      mossTransforms.push({ position, normal: worldNormal, scale: 0.00035 + random() * 0.00075,
        rotation: random() * Math.PI, hue: 0.255 + random() * 0.045 });
    }
  }

  const mossGeo = own(new THREE.IcosahedronGeometry(1, 0));
  const mossMat = own(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.98, envMapIntensity: 0.18 }));
  const moss = new THREE.InstancedMesh(mossGeo, mossMat, mossTransforms.length);
  const dummy = new THREE.Object3D();
  const color = new THREE.Color();
  mossTransforms.forEach((item, index) => {
    dummy.position.copy(item.position);
    dummy.quaternion.setFromUnitVectors(UP, item.normal);
    dummy.rotateY(item.rotation);
    dummy.scale.set(item.scale * 1.3, item.scale * 0.42, item.scale);
    dummy.updateMatrix();
    moss.setMatrixAt(index, dummy.matrix);
    moss.setColorAt(index, color.setHSL(item.hue, 0.52, 0.18 + random() * 0.09, THREE.SRGBColorSpace));
  });
  moss.castShadow = true;
  moss.receiveShadow = true;
  group.add(moss);
  own(moss);

  const woodBump = own(makeDetailMap(8821, true));
  const woodMat = own(new THREE.MeshStandardMaterial({
    color: 0xcbbca7, vertexColors: true, roughness: 0.91, metalness: 0,
    bumpMap: woodBump, bumpScale: 0.0016, envMapIntensity: 0.22,
  }));
  preset.woods.forEach((branch, index) => {
    const mesh = new THREE.Mesh(own(makeWoodGeometry(branch, index + 2)), woodMat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.collisionId = `${preset.id}.wood.${index}`;
    group.add(mesh);
  });

  // Small pebbles gather around hardscape feet, softening the rock/sand seam.
  const pebbleCount = 84;
  const pebbleGeo = own(new THREE.DodecahedronGeometry(1, 0));
  const pebbleMat = own(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.96 }));
  const pebbles = new THREE.InstancedMesh(pebbleGeo, pebbleMat, pebbleCount);
  for (let index = 0; index < pebbleCount; index++) {
    const rock = preset.rocks[index % preset.rocks.length];
    const angle = random() * Math.PI * 2;
    const distance = 0.42 + random() * 0.32;
    dummy.position.set(cm(rock.center[0] + Math.cos(angle) * rock.size[0] * distance),
      0.0165 + random() * 0.0008, cm(rock.center[2] + Math.sin(angle) * rock.size[2] * distance));
    dummy.position.x = THREE.MathUtils.clamp(dummy.position.x, -0.188, 0.188);
    dummy.position.z = THREE.MathUtils.clamp(dummy.position.z, -0.113, 0.113);
    const size = 0.0006 + random() * 0.0016;
    dummy.scale.set(size * (0.8 + random() * 0.6), size * 0.55, size);
    dummy.rotation.set(random(), random() * Math.PI, random());
    dummy.updateMatrix();
    pebbles.setMatrixAt(index, dummy.matrix);
    pebbles.setColorAt(index, color.setHSL(0.1 + random() * 0.05, 0.08 + random() * 0.1, 0.28 + random() * 0.2, THREE.SRGBColorSpace));
  }
  pebbles.receiveShadow = true;
  group.add(pebbles);
  own(pebbles);

  const builder = new PlantGeometryBuilder();
  for (const cluster of preset.plants) addPlantCluster(builder, cluster, random);
  const plantUniforms = { uPlantTime: { value: 0 }, uPlantStrength: { value: 1 } };
  const plantMat = own(new THREE.MeshStandardMaterial({
    color: 0xffffff, vertexColors: true, roughness: 0.58, metalness: 0,
    side: THREE.DoubleSide, envMapIntensity: 0.32,
  }));
  plantMat.onBeforeCompile = shader => {
    Object.assign(shader.uniforms, plantUniforms);
    shader.vertexShader = `
      attribute float aFlex; attribute float aPhase;
      uniform float uPlantTime; uniform float uPlantStrength;
    ` + shader.vertexShader.replace('#include <begin_vertex>', `
      #include <begin_vertex>
      float plantWave = sin(uPlantTime * 0.92 + aPhase + aFlex * 1.35)
        + 0.22 * sin(uPlantTime * 1.73 + aPhase * 1.7 + aFlex * 2.1);
      float plantBend = aFlex * uPlantStrength;
      transformed.x += plantWave * plantBend * 0.0038;
      transformed.z += cos(uPlantTime * 0.71 + aPhase + aFlex * 1.1) * plantBend * 0.0024;
    `);
  };
  plantMat.customProgramCacheKey = () => 'aquarium-plant-sway-v2';
  const plants = new THREE.Mesh(own(builder.build()), plantMat);
  plants.castShadow = true;
  plants.receiveShadow = true;
  plants.frustumCulled = false;
  group.add(plants);

  const summary = scapeSummary(id);
  return {
    id: preset.id,
    group,
    airStone: vectorCm(preset.airStone),
    collision: getScapeCollision(id),
    motion: plantUniforms,
    stats: { ...summary, mossInstances: mossTransforms.length, pebbleInstances: pebbleCount,
      plantTriangles: builder.indices.length / 3 },
    update(time, eco = false) {
      plantUniforms.uPlantTime.value = eco ? Math.floor(time * 15) / 15 : time;
      plantUniforms.uPlantStrength.value = eco ? 0.58 : 1;
    },
    setQuality(eco) {
      moss.count = eco ? Math.ceil(mossTransforms.length * 0.55) : mossTransforms.length;
      pebbles.count = eco ? 48 : pebbleCount;
    },
  };
}

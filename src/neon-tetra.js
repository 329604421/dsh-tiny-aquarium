import * as THREE from 'three';
import { REGION, VERT_HEAD, VERT_BEND, createSwimState } from './clownfish.js';

/**
 * Neon tetra (Paracheirodon innesi) single-mesh virtual rig.
 *
 * Canonical asset space: X = snout-to-tail (snout at min X), Y = dorsal up,
 * Z = left/right. The photographs show a slender, laterally compressed tetra;
 * aBody.x is anatomical snout 0 → tail 1 along increasing X.
 * These thresholds are intentionally different from the deep-bodied clownfish.
 */
export function classifyNeonTetraVertex(u, yn, zn) {
  const side = Math.abs(zn);
  if (u > 0.795) return { region: REGION.CAUDAL, tip: (u - 0.795) / 0.205 };
  if (u > 0.27 && u < 0.78 && yn > 0.48 && side < 0.50) {
    return { region: REGION.DORSAL, tip: (yn - 0.48) / 0.52 };
  }
  if (u > 0.34 && u < 0.50 && yn < -0.64 && side < 0.55) {
    return { region: REGION.PELVIC, tip: (-yn - 0.64) / 0.36, pin: 0.40 };
  }
  if (u > 0.50 && u < 0.795 && yn < -0.48 && side < 0.48) {
    return { region: REGION.ANAL, tip: (-yn - 0.48) / 0.52 };
  }
  if (u > 0.20 && u < 0.38 && side > 0.68 && yn > -0.48 && yn < 0.12) {
    return { region: REGION.PECTORAL, tip: (side - 0.68) / 0.32, pin: 0.29 };
  }
  return { region: REGION.BODY, tip: 0 };
}

export function bakeNeonTetraAttributes(root) {
  root.updateMatrixWorld(true);
  const namedBody = root.getObjectByName('Body');
  let fallback = null;
  if (!namedBody) root.traverse(node => { if (!fallback && node.isMesh) fallback = node; });
  const body = namedBody || fallback;
  if (!body) throw new Error('neon tetra asset has no mesh');
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
    const position = node.geometry.attributes.position;
    const bodyCoord = new Float32Array(position.count * 3);
    const regions = new Float32Array(position.count);
    for (let i = 0; i < position.count; i++) {
      const x = position.getX(i), y = position.getY(i), z = position.getZ(i);
      let u = clamp01((x - minX) / spanX);
      let region = REGION.BODY;
      let tip = 0;
      if (densePhotoMesh) {
        const yn = (y - centerY) / halfY;
        const zn = (z - centerZ) / halfZ;
        const classified = classifyNeonTetraVertex(u, yn, zn);
        region = classified.region;
        tip = clamp01(classified.tip);
        if (classified.pin !== undefined) u = classified.pin;
        if (region !== REGION.BODY) tip = Math.max(tip, 0.001);
      }
      bodyCoord[i * 3] = u;
      bodyCoord[i * 3 + 1] = tip;
      bodyCoord[i * 3 + 2] = 0;
      regions[i] = region;
    }
    node.geometry.setAttribute('aBody', new THREE.BufferAttribute(bodyCoord, 3));
    node.geometry.setAttribute('aRegion', new THREE.BufferAttribute(regions, 1));
    node.userData.densePhotoMesh = densePhotoMesh;
  });

  return {
    densePhotoMesh,
    pectoralPivot: new THREE.Vector3(minX + spanX * 0.29, centerY - halfY * 0.10, centerZ + halfZ * 0.72),
    pelvicPivot: new THREE.Vector3(minX + spanX * 0.40, centerY - halfY * 0.56, centerZ + halfZ * 0.30),
  };
}

/** Preserve the photograph's cyan stripe and red posterior without painting the whole fish. */
export function neonTetraMaterial(source, state, rig) {
  const material = new THREE.MeshPhysicalMaterial({
    map: source.map,
    normalMap: source.normalMap,
    normalScale: new THREE.Vector2(0.58, 0.58),
    color: 0xffffff,
    roughness: 0.57,
    metalness: 0,
    clearcoat: 0.055,
    clearcoatRoughness: 0.54,
    envMapIntensity: 0.20,
    side: THREE.DoubleSide,
    transparent: false,
    ior: 1.38,
  });
  material.onBeforeCompile = shader => {
    Object.assign(shader.uniforms, {
      uSwimTime: state.time,
      uSwimPhase: state.phase,
      uSwimAmp: state.amp,
      uRowPhase: state.row,
      uRowAmp: state.rowAmp,
      uPectoralPivot: { value: rig.pectoralPivot },
      uPelvicPivot: { value: rig.pelvicPivot },
    });
    shader.vertexShader = VERT_HEAD + shader.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
       vRegion = aRegion;
       vLocal = position;
       ${VERT_BEND}`,
    );
    shader.fragmentShader = 'varying float vRegion;\n' + shader.fragmentShader.replace(
      '#include <map_fragment>',
      `#include <map_fragment>
       float neonChroma = max(max(diffuseColor.r, diffuseColor.g), diffuseColor.b)
                        - min(min(diffuseColor.r, diffuseColor.g), diffuseColor.b);
       float neonBlue = smoothstep(0.025, 0.24, diffuseColor.b - diffuseColor.r)
                      * smoothstep(0.010, 0.16, diffuseColor.g - diffuseColor.r);
       float neonRed = smoothstep(0.055, 0.27, diffuseColor.r - diffuseColor.g)
                     * smoothstep(0.035, 0.22, diffuseColor.r - diffuseColor.b);
       diffuseColor.rgb *= mix(vec3(1.0), vec3(0.72, 1.04, 1.16), neonBlue * 0.72);
       diffuseColor.rgb *= mix(vec3(1.0), vec3(1.00, 0.73, 0.72), neonRed * 0.62);
       // Suppress fixed photographic white glare, but do not dull the saturated cyan stripe.
       float neonLuma = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
       float neonNeutral = 1.0 - smoothstep(0.045, 0.18, neonChroma);
       diffuseColor.rgb *= 1.0 - 0.07 * neonNeutral * smoothstep(0.64, 0.94, neonLuma);
       // Single-mesh fins cannot have separate transparency; lower their baked white
       // background toward a quiet membrane grey while retaining orange fin roots.
       float neonFin = step(0.5, vRegion) * (1.0 - step(5.5, vRegion));
       diffuseColor.rgb *= mix(1.0, 0.68, neonFin * (0.45 + 0.55 * neonNeutral));`,
    ).replace(
      '#include <opaque_fragment>',
      `float neonFresnel = pow(1.0 - clamp(dot(normalize(normal), normalize(vViewPosition)), 0.0, 1.0), 3.0);
       outgoingLight = mix(outgoingLight, outgoingLight * vec3(0.90, 1.01, 1.08), neonFresnel * 0.15);
       #include <opaque_fragment>`,
    );
  };
  material.customProgramCacheKey = () => 'neon-tetra-v1';
  return material;
}

export function createNeonTetraState(phase = 0) {
  const state = createSwimState(phase);
  state.amp.value = 0.50;
  state.rowAmp.value = 0.82;
  return state;
}

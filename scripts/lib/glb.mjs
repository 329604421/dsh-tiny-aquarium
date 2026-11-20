/**
 * 极简 GLB 读取器：只为体检服务，不做渲染。
 *
 * 体检需要的事实都在 JSON chunk 与 BIN chunk 里：每个 mesh primitive 的索引数量
 * （面数）、POSITION 的 min/max（尺度与朝向）、images 的 byteLength 与像素尺寸
 * （贴图预算）、animations 的名字（是否有 Swim）。不引入 gltf 依赖，避免为了
 * 一次体检拉进整套解析器。
 */
import { readFile } from 'node:fs/promises';

const MAGIC = 0x46546c67; // 'glTF'
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

export class GlbError extends Error {}

/** @returns {{ json: object, bin: Buffer|null, version: number, byteLength: number }} */
export function parseGlb(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (bytes.length < 20) throw new GlbError('文件太小，不是有效的 GLB');
  const magic = bytes.readUInt32LE(0);
  if (magic !== MAGIC) throw new GlbError('缺少 glTF 魔数，可能不是 .glb');
  const version = bytes.readUInt32LE(4);
  const declared = bytes.readUInt32LE(8);
  if (version !== 2) throw new GlbError(`只支持 glTF 2.0，当前版本 ${version}`);
  if (declared !== bytes.length) throw new GlbError(`头部声明 ${declared} 字节，实际 ${bytes.length} 字节`);

  let offset = 12;
  let json = null;
  let bin = null;
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32LE(offset);
    const type = bytes.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + length;
    if (end > bytes.length) throw new GlbError('chunk 长度越界');
    if (type === CHUNK_JSON && json === null) {
      json = JSON.parse(bytes.subarray(start, end).toString('utf8').replace(/\0+$/, ''));
    } else if (type === CHUNK_BIN && bin === null) {
      bin = bytes.subarray(start, end);
    }
    offset = end + ((4 - (length % 4)) % 4);
  }
  if (!json) throw new GlbError('缺少 JSON chunk');
  return { json, bin, version, byteLength: bytes.length };
}

function imageSize(buffer, mimeType) {
  if (!buffer || buffer.length < 32) return null;
  if ((mimeType === 'image/png' || buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))) {
    if (buffer.length < 24) return null;
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (mimeType === 'image/jpeg' || (buffer[0] === 0xff && buffer[1] === 0xd8)) {
    let i = 2;
    while (i + 9 < buffer.length) {
      if (buffer[i] !== 0xff) { i++; continue; }
      const marker = buffer[i + 1];
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: buffer.readUInt16BE(i + 5), width: buffer.readUInt16BE(i + 7) };
      }
      const length = buffer.readUInt16BE(i + 2);
      if (length <= 0) break;
      i += 2 + length;
    }
  }
  return null;
}

/** 一张贴图的实际像素与载体信息。 */
function imageStats(json, bin, image) {
  const mimeType = image.mimeType ?? '';
  if (typeof image.uri === 'string' && image.uri.length) {
    return { mimeType, uri: image.uri, bytes: 0, width: 0, height: 0, embedded: false };
  }
  const view = json.bufferViews?.[image.bufferView];
  if (!view || !bin) return { mimeType, uri: null, bytes: 0, width: 0, height: 0, embedded: true };
  const slice = bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength);
  const size = imageSize(slice, mimeType);
  return { mimeType, uri: null, bytes: view.byteLength, width: size?.width ?? 0, height: size?.height ?? 0, embedded: true };
}

/** 面数：优先用索引数量，退化到顶点数量。 */
function trianglesOf(json) {
  let triangles = 0;
  let primitives = 0;
  for (const mesh of json.meshes ?? []) {
    for (const primitive of mesh.primitives ?? []) {
      primitives++;
      const mode = primitive.mode ?? 4;
      const count = primitive.indices !== undefined
        ? json.accessors?.[primitive.indices]?.count ?? 0
        : json.accessors?.[primitive.attributes?.POSITION]?.count ?? 0;
      if (mode === 4) triangles += Math.floor(count / 3);
    }
  }
  return { triangles, primitives };
}

/** 物体空间包围盒（米以外的单位，与资产自身一致）。 */
function boundsOf(json) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  let found = false;
  for (const mesh of json.meshes ?? []) {
    for (const primitive of mesh.primitives ?? []) {
      const accessor = json.accessors?.[primitive.attributes?.POSITION];
      if (!accessor?.min || !accessor?.max) continue;
      found = true;
      for (let axis = 0; axis < 3; axis++) {
        min[axis] = Math.min(min[axis], accessor.min[axis]);
        max[axis] = Math.max(max[axis], accessor.max[axis]);
      }
    }
  }
  if (!found) return null;
  return { min, max, size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]] };
}

/**
 * 体检要的一整份事实。`file` 只用于报告，不参与判定。
 * @param {Buffer} buffer
 */
export function assetStats(buffer) {
  const { json, bin, byteLength } = parseGlb(buffer);
  const { triangles, primitives } = trianglesOf(json);
  const images = (json.images ?? []).map(image => imageStats(json, bin, image));
  return {
    byteLength,
    generator: json.asset?.generator ?? '',
    version: json.asset?.version ?? '',
    meshes: (json.meshes ?? []).length,
    primitives,
    materials: (json.materials ?? []).length,
    triangles,
    nodes: (json.nodes ?? []).map(node => node.name).filter(name => typeof name === 'string'),
    animations: (json.animations ?? []).map(animation => animation.name ?? ''),
    images,
    bounds: boundsOf(json),
    skinned: (json.skins ?? []).length > 0,
  };
}

export async function readAsset(file) {
  const buffer = await readFile(file);
  return { buffer, stats: assetStats(buffer) };
}

"""Create the compact runtime neon tetra GLB from the preserved photo source.

Only colour and normal textures are retained. Metallic/roughness textures and the
unsupported specular extension are removed: neon tetras are dielectric wet skin,
not metal. Geometry is deliberately unchanged in this pass so orientation and
fin integrity can be audited before any destructive decimation.
"""
from __future__ import annotations

import io
import json
from pathlib import Path
import struct

from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
SOURCE = Path(__file__).resolve().parent / "source" / "neon-tetra-photo-base.glb"
TARGET = ROOT / "assets" / "p2-src" / "neon-tetra.glb"
COLOUR_PREVIEW = Path(__file__).resolve().parent / "source" / "neon-tetra-basecolor-512.jpg"
NORMAL_PREVIEW = Path(__file__).resolve().parent / "source" / "neon-tetra-normal-256.jpg"


def read_glb(path: Path):
    data = path.read_bytes()
    magic, version, total = struct.unpack_from("<4sII", data, 0)
    if magic != b"glTF" or version != 2 or total != len(data):
        raise ValueError("Invalid GLB source")
    offset = 12
    document = None
    binary = None
    while offset < len(data):
        length, kind = struct.unpack_from("<II", data, offset)
        chunk = data[offset + 8:offset + 8 + length]
        if kind == 0x4E4F534A:
            document = json.loads(chunk.decode("utf-8"))
        elif kind == 0x004E4942:
            binary = chunk
        offset += 8 + length
    if document is None or binary is None:
        raise ValueError("Incomplete GLB source")
    return document, binary


def bake_node_rotations(document, binary):
    """Bake mesh-node rotations into vertex data so local space is anatomical space.

    The generated asset uses local -Z as dorsal and a 90-degree X node rotation.
    Leaving that transform on the node makes spatial fin classification read the
    thickness axis as height. The source has one mesh node; this routine also
    handles any additional mesh nodes with a quaternion rotation.
    """
    for node in document.get("nodes", []):
        if node.get("mesh") is None or "rotation" not in node:
            continue
        qx, qy, qz, qw = node["rotation"]

        def rotate(x, y, z):
            # Efficient quaternion rotation: v + 2*w*(qxyz x v) + 2*(qxyz x (qxyz x v)).
            tx = 2.0 * (qy * z - qz * y)
            ty = 2.0 * (qz * x - qx * z)
            tz = 2.0 * (qx * y - qy * x)
            return (
                x + qw * tx + qy * tz - qz * ty,
                y + qw * ty + qz * tx - qx * tz,
                z + qw * tz + qx * ty - qy * tx,
            )

        for mesh_index in {node["mesh"]}:
            for primitive in document["meshes"][mesh_index]["primitives"]:
                for attribute in ("POSITION", "NORMAL"):
                    accessor_index = primitive["attributes"].get(attribute)
                    if accessor_index is None:
                        continue
                    accessor = document["accessors"][accessor_index]
                    view = document["bufferViews"][accessor["bufferView"]]
                    start = view.get("byteOffset", 0) + accessor.get("byteOffset", 0)
                    stride = view.get("byteStride", 12)
                    rotated = []
                    for index in range(accessor["count"]):
                        offset = start + index * stride
                        value = rotate(*struct.unpack_from("<fff", binary, offset))
                        struct.pack_into("<fff", binary, offset, *value)
                        rotated.append(value)
                    if attribute == "POSITION":
                        accessor["min"] = [min(v[axis] for v in rotated) for axis in range(3)]
                        accessor["max"] = [max(v[axis] for v in rotated) for axis in range(3)]
        node.pop("rotation", None)


def extract_image(document, binary, image_index):
    image = document["images"][image_index]
    view = document["bufferViews"][image["bufferView"]]
    start = view.get("byteOffset", 0)
    return Image.open(io.BytesIO(binary[start:start + view["byteLength"]])).convert("RGB")


def encode(image, size, path):
    resized = image.resize((size, size), Image.Resampling.LANCZOS)
    resized.save(path, quality=91, optimize=True, subsampling=1)
    stream = io.BytesIO()
    resized.save(stream, format="JPEG", quality=91, optimize=True, subsampling=1)
    return stream.getvalue()


def main():
    document, binary = read_glb(SOURCE)
    binary = bytearray(binary)
    bake_node_rotations(document, binary)
    material = document["materials"][0]
    colour_source = material["pbrMetallicRoughness"]["baseColorTexture"]["index"]
    normal_source = material["normalTexture"]["index"]
    colour_texture = document["textures"][colour_source]["source"]
    normal_texture = document["textures"][normal_source]["source"]
    colour = encode(extract_image(document, binary, colour_texture), 512, COLOUR_PREVIEW)
    normal = encode(extract_image(document, binary, normal_texture), 256, NORMAL_PREVIEW)

    # Keep the four geometry bufferViews byte-for-byte; replace only image data.
    views = [dict(view) for view in document["bufferViews"][:4]]
    output = bytearray(binary[:views[-1].get("byteOffset", 0) + views[-1]["byteLength"]])
    while len(output) % 4:
        output.append(0)
    for payload in (normal, colour):
        views.append({"buffer": 0, "byteOffset": len(output), "byteLength": len(payload)})
        output.extend(payload)
        while len(output) % 4:
            output.append(0)
    document["bufferViews"] = views
    document["buffers"] = [{"byteLength": len(output)}]
    document["images"] = [
        {"bufferView": 4, "mimeType": "image/jpeg", "name": "neon-tetra-normal-256"},
        {"bufferView": 5, "mimeType": "image/jpeg", "name": "neon-tetra-basecolor-512"},
    ]
    document["samplers"] = [{"magFilter": 9729, "minFilter": 9987, "wrapS": 10497, "wrapT": 10497}]
    document["textures"] = [{"sampler": 0, "source": 0}, {"sampler": 0, "source": 1}]
    pbr = material["pbrMetallicRoughness"]
    pbr.clear()
    pbr.update({
        "baseColorTexture": {"index": 1},
        "metallicFactor": 0.0,
        "roughnessFactor": 0.58,
    })
    material["normalTexture"] = {"index": 0, "scale": 0.65}
    material["doubleSided"] = True
    material.pop("extensions", None)
    document.pop("extensionsUsed", None)
    document.pop("extensionsRequired", None)
    document["asset"]["generator"] = "DSH neon tetra multi-view source / compact PBR pass"

    encoded = json.dumps(document, separators=(",", ":")).encode("utf-8")
    encoded += b" " * ((-len(encoded)) % 4)
    total = 12 + 8 + len(encoded) + 8 + len(output)
    result = struct.pack("<4sII", b"glTF", 2, total)
    result += struct.pack("<II", len(encoded), 0x4E4F534A) + encoded
    result += struct.pack("<II", len(output), 0x004E4942) + bytes(output)
    TARGET.write_bytes(result)
    print(f"source={SOURCE.stat().st_size / 1048576:.2f} MiB")
    print(f"target={TARGET} bytes={len(result)} KiB={len(result) / 1024:.1f}")
    print("colour=512x512 JPEG normal=256x256 JPEG metalness=0 roughness=0.58")


if __name__ == "__main__":
    main()

"""照片重建小丑鱼贴图调色：把淡粉/灰橙提回参考照片的饱和橙色。

只处理暖色像素：
  - 白带（r≈g≈b）保持中性；
  - 黑色鳍缘（低亮度）不参与；
  - 偏白的体侧/额头高光只要仍偏暖，就按橙色提高饱和度，避免整条鱼呈粉灰色。

输入：scripts/clownfish/source/clownfish-photo-base.glb
输出：assets/p2-src/clownfish-ocellaris.glb

运行：python scripts/clownfish/polish_photo.py
"""
from __future__ import annotations

import colorsys
import io
import json
import struct
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "scripts" / "clownfish" / "source" / "clownfish-photo-base.glb"
TARGET = ROOT / "assets" / "p2-src" / "clownfish-ocellaris.glb"

raw = SOURCE.read_bytes()
json_length = struct.unpack_from("<I", raw, 12)[0]
gltf = json.loads(raw[20:20 + json_length])
bin_header = 20 + json_length
bin_length = struct.unpack_from("<I", raw, bin_header)[0]
bin_data = raw[bin_header + 8:bin_header + 8 + bin_length]
views = gltf["bufferViews"]
image_views = {image["bufferView"] for image in gltf.get("images", [])}
chunks: list[bytes] = []


def append(data: bytes) -> int:
    while sum(map(len, chunks)) % 4:
        chunks.append(b"\0")
    offset = sum(map(len, chunks))
    chunks.append(data)
    return offset


new_views = []
remap = {}
for old_index, view in enumerate(views):
    if old_index in image_views:
        continue
    view = dict(view)
    start = view.get("byteOffset", 0)
    data = bin_data[start:start + view["byteLength"]]
    view["byteOffset"] = append(data)
    view["buffer"] = 0
    remap[old_index] = len(new_views)
    new_views.append(view)

for accessor in gltf.get("accessors", []):
    if "bufferView" in accessor:
        accessor["bufferView"] = remap[accessor["bufferView"]]

new_images = []
for image in gltf.get("images", []):
    view = views[image["bufferView"]]
    start = view.get("byteOffset", 0)
    payload = bin_data[start:start + view["byteLength"]]
    decoded = Image.open(io.BytesIO(payload)).convert("RGB")

    if image.get("mimeType") == "image/jpeg":
        pixels = list(decoded.get_flattened_data() if hasattr(decoded, "get_flattened_data") else decoded.getdata())
        cleaned = []
        warm_pixels = 0
        for r, g, b in pixels:
            high = max(r, g, b)
            # 白带与黑边排除；只提高暖色像素（含照片烘焙出的淡粉高光）。
            if high > 88 and r == high and r - g >= 6:
                h, s, v = colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)
                if 0.015 <= h <= 0.13:
                    warm_pixels += 1
                    s = min(0.84, max(s, 0.60))
                    v = max(v, 0.66)
                    rr, gg, bb = colorsys.hsv_to_rgb(h, s, v)
                    r, g, b = round(rr * 255), round(gg * 255), round(bb * 255)
            cleaned.append((r, g, b))
        decoded.putdata(cleaned)
        print("warm pixels saturated", warm_pixels)
        output = io.BytesIO()
        decoded.save(output, format="JPEG", quality=92, optimize=True, subsampling=1)
        encoded = output.getvalue()
        mime = "image/jpeg"
    else:
        output = io.BytesIO()
        decoded.save(output, format="PNG", optimize=True)
        encoded = output.getvalue()
        mime = "image/png"

    new_views.append({
        "buffer": 0,
        "byteOffset": append(encoded),
        "byteLength": len(encoded),
    })
    new_images.append({
        "bufferView": len(new_views) - 1,
        "mimeType": mime,
        "name": image.get("name"),
    })
    print("image", image.get("name"), decoded.size, len(encoded), mime)

gltf["images"] = new_images
gltf["bufferViews"] = new_views
gltf["buffers"] = [{"byteLength": sum(map(len, chunks))}]

binary = b"".join(chunks)
binary += b"\0" * ((-len(binary)) % 4)
encoded_json = json.dumps(gltf, separators=(",", ":")).encode("utf-8")
encoded_json += b" " * ((-len(encoded_json)) % 4)
total = 12 + 8 + len(encoded_json) + 8 + len(binary)
result = struct.pack("<4sII", b"glTF", 2, total)
result += struct.pack("<II", len(encoded_json), 0x4E4F534A) + encoded_json
result += struct.pack("<II", len(binary), 0x004E4942) + binary
TARGET.write_bytes(result)
print("written", TARGET, len(result))

"""
程序化眼斑双锯鱼（小丑鱼）资产生成器。

设计目标（对应 docs/P2-入缸标准.md 第 4/5/6 节）：
  * 解剖：鲈形目式的深体、钝吻、高眼位、11 根背鳍棘的连续背鳍、圆尾。
  * 表面：一份 1024x512 图集，三条白带按体轴解析绘制，黑边贴在白带外侧，
    鳍条、鳍膜、眼窝、鳃盖线都在图集里画，不依赖照片投影。
  * 泳姿：几何按"体轴坐标 + 鳍根坐标"生成，供顶点着色器做真正的脊柱弯曲
    （截面跟着旋转，而不是横向剪切）与鳍的铰接摆动。

运行：<python> scripts/clownfish/build_clownfish.py
产出：scripts/clownfish/alternates/clownfish-procedural.glb（备选，不覆盖正式资产）
      scripts/clownfish/alternates/clownfish-procedural-atlas.png（图集预览）
坐标：X = 体长轴（头在 -X 端），Y = 背腹轴（背为 +），Z = 侧向。
几何单位：全长的 1.0（含尾鳍），入缸时由 fish.js 重标定到 targetLength。
"""

from __future__ import annotations

import io
import json
import math
import struct
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

ROOT = Path(__file__).resolve().parents[2]
ASSETS = ROOT / "assets" / "p2-src"
# 正式资产是照片重建版。程序化生成器只产出备选，不能覆盖正式 GLB。
TARGET = ROOT / "scripts" / "clownfish" / "alternates" / "clownfish-procedural.glb"
ATLAS_PREVIEW = TARGET.with_name("clownfish-procedural-atlas.png")

# ---------------------------------------------------------------- 基本参数
BODY_LEN = 0.780          # 吻端到尾柄末端的长度（全长约 0.97）
TOTAL_LEN = 0.97
ATLAS_W, ATLAS_H = 1024, 512
BODY_RECT = (0, 0, 680, 512)
FIN_RECTS = {
    "dorsal": (688, 0, 1024, 100),
    "anal": (688, 104, 1024, 204),
    "caudal": (688, 208, 1024, 308),
    "pectoral": (688, 312, 1024, 412),
    "pelvic": (688, 416, 1024, 512),
}


def smoothstep(a, b, x):
    t = np.clip((x - a) / (b - a), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def smoothstep_s(x, a, b):
    t = max(0.0, min(1.0, (x - a) / (b - a)))
    return t * t * (3.0 - 2.0 * t)


def mix(a, b, t):
    return a + (b - a) * t


# ---------------------------------------------------------------- 体形剖面
# 控制点经高斯平滑后采样；所有数值都是全长的比例。
PROFILE_X = np.array([0.000, 0.020, 0.050, 0.090, 0.130, 0.175, 0.235, 0.310,
                      0.390, 0.465, 0.545, 0.615, 0.675, 0.710, 0.740, 0.762, 0.775, 0.780])
PROFILE_TOP = np.array([0.022, 0.056, 0.092, 0.120, 0.138, 0.146, 0.152, 0.159,
                        0.161, 0.162, 0.158, 0.148, 0.129, 0.105, 0.079, 0.043, 0.020, 0.008])
PROFILE_BOT = np.array([-0.022, -0.050, -0.078, -0.110, -0.122, -0.128, -0.148, -0.162,
                        -0.170, -0.172, -0.164, -0.150, -0.130, -0.104, -0.078, -0.044, -0.021, -0.008])
PROFILE_HALF = np.array([0.005, 0.015, 0.025, 0.036, 0.042, 0.047, 0.052, 0.058,
                         0.062, 0.063, 0.061, 0.056, 0.049, 0.040, 0.031, 0.022, 0.013, 0.006])


def _build_curve(values, n=16384, sigma=0.0035):
    xs = np.linspace(0.0, BODY_LEN, n)
    ys = np.interp(xs, PROFILE_X, values)
    # 高斯平滑：分段线性插值会留下折线，顶点法线会读出棱角
    radius = max(1, int(sigma / (BODY_LEN / (n - 1))))
    kx = np.arange(-radius, radius + 1)
    kernel = np.exp(-0.5 * (kx / (radius / 2.2)) ** 2)
    kernel /= kernel.sum()
    padded = np.pad(ys, radius, mode="edge")
    return xs, np.convolve(padded, kernel, mode="same")[radius:-radius]


XS, TOP_C = _build_curve(PROFILE_TOP)
_, BOT_C = _build_curve(PROFILE_BOT)
_, HALF_C = _build_curve(PROFILE_HALF)


def profile(x):
    """返回 (背线 y, 腹线 y, 半宽)。"""
    x = min(max(x, 0.0), BODY_LEN)
    top = float(np.interp(x, XS, TOP_C))
    bot = float(np.interp(x, XS, BOT_C))
    half = float(np.interp(x, XS, HALF_C))
    return top, bot, half


def section_center(x):
    top, bot, _ = profile(x)
    return (top + bot) * 0.5


# ---------------------------------------------------------------- 网格容器
class Mesh:
    def __init__(self, name, material):
        self.name = name
        self.material = material
        self.pos: list[tuple[float, float, float]] = []
        self.uv: list[tuple[float, float]] = []
        self.tris: list[tuple[int, int, int]] = []

    def vertex(self, p, uv):
        self.pos.append((float(p[0]), float(p[1]), float(p[2])))
        self.uv.append((float(uv[0]), float(uv[1])))
        return len(self.pos) - 1

    def tri(self, a, b, c):
        self.tris.append((a, b, c))

    def quad(self, a, b, c, d):
        self.tri(a, b, c)
        self.tri(a, c, d)

    def signed_volume(self):
        p = np.array(self.pos, dtype=np.float64)
        t = np.array(self.tris, dtype=np.int64)
        v0, v1, v2 = p[t[:, 0]], p[t[:, 1]], p[t[:, 2]]
        return float(np.einsum("ij,ij->i", v0, np.cross(v1, v2)).sum() / 6.0)

    def normals(self):
        p = np.asarray(self.pos, dtype=np.float64)
        n = np.zeros_like(p)
        for a, b, c in self.tris:
            v0, v1, v2 = p[a], p[b], p[c]
            fn = np.cross(v1 - v0, v2 - v0)
            n[a] += fn
            n[b] += fn
            n[c] += fn
        length = np.linalg.norm(n, axis=1, keepdims=True)
        n = np.divide(n, np.maximum(length, 1e-12))
        # 缝线/极点处位置重合的顶点共享法线，避免一道亮度接缝
        keys = np.round(p / 1e-5).astype(np.int64)
        buckets = {}
        for i, key in enumerate(map(tuple, keys)):
            buckets.setdefault(key, []).append(i)
        for group in buckets.values():
            if len(group) > 1:
                avg = n[group].sum(axis=0)
                ln = np.linalg.norm(avg)
                if ln > 1e-9:
                    n[group] = avg / ln
        return n


# ---------------------------------------------------------------- 图集体坐标
def body_uv(u, v):
    x0, y0, x1, y1 = BODY_RECT
    # v=0 是背中线；整体平移半圈，把图集接缝藏到腹中线（被臀鳍/腹鳍挡住）
    return ((x0 + u * (x1 - x0)) / ATLAS_W, (y0 + ((v + 0.5) % 1.0) * (y1 - y0)) / ATLAS_H)


def fin_uv(rect, s, q):
    x0, y0, x1, y1 = rect
    return ((x0 + s * (x1 - x0)) / ATLAS_W, (y0 + q * (y1 - y0)) / ATLAS_H)


# ---------------------------------------------------------------- 身体
def sculpt_displacement(x, y, z):
    """体表雕刻：沿法线的位移（模型单位）。只雕大形体，细节交给法线贴图。"""
    top, bot, half = profile(x)
    yc = (top + bot) * 0.5
    hh = max(1e-4, (top - bot) * 0.5)
    h = (y - yc) / hh
    side_mask = smoothstep_s(abs(z), 0.010, 0.030)

    d = 0.0
    # 鳃盖骨：一整块微微鼓起，后缘一道深沟，前沿一道低脊
    plate = smoothstep_s(x, 0.160, 0.185) * (1.0 - smoothstep_s(x, 0.250, 0.272))
    plate *= 1.0 - smoothstep_s(abs(h), 0.50, 0.70)
    d += 0.0065 * plate
    crease = math.exp(-((x - 0.262) / 0.0080) ** 2) * (1.0 - smoothstep_s(abs(h), 0.42, 0.64))
    d -= 0.0105 * crease
    d += 0.0016 * math.exp(-((x - 0.238) / 0.009) ** 2) * (1.0 - smoothstep_s(abs(h), 0.40, 0.62))

    # 眼窝：一圈凸起的眶缘 + 内侧下陷
    dist = math.hypot(x - 0.082, y - 0.046)
    rim = math.exp(-((dist - 0.044) / 0.0080) ** 2)
    socket = 1.0 - smoothstep_s(dist, 0.026, 0.040)
    d += (0.0038 * rim - 0.0028 * socket) * side_mask

    # 唇：上唇 + 下唇两道脊，中间一道缝
    mouth = 1.0 - smoothstep_s(x, 0.030, 0.060)
    d -= 0.0026 * math.exp(-((y + 0.017) / 0.0050) ** 2) * mouth
    d += 0.0025 * math.exp(-((y + 0.008) / 0.0064) ** 2) * mouth
    d += 0.0030 * math.exp(-((y + 0.028) / 0.0074) ** 2) * mouth

    # 眉弓与下颌
    d += 0.0032 * math.exp(-((x - 0.078) / 0.022) ** 2) * math.exp(-((y - 0.078) / 0.012) ** 2)
    d += 0.0038 * math.exp(-((x - 0.050) / 0.026) ** 2) * math.exp(-((y + 0.052) / 0.014) ** 2)

    # 颊部与胸鳍肩
    d += 0.0026 * math.exp(-((x - 0.140) / 0.045) ** 2) * math.exp(-((h + 0.10) / 0.35) ** 2)
    d += 0.0030 * math.exp(-((x - 0.290) / 0.028) ** 2) * math.exp(-((h + 0.05) / 0.28) ** 2)

    # 肌节：极浅的横向起伏，让体侧在掠射光下有肌肉块
    d += 0.0007 * math.sin((x / BODY_LEN) * math.pi * 2 * 12 + h * 1.4) \
        * (1.0 - smoothstep_s(x, 0.60, 0.76)) * (1.0 - smoothstep_s(abs(h), 0.72, 0.96))

    # 鼻孔
    d -= 0.0015 * math.exp(-((x - 0.050) / 0.0052) ** 2 - ((y - 0.012) / 0.0042) ** 2) * side_mask

    # 背鳍 / 臀鳍根的隆起
    d += 0.0022 * math.exp(-((x - 0.45) / 0.22) ** 2) * math.exp(-((h - 0.96) / 0.05) ** 2)
    d += 0.0014 * math.exp(-((x - 0.62) / 0.10) ** 2) * math.exp(-((h + 0.96) / 0.05) ** 2)

    # 尾柄前一环浅沟，尾鳍接得更自然
    d -= 0.0014 * math.exp(-((x - 0.742) / 0.007) ** 2) * (1.0 - smoothstep_s(abs(h), 0.55, 0.85))
    return d


def build_body():
    mesh = Mesh("Body", "Body")
    # 雕刻底模：比之前密一倍多，才托得住鳃盖/唇/眼窝这些体块
    rings = 100
    around = 48
    ts = np.linspace(0.0, 1.0, rings + 1)
    # 余弦分布：头尾环密、体侧稀，弯折时鼻端与尾柄都不会出多边形棱
    xs = BODY_LEN * 0.5 * (1.0 - np.cos(np.pi * ts))
    ring_ids = []
    for x in xs:
        top, bot, half = profile(x)
        yc = (top + bot) * 0.5
        hh = (top - bot) * 0.5
        ids = []
        for j in range(around + 1):
            phi = 2.0 * math.pi * j / around
            c, s = math.cos(phi), math.sin(phi)
            y = yc + hh * c
            z = half * s * (1.0 - 0.17 * c)
            ids.append(mesh.vertex((x, y, z), body_uv(x / BODY_LEN, j / around)))
        ring_ids.append(ids)

    for i in range(rings):
        a, b = ring_ids[i], ring_ids[i + 1]
        for j in range(around):
            mesh.quad(a[j], b[j], b[j + 1], a[j + 1])

    # 两端封口
    for ring, x, flip in ((ring_ids[0], 0.0, True), (ring_ids[-1], BODY_LEN, False)):
        top, bot, _ = profile(x)
        center = mesh.vertex((x, (top + bot) * 0.5, 0.0), body_uv(x / BODY_LEN, 0.5))
        for j in range(around):
            if flip:
                mesh.tri(center, ring[j + 1], ring[j])
            else:
                mesh.tri(center, ring[j], ring[j + 1])
    if mesh.signed_volume() < 0:
        mesh.tris = [(a, c, b) for a, b, c in mesh.tris]

    # 大形体雕刻：沿顶点法线推拉，再重新算法线
    normals = mesh.normals()
    for i, (px, py, pz) in enumerate(mesh.pos):
        d = sculpt_displacement(px, py, pz)
        if abs(d) > 1e-7:
            mesh.pos[i] = (
                px + normals[i][0] * d,
                py + normals[i][1] * d,
                pz + normals[i][2] * d,
            )
    return mesh


# ---------------------------------------------------------------- 鳍
def build_strip_fin(name, x0, x1, base_side, height_fn, rays, lean, rect,
                    n=42, m=12, corr=0.0024, sink=0.004):
    """沿背/腹线生长的连续鳍（背鳍、臀鳍）。"""
    mesh = Mesh(name, "Fin")
    cols = []
    for i in range(n + 1):
        s = i / n
        x = x0 + (x1 - x0) * s
        top, bot, _ = profile(x)
        base_y = top - sink if base_side > 0 else bot + sink
        h = height_fn(s)
        col = []
        for j in range(m + 1):
            q = j / m
            y = base_y + base_side * h * q
            # 鳍条呈放射状后掠；膜面有轻微波浪，光扫过时才有鳍条感
            xoff = lean * h * (q ** 1.45) * (0.35 + 0.65 * s)
            z = corr * math.sin(2.0 * math.pi * rays * s) * (q ** 1.15)
            col.append(mesh.vertex((x + xoff, y, z), fin_uv(rect, s, q)))
        cols.append(col)
    for i in range(n):
        for j in range(m):
            mesh.quad(cols[i][j], cols[i + 1][j], cols[i + 1][j + 1], cols[i][j + 1])
    return mesh


def build_fan_fin(name, center, axis_u, axis_v, normal, a0, a1, r_in, r_out,
                  rays, corr, rect, n=36, m=12, camber=0.0, yaw=0.0):
    """扇形鳍（尾鳍、胸鳍、腹鳍）。a0..a1 是鳍面内的张角。

    yaw：整个鳍面绕 Y 轴外旋，让鳍从体侧"张出去"。没有它，胸鳍会几乎贴着
    体表，和身体相交成一条难看的轮廓线。
    """
    mesh = Mesh(name, "Fin")
    cu = np.array(axis_u, dtype=float)
    cv = np.array(axis_v, dtype=float)
    nz = np.array(normal, dtype=float)
    cu /= np.linalg.norm(cu)
    cv /= np.linalg.norm(cv)
    nz /= np.linalg.norm(nz)
    center = np.array(center, dtype=float)
    cy, sy = math.cos(yaw), math.sin(yaw)
    cols = []
    for i in range(n + 1):
        s = i / n
        a = math.radians(mix(a0, a1, s))
        d = math.cos(a) * cu + math.sin(a) * cv
        edge = r_out(s)
        col = []
        for j in range(m + 1):
            q = j / m
            r = r_in + (edge - r_in) * q
            p = center + d * r
            p = p + nz * (camber * math.sin(math.pi * q) * (0.4 + 0.6 * s)
                          + corr * math.sin(2.0 * math.pi * rays * s) * (q ** 1.2))
            # 尾缘做成轻微的扇贝形，避免机器切割感
            col.append(mesh.vertex(p, fin_uv(rect, s, q)))
        cols.append(col)
    if yaw:
        for i in range(len(mesh.pos)):
            x, y, z = mesh.pos[i]
            dx, dz = x - center[0], z - center[2]
            mesh.pos[i] = (center[0] + dx * cy + dz * sy, y, center[2] - dx * sy + dz * cy)
    for i in range(n):
        for j in range(m):
            mesh.quad(cols[i][j], cols[i + 1][j], cols[i + 1][j + 1], cols[i][j + 1])
    return mesh


def build_caudal_fin():
    """尾鳍：鳍基是竖直短线而不是一个点，尾柄收细后正好被这块膜包住。"""
    mesh = Mesh("CaudalFin", "Fin")
    rect = FIN_RECTS["caudal"]
    n, m = 36, 12
    base_x = 0.762
    center_y = section_center(base_x)
    base_half = 0.041
    cols = []
    for i in range(n + 1):
        s = i / n
        base = np.array([base_x, center_y + (s - 0.5) * 2.0 * base_half, 0.0])
        a = math.radians(mix(-39.0, 39.0, s))
        d = np.array([math.cos(a), math.sin(a), 0.0])
        # 中央略长、上下两端回收，形成参考图的圆扇形而不是三角板。
        length = 0.176 * (0.88 + 0.12 * math.cos(a))
        col = []
        for j in range(m + 1):
            q = j / m
            p = base + d * (length * q)
            p[2] += 0.0024 * math.sin(2.0 * math.pi * 18 * s) * (q ** 1.2) + 0.004 * math.sin(math.pi * q)
            col.append(mesh.vertex(p, fin_uv(rect, s, q)))
        cols.append(col)
    for i in range(n):
        for j in range(m):
            mesh.quad(cols[i][j], cols[i + 1][j], cols[i + 1][j + 1], cols[i][j + 1])
    return mesh


def build_fins():
    fins = []

    # 背鳍分成两片：前段棘鳍高而尖，后段软鳍低而圆，中间留一道凹口。
    # 参考图里最高的一片在头带上方（前段），不是在后段。
    def spinous_h(s):
        x = mix(0.290, 0.512, s)
        pts_x = np.array([0.290, 0.330, 0.375, 0.425, 0.470, 0.512])
        pts_h = np.array([0.000, 0.060, 0.092, 0.098, 0.090, 0.000])
        return float(np.interp(x, pts_x, pts_h))

    def soft_h(s):
        x = mix(0.522, 0.775, s)
        pts_x = np.array([0.522, 0.555, 0.600, 0.645, 0.690, 0.730, 0.760, 0.775])
        pts_h = np.array([0.000, 0.043, 0.066, 0.074, 0.070, 0.057, 0.032, 0.000])
        return float(np.interp(x, pts_x, pts_h))

    spinous = build_strip_fin("DorsalFin", 0.290, 0.512, +1, spinous_h, rays=11, lean=0.08,
                              rect=FIN_RECTS["dorsal"], corr=0.0020, n=30, m=10)
    soft = build_strip_fin("DorsalFin", 0.522, 0.775, +1, soft_h, rays=15, lean=0.12,
                           rect=FIN_RECTS["dorsal"], corr=0.0022, n=34, m=11)
    fins.append(merge_meshes("DorsalFin", "Fin", [spinous, soft]))

    # 臀鳍
    def anal_h(s):
        x = mix(0.530, 0.762, s)
        pts_x = np.array([0.530, 0.565, 0.610, 0.655, 0.700, 0.735, 0.762])
        pts_h = np.array([0.000, 0.042, 0.070, 0.082, 0.070, 0.038, 0.000])
        return float(np.interp(x, pts_x, pts_h))

    fins.append(build_strip_fin("AnalFin", 0.530, 0.762, -1, anal_h, rays=12, lean=-0.07,
                                rect=FIN_RECTS["anal"], corr=0.0018, n=34, m=11))

    # 尾鳍：竖直的鳍基 + 扇形尾缘，基部完全盖住收细的尾柄，不留断口
    fins.append(build_caudal_fin())

    # 胸鳍：左右各一，共用一张图集岛，着色器里靠 z 的符号区分左右
    pectoral_parts = []
    for sign in (1.0, -1.0):
        tilt = math.radians(42.0)
        # 鳍面法线朝体外侧；u 轴指向体后，v 轴由法线叉乘得到，保证正交
        normal = np.array([0.0, -math.sin(math.radians(9.0)), math.cos(math.radians(9.0)) * sign])
        cu = np.array([math.cos(tilt), -0.20, 0.0])
        cu = cu - normal * np.dot(cu, normal)
        cu /= np.linalg.norm(cu)
        cv = np.cross(normal, cu)
        center = (0.290, 0.000, 0.0480 * sign)
        pectoral_parts.append(build_fan_fin(
            "PectoralFins", center, cu, cv, normal, -72.0, 38.0, 0.010,
            lambda s: 0.165 * (0.92 + 0.08 * math.cos(math.radians(mix(-72, 38, s)))),
            rays=14, corr=0.0019, camber=0.004, rect=FIN_RECTS["pectoral"], n=28, m=10,
            yaw=-sign * math.radians(30.0),
        ))
    fins.append(merge_meshes("PectoralFins", "Fin", pectoral_parts))

    # 腹鳍：挂在腹部，鳍面近竖直，向后下方张开
    pelvic_parts = []
    for sign in (1.0, -1.0):
        normal = np.array([0.0, math.cos(math.radians(46.0)), math.sin(math.radians(46.0)) * sign])
        cu = np.array([0.62, -0.78, 0.0])
        cu = cu - normal * np.dot(cu, normal)
        cu /= np.linalg.norm(cu)
        cv = np.cross(normal, cu)
        center = (0.330, -0.140, 0.024 * sign)
        pelvic_parts.append(build_fan_fin(
            "PelvicFins", center, cu, cv, normal, -72.0, 26.0, 0.008,
            lambda s: 0.125 * (0.9 + 0.1 * math.cos(math.radians(mix(-72, 26, s)))),
            rays=10, corr=0.0016, camber=0.003, rect=FIN_RECTS["pelvic"], n=22, m=9,
            yaw=-sign * math.radians(10.0),
        ))
    fins.append(merge_meshes("PelvicFins", "Fin", pelvic_parts))
    return fins


def merge_meshes(name, material, meshes):
    out = Mesh(name, material)
    for mesh in meshes:
        offset = len(out.pos)
        out.pos.extend(mesh.pos)
        out.uv.extend(mesh.uv)
        out.tris.extend((a + offset, b + offset, c + offset) for a, b, c in mesh.tris)
    return out


# ---------------------------------------------------------------- 眼睛
def build_eyes():
    mesh = Mesh("Eyes", "Eye")
    cx, cy = 0.082, 0.046
    r = 0.034
    squash = 0.74
    for sign in (1.0, -1.0):
        cz = 0.016 * sign
        nl, nm = 12, 16
        grid = []
        for i in range(nl + 1):
            theta = math.pi * i / nl
            row = []
            for j in range(nm + 1):
                phi = 2.0 * math.pi * j / nm
                x = cx + r * math.sin(theta) * math.cos(phi)
                y = cy + r * math.sin(theta) * math.sin(phi)
                z = cz + sign * r * squash * math.cos(theta)
                row.append(mesh.vertex((x, y, z), (j / nm, i / nl)))
            grid.append(row)
        for i in range(nl):
            for j in range(nm):
                a, b = grid[i][j], grid[i][j + 1]
                c, d = grid[i + 1][j + 1], grid[i + 1][j]
                if sign > 0:
                    mesh.quad(a, b, c, d)
                else:
                    mesh.quad(d, c, b, a)
    if mesh.signed_volume() < 0:
        mesh.tris = [(a, c, b) for a, b, c in mesh.tris]
    return mesh


# ---------------------------------------------------------------- 贴图
def value_noise(x, y, z, seed=0):
    """无缝三维值噪声：坐标用 (u, cos φ, sin φ)，绕体一圈天然连续。"""
    def h(i, j, k):
        n = np.sin(i * 127.1 + j * 311.7 + k * 74.7 + seed * 43.3) * 43758.5453
        return n - np.floor(n)

    xi, yi, zi = np.floor(x), np.floor(y), np.floor(z)
    xf, yf, zf = x - xi, y - yi, z - zi
    u = xf * xf * (3 - 2 * xf)
    v = yf * yf * (3 - 2 * yf)
    w = zf * zf * (3 - 2 * zf)
    acc = 0.0
    for dx in (0, 1):
        wx = u if dx else 1 - u
        for dy in (0, 1):
            wy = v if dy else 1 - v
            for dz in (0, 1):
                wz = w if dz else 1 - w
                acc = acc + h(xi + dx, yi + dy, zi + dz) * wx * wy * wz
    return acc


def fbm(x, y, z, octaves=4, seed=0):
    total = np.zeros_like(x)
    amp = 0.5
    freq = 1.0
    for o in range(octaves):
        total += amp * value_noise(x * freq, y * freq, z * freq, seed + o)
        freq *= 2.1
        amp *= 0.5
    return total


def build_atlas():
    W, H = ATLAS_W, ATLAS_H
    rgb = np.zeros((H, W, 3), dtype=np.float64)
    rgb[:] = (0.20, 0.20, 0.20)

    # ---------------- 身体
    x0, y0, x1, y1 = BODY_RECT
    bw, bh = x1 - x0, y1 - y0
    uu = (np.arange(bw) + 0.5) / bw
    vv = (np.arange(bh) + 0.5) / bh
    U, V = np.meshgrid(uu, vv)
    # 图集的 V 与几何的 φ 相差半圈：几何的接缝在腹侧，U/V 在这里保持"0=背"的语义
    V = (V + 0.5) % 1.0
    phi = 2.0 * np.pi * V
    h = np.cos(phi)
    side = np.sin(phi)

    # 缸内光量高（PMREM + 半球 1.2 + 平行光 1.25），albedo 必须压到暗部；
    # 这里按"渲染后回到 #f07a12 左右"反推的基色，而不是直接抄照片的屏幕颜色。
    back = np.array([0.55, 0.100, 0.001])
    mid = np.array([0.820, 0.200, 0.004])
    belly = np.array([0.950, 0.420, 0.040])
    head = np.array([0.900, 0.280, 0.008])

    t = smoothstep(-0.72, 1.0, h) ** 0.92
    base = belly[None, None, :] + (back - belly)[None, None, :] * t[..., None]
    base = base + (mid - base) * ((1.0 - np.abs(h)) ** 2)[..., None] * 0.55
    head_w = smoothstep(0.26, 0.015, U) * 0.55
    base = base + (head - base) * head_w[..., None]

    # 细颗粒：模拟真鱼皮肤上的色素点，也给白带一点脏旧感
    grain = fbm(U * 26.0, np.cos(phi) * 9.0, np.sin(phi) * 9.0, 4, 1)
    base *= (0.955 + 0.09 * grain)[..., None]

    # 鳞片：交错的浅弧，只压 2~3%，远看是皮肤质感，近看才读成鳞
    rows = 54.0
    gx = U * rows
    gy = V * 30.0 + 0.5 * (np.floor(U * rows) % 2.0)
    cell = np.stack([np.mod(gx, 1.0) - 0.5, np.mod(gy, 1.0) - 0.5], -1)
    scallop = np.sqrt(cell[..., 0] ** 2 * 0.85 + cell[..., 1] ** 2)
    ridge = smoothstep(0.38, 0.50, scallop) * (1.0 - smoothstep(0.50, 0.58, scallop))
    shade_scale = 1.0 - 0.028 * ridge
    base *= shade_scale[..., None]
    # 鳞片中心略暖，边缘略冷，避免一片死橙
    base[..., 0] *= 1.0 + 0.03 * (1.0 - scallop)
    base[..., 2] *= 1.0 - 0.03 * (1.0 - scallop)

    # 背脊压深、腹部提亮：真实鱼体的反荫蔽从背部 15% 就开始
    back_saddle = smoothstep(0.35, 1.0, h)
    base *= (1.0 - 0.22 * back_saddle)[..., None]
    base = base + (np.array([1.0, 0.62, 0.18]) - base) * (smoothstep(-0.05, -0.95, h) * 0.18)[..., None]
    # 上侧线的亮带：让体侧读成一个圆柱，而不是一块橙色贴片
    flank_band = np.exp(-((h - 0.34) / 0.22) ** 2) * (1.0 - smoothstep(0.35, 0.8, U))
    base = base + (np.array([1.0, 0.46, 0.08]) - base) * (flank_band * 0.14)[..., None]
    # 鳍根的环境遮蔽：背鳍/臀鳍下面压暗，鳍才像从身上长出来
    dorsal_ao = np.exp(-((np.abs(V - 0.0)) / 0.035) ** 2) * 0.30
    anal_ao = np.exp(-((np.abs(V - 0.5)) / 0.035) ** 2) * (0.22 * smoothstep(0.55, 0.65, U))
    base *= (1.0 - dorsal_ao - anal_ao)[..., None]
    # 体侧靠后的肌肉块：一条很淡的暖色带，避免大色块
    muscle = smoothstep(0.45, 0.62, U) * (1.0 - smoothstep(0.86, 0.98, U)) * (1.0 - np.abs(h)) ** 3
    base = base + (np.array([1.0, 0.32, 0.05]) - base) * (muscle * 0.10)[..., None]

    # 鳃盖线：从背侧斜向下，末端停在胸鳍根
    gv = np.linspace(0.075, 0.335, 120)
    gu = 0.336 - 0.060 * (gv - 0.075)
    for k in range(len(gv)):
        du = np.abs(U - gu[k])
        w = 0.0026
        m = (1.0 - smoothstep(w * 0.35, w, du)) * np.exp(-((V - gv[k]) / 0.0055) ** 2)
        base *= (1.0 - 0.42 * m[..., None])
    # 鳃盖后缘的高光
    for k in range(len(gv)):
        du = np.abs(U - (gu[k] + 0.007))
        m = (1.0 - smoothstep(0.0015, 0.0045, du)) * np.exp(-((V - gv[k]) / 0.005) ** 2)
        base = base + (np.array([1.0, 0.78, 0.42]) - base) * 0.10 * m[..., None]

    # 眼窝：一圈压暗，让球体眼睛不像贴上去的
    for eye_v in (0.186, 0.814):
        d = np.sqrt(((U - 0.105) / 0.034) ** 2 + ((V - eye_v) / 0.042) ** 2)
        socket = 1.0 - smoothstep(0.72, 1.35, d)
        base *= (1.0 - 0.46 * socket)[..., None]
        lip = smoothstep(1.0, 1.15, d) * (1.0 - smoothstep(1.15, 1.5, d))
        base = base + (np.array([1.0, 0.66, 0.18]) - base) * 0.25 * lip[..., None]

    # 嘴：沿体轴的横缝（不是绕吻端的竖环）+ 下唇亮边
    for mouth_v in (0.330, 0.670):
        du = np.abs(U - 0.026)
        dv = np.abs(V - mouth_v)
        m = (1.0 - smoothstep(0.018, 0.042, du)) * (1.0 - smoothstep(0.004, 0.013, dv))
        base *= (1.0 - 0.80 * m)[..., None]
        # 下唇：缝口下方一道暖亮边，嘴就有了厚度
        lift = (1.0 - smoothstep(0.018, 0.044, du)) * np.exp(-((dv - 0.026) / 0.012) ** 2)
        base = base + (np.array([1.0, 0.78, 0.46]) - base) * 0.38 * lift[..., None]
        # 上唇：缝口上方压一点暖影
        lip = (1.0 - smoothstep(0.018, 0.040, du)) * np.exp(-((dv - 0.016) / 0.010) ** 2)
        base = base + (np.array([1.0, 0.36, 0.06]) - base) * 0.26 * lip[..., None]

    # ---------------- 三条白带
    def band(center, half, bulge, edge_pre, edge_post, widen=0.18, wobble=0.0022, slant=0.0):
        c = center - bulge * smoothstep(0.02, 0.92, h) - slant * h
        c = c + wobble * np.sin(V * 2.0 * np.pi * 2.0 + center * 40.0)
        w = half * (1.0 + widen * (1.0 - np.abs(h))) * (1.0 + 0.04 * np.sin(V * 2.0 * np.pi * 3.0))
        d = U - c
        dist = np.abs(d)
        # 白带内侧轻微压暗，模拟白带边缘的厚度
        inner = 1.0 - smoothstep(w * 0.55, w, dist)
        white = 1.0 - smoothstep(w - 0.0016, w + 0.0016, dist)
        # 黑边：先软后硬，外缘带一点羽化，不像矢量描边
        pre = smoothstep(w - 0.0008, w + 0.0030, dist) * (1.0 - smoothstep(w + edge_pre - 0.0016, w + edge_pre + 0.0020, dist))
        post = smoothstep(w - 0.0008, w + 0.0030, dist) * (1.0 - smoothstep(w + edge_post - 0.0016, w + edge_post + 0.0020, dist))
        black = np.where(d < 0, pre, post)
        # 黑边外侧再压一圈很淡的暗晕，白带不会像贴纸浮在橙色上
        halo = smoothstep(w + edge_pre, w + edge_pre + 0.02, dist) * (1.0 - smoothstep(w + edge_pre + 0.02, w + edge_pre + 0.045, dist))
        halo = np.maximum(halo, smoothstep(w + edge_post, w + edge_post + 0.02, dist) * (1.0 - smoothstep(w + edge_post + 0.02, w + edge_post + 0.045, dist)))
        return white, black, inner * (1.0 - white), halo

    white_total = np.zeros_like(U)
    black_total = np.zeros_like(U)
    shadow_total = np.zeros_like(U)
    halo_total = np.zeros_like(U)
    for center, half, bulge, ep, eq, widen, slant in (
        (0.235, 0.030, 0.000, 0.008, 0.016, 0.18, 0.012),
        (0.600, 0.048, 0.020, 0.018, 0.018, 0.14, 0.016),
        (0.950, 0.024, 0.000, 0.010, 0.012, 0.14, 0.004),
    ):
        w, b, inner, halo = band(center, half, bulge, ep, eq, widen, slant=slant)
        white_total = np.maximum(white_total, w)
        black_total = np.maximum(black_total, b)
        shadow_total = np.maximum(shadow_total, inner)
        halo_total = np.maximum(halo_total, halo)

    white_col = np.array([0.840, 0.830, 0.790])
    black_col = np.array([0.032, 0.038, 0.042])

    # 白带里的冷阴影（背侧、靠黑边处）
    white_shaded = white_col[None, None, :] * (0.90 + 0.10 * smoothstep(-0.4, 0.9, h))[..., None]
    white_shaded = white_shaded * (0.965 + 0.035 * grain[..., None])
    body = base * (1.0 - 0.16 * shadow_total[..., None])
    body = body * (1.0 - 0.10 * halo_total[..., None])
    body = body * (1.0 - black_total[..., None]) + black_col * black_total[..., None]
    body = body * (1.0 - white_total[..., None]) + white_shaded * white_total[..., None]

    rgb[y0:y1, x0:x1] = body

    # ---------------- 鳍
    def paint_fin(rect, top_col, root_col, edge_col, black_at, white_at=None, rays=16, name=""):
        fx0, fy0, fx1, fy1 = rect
        fw, fh = fx1 - fx0, fy1 - fy0
        fu = (np.arange(fw) + 0.5) / fw
        fv = (np.arange(fh) + 0.5) / fh
        FU, FV = np.meshgrid(fu, fv)
        # 根深、缘浅：真鱼鳍是半透明的，边缘会透光变亮
        col = root_col[None, None, :] + (top_col - root_col)[None, None, :] * smoothstep(0.0, 0.72, FV)[..., None]
        col = col + (edge_col - col) * smoothstep(0.62, 1.0, FV)[..., None] * 0.38
        # 鳍条：沿径向的暗线，带一点点偏移避免等距
        ray_phase = FU * rays
        frac = np.mod(ray_phase, 1.0)
        line = 1.0 - smoothstep(0.0, 0.16, np.abs(frac - 0.5) * 2.0 - 0.70)
        col *= (1.0 - 0.09 * line * smoothstep(0.05, 0.55, FV))[..., None]
        # 鳍条之间的亮膜
        col += (np.array([1.0, 0.68, 0.34]) - col) * (0.04 * smoothstep(0.5, 0.95, FV) * line)[..., None]
        # 细颗粒
        n = fbm(FU * 18.0, FV * 7.0, np.zeros_like(FU), 3, 7)
        col *= (0.975 + 0.04 * n)[..., None]
        # 白缘（尾鳍）
        if white_at is not None:
            white = smoothstep(white_at[0], white_at[0] + 0.02, FV) * (1.0 - smoothstep(white_at[1], white_at[1] + 0.02, FV))
            col = col * (1.0 - white[..., None]) + np.array([0.94, 0.93, 0.88])[None, None, :] * white[..., None]
        # 黑缘：从设定位置到边缘全黑，内缘留一条羽化
        black = smoothstep(black_at - 0.02, black_at + 0.015, FV)
        col = col * (1.0 - black[..., None]) + np.array([0.035, 0.045, 0.050])[None, None, :] * black[..., None]
        rgb[fy0:fy1, fx0:fx1] = col

    paint_fin(FIN_RECTS["dorsal"], np.array([0.90, 0.38, 0.035]), np.array([0.60, 0.16, 0.008]),
              np.array([0.98, 0.52, 0.11]), 0.84, rays=17, name="dorsal")
    paint_fin(FIN_RECTS["anal"], np.array([0.88, 0.35, 0.030]), np.array([0.56, 0.14, 0.006]),
              np.array([0.96, 0.48, 0.09]), 0.84, rays=12, name="anal")
    paint_fin(FIN_RECTS["caudal"], np.array([0.92, 0.40, 0.035]), np.array([0.62, 0.17, 0.008]),
              np.array([0.99, 0.56, 0.13]), 0.88, white_at=(0.84, 0.88), rays=18, name="caudal")
    paint_fin(FIN_RECTS["pectoral"], np.array([0.90, 0.40, 0.045]), np.array([0.58, 0.16, 0.008]),
              np.array([0.97, 0.54, 0.14]), 0.86, rays=14, name="pectoral")
    paint_fin(FIN_RECTS["pelvic"], np.array([0.86, 0.32, 0.028]), np.array([0.54, 0.13, 0.005]),
              np.array([0.93, 0.46, 0.08]), 0.87, rays=10, name="pelvic")

    # 轻微柔化：真实鱼皮的色块边界不会是矢量图那种硬边，也顺便压掉 JPEG 振铃
    image = Image.fromarray((np.clip(rgb, 0, 1) * 255 + 0.5).astype(np.uint8), "RGB")
    image = image.filter(ImageFilter.GaussianBlur(0.35))
    rgb = np.asarray(image, dtype=np.float64) / 255.0
    return np.clip(rgb, 0.0, 1.0)


def build_normal_map():
    """按图集 UV 生成切线空间法线：鳞片、侧线、鳃盖条纹、鳍条脊。
    这些细节不进几何，只进 normal map，几何只负责大形体。"""
    W, H = ATLAS_W, ATLAS_H
    height = np.zeros((H, W), dtype=np.float64)

    # ---------------- 身体
    x0, y0, x1, y1 = BODY_RECT
    bw, bh = x1 - x0, y1 - y0
    uu = (np.arange(bw) + 0.5) / bw
    vv = (np.arange(bh) + 0.5) / bh
    U, Vt = np.meshgrid(uu, vv)
    Vg = (Vt + 0.5) % 1.0

    # 鳞片：交错排列的浅凸包，边缘略高
    rows, cols = 112.0, 46.0
    gx = U * rows
    gy = Vg * cols + 0.5 * (np.floor(gx) % 2.0)
    fx = np.mod(gx, 1.0) - 0.5
    fy = np.mod(gy, 1.0) - 0.5
    r = np.sqrt(fx ** 2 + (fy * 0.82) ** 2)
    dome = np.sqrt(np.maximum(0.0, 1.0 - (r / 0.52) ** 2))
    body_h = 0.32 * dome

    # 侧线：体侧一条细孔列
    for line_v in (0.25, 0.75):
        dots = np.exp(-((Vg - line_v) / 0.0055) ** 2) * (0.5 + 0.5 * np.cos(U * 2.0 * np.pi * 92.0))
        body_h += 0.045 * dots

    # 鳃盖条纹：在鳃盖区叠几道很浅的放射纹
    gill_mask = smoothstep(0.225, 0.26, U) * (1.0 - smoothstep(0.33, 0.36, U))
    striae = 0.5 + 0.5 * np.sin(Vg * 2.0 * np.pi * 26.0 + U * 30.0)
    body_h += 0.022 * gill_mask * striae

    gv_top = smoothstep(0.10, 0.15, Vg) * (1.0 - smoothstep(0.38, 0.46, Vg))
    gv_bot = smoothstep(0.54, 0.60, Vg) * (1.0 - smoothstep(0.82, 0.90, Vg))
    gmask = gv_top + gv_bot
    body_h -= 0.45 * np.exp(-((U - 0.336) / 0.0042) ** 2) * gmask
    body_h += 0.18 * np.exp(-((U - 0.348) / 0.0048) ** 2) * gmask

    # 眼窝：眶缘凸、窝内凹
    for ev in (0.186, 0.814):
        ed = np.sqrt(((U - 0.105) / 0.042) ** 2 + ((Vg - ev) / 0.050) ** 2)
        body_h += 0.22 * np.exp(-((ed - 1.02) / 0.16) ** 2)
        body_h -= 0.20 * (1.0 - smoothstep(0.45, 0.95, ed))

    # 唇：一道缝、上唇、下唇
    for mv in (0.330, 0.670):
        du = np.abs(U - 0.026)
        dv = Vg - mv
        lipmask = 1.0 - smoothstep(0.018, 0.055, du)
        body_h -= 0.30 * np.exp(-(dv / 0.006) ** 2) * lipmask
        body_h += 0.20 * np.exp(-((dv + 0.016) / 0.007) ** 2) * lipmask
        body_h += 0.24 * np.exp(-((dv - 0.022) / 0.008) ** 2) * lipmask

    # 细颗粒
    body_h += 0.018 * fbm(U * 70.0, np.cos(2.0 * np.pi * Vg) * 9.0, np.sin(2.0 * np.pi * Vg) * 9.0, 3, 4)
    height[y0:y1, x0:x1] = body_h

    # ---------------- 鳍：沿 u 的鳍条脊，越靠鳍缘越明显
    rays_for = {"dorsal": 17, "anal": 12, "caudal": 18, "pectoral": 14, "pelvic": 10}
    for name, rect in FIN_RECTS.items():
        fx0, fy0, fx1, fy1 = rect
        fw, fh = fx1 - fx0, fy1 - fy0
        fu = (np.arange(fw) + 0.5) / fw
        fv = (np.arange(fh) + 0.5) / fh
        FU, FV = np.meshgrid(fu, fv)
        rays = rays_for[name]
        ridge = (0.5 + 0.5 * np.cos(2.0 * np.pi * rays * FU)) ** 1.4
        fin_h = ridge * (0.10 + 0.42 * FV)
        fin_h += 0.05 * (0.5 + 0.5 * np.sin(FV * 2.0 * np.pi * 5.0 + FU * 8.0)) * FV
        fin_h += 0.03 * fbm(FU * 40.0, FV * 18.0, np.zeros_like(FU), 2, 9)
        height[fy0:fy1, fx0:fx1] = fin_h

    # ---------------- 高度场 -> 切线空间法线
    normal = np.zeros((H, W, 3), dtype=np.float64)
    normal[:] = (0.5, 0.5, 1.0)
    strength = 1.3
    for x0, y0, x1, y1 in [BODY_RECT, *FIN_RECTS.values()]:
        h = height[y0:y1, x0:x1]
        gy, gx = np.gradient(h)
        nx = -gx * strength
        ny = -gy * strength
        nz = np.ones_like(nx)
        length = np.sqrt(nx * nx + ny * ny + nz * nz)
        nx, ny, nz = nx / length, ny / length, nz / length
        normal[y0:y1, x0:x1, 0] = nx * 0.5 + 0.5
        normal[y0:y1, x0:x1, 1] = ny * 0.5 + 0.5
        normal[y0:y1, x0:x1, 2] = nz * 0.5 + 0.5

    image = Image.fromarray((np.clip(normal, 0.0, 1.0) * 255.0 + 0.5).astype(np.uint8), "RGB")
    image.save(TARGET.with_name("clownfish-procedural-normal.png"))
    buf = io.BytesIO()
    image.save(buf, format="JPEG", quality=92, subsampling=1, optimize=True)
    return buf.getvalue()


def write_atlas(rgb):
    image = Image.fromarray((rgb * 255.0 + 0.5).astype(np.uint8), "RGB")
    image.save(ATLAS_PREVIEW)
    buf = io.BytesIO()
    image.save(buf, format="JPEG", quality=92, optimize=True, subsampling=1)
    return buf.getvalue()


def sample_atlas(rgb, uv):
    x = int(np.clip(uv[0], 0.0, 0.999999) * ATLAS_W)
    y = int(np.clip(uv[1], 0.0, 0.999999) * ATLAS_H)
    return rgb[y, x]


def rim_darken(mesh, rgb, amount=0.10, width=0.012):
    """在鳍的最外缘压一圈极窄的暗边，配合黑缘让边缘不发光。"""
    for i, (u, v) in enumerate(mesh.uv):
        if v > 0.985:
            c = sample_atlas(rgb, (u, v)) * (1.0 - amount)
            rgb[int(v * ATLAS_H), int(u * ATLAS_W)] = c


# ---------------------------------------------------------------- GLB
class GLB:
    def __init__(self):
        self.binary = bytearray()
        self.views = []
        self.accessors = []

    def view(self, data: bytes, target=None):
        while len(self.binary) % 4:
            self.binary.append(0)
        offset = len(self.binary)
        self.binary.extend(data)
        entry = {"buffer": 0, "byteOffset": offset, "byteLength": len(data)}
        if target is not None:
            entry["target"] = target
        self.views.append(entry)
        return len(self.views) - 1

    def accessor(self, array: np.ndarray, comp_type: int, type_: str, target=None, minmax=False):
        array = np.ascontiguousarray(array)
        index = self.view(array.tobytes(), target)
        accessor = {
            "bufferView": index,
            "componentType": comp_type,
            "count": int(array.shape[0]),
            "type": type_,
        }
        if minmax:
            accessor["min"] = [float(x) for x in array.min(axis=0)]
            accessor["max"] = [float(x) for x in array.max(axis=0)]
        self.accessors.append(accessor)
        return len(self.accessors) - 1


def build_glb(meshes, jpeg, normal_png):
    glb = GLB()
    image_view = glb.view(jpeg)
    normal_view = glb.view(normal_png)
    nodes, mesh_defs, material_defs = [], [], []
    materials = {
        "Body": {
            "name": "Body", "doubleSided": False,
            "pbrMetallicRoughness": {
                "baseColorTexture": {"index": 0}, "metallicFactor": 0.0, "roughnessFactor": 0.42,
            },
            "normalTexture": {"index": 1, "scale": 1.0},
        },
        "Fin": {
            "name": "Fin", "doubleSided": True,
            "pbrMetallicRoughness": {
                "baseColorTexture": {"index": 0}, "metallicFactor": 0.0, "roughnessFactor": 0.55,
            },
            "normalTexture": {"index": 1, "scale": 1.0},
        },
        "Eye": {
            "name": "Eye",
            "pbrMetallicRoughness": {
                "baseColorFactor": [0.02, 0.02, 0.02, 1.0], "metallicFactor": 0.0, "roughnessFactor": 0.12,
            },
        },
    }
    for name in ("Body", "Fin", "Eye"):
        material_defs.append(materials[name])

    for mesh in meshes:
        normal = mesh.normals()
        pos = np.asarray(mesh.pos, dtype=np.float32)
        nrm = np.asarray(normal, dtype=np.float32)
        uv = np.asarray(mesh.uv, dtype=np.float32)
        idx = np.asarray(mesh.tris, dtype=np.uint16).reshape(-1)
        attrs = {
            "POSITION": glb.accessor(pos, 5126, "VEC3", 34962, minmax=True),
            "NORMAL": glb.accessor(nrm, 5126, "VEC3", 34962),
            "TEXCOORD_0": glb.accessor(uv, 5126, "VEC2", 34962),
        }
        indices = glb.accessor(idx, 5123, "SCALAR", 34963)
        mesh_defs.append({
            "name": mesh.name,
            "primitives": [{
                "attributes": attrs,
                "indices": indices,
                "material": ("Body", "Fin", "Eye").index(mesh.material),
            }],
        })
        nodes.append({"name": mesh.name, "mesh": len(mesh_defs) - 1})

    root = {"name": "ClownfishOcellaris", "children": list(range(1, len(nodes) + 1))}
    nodes = [root] + nodes
    gltf = {
        "asset": {"version": "2.0", "generator": "dsh-eco-aquarium procedural clownfish"},
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": nodes,
        "meshes": mesh_defs,
        "materials": material_defs,
        "textures": [{"sampler": 0, "source": 0}, {"sampler": 0, "source": 1}],
        "samplers": [{"magFilter": 9729, "minFilter": 9987, "wrapS": 33071, "wrapT": 33071}],
        "images": [
            {"bufferView": image_view, "mimeType": "image/jpeg", "name": "clownfish-atlas"},
            {"bufferView": normal_view, "mimeType": "image/jpeg", "name": "clownfish-normal"},
        ],
        "accessors": glb.accessors,
        "bufferViews": glb.views,
        "buffers": [{"byteLength": len(glb.binary)}],
    }
    binary = bytes(glb.binary) + b"\0" * ((-len(glb.binary)) % 4)
    encoded = json.dumps(gltf, separators=(",", ":")).encode("utf-8")
    encoded += b" " * ((-len(encoded)) % 4)
    total = 12 + 8 + len(encoded) + 8 + len(binary)
    out = struct.pack("<4sII", b"glTF", 2, total)
    out += struct.pack("<II", len(encoded), 0x4E4F534A) + encoded
    out += struct.pack("<II", len(binary), 0x004E4942) + binary
    return out, gltf


def main():
    TARGET.parent.mkdir(parents=True, exist_ok=True)
    body = build_body()
    fins = build_fins()
    eyes = build_eyes()
    meshes = [body] + fins + [eyes]
    rgb = build_atlas()
    jpeg = write_atlas(rgb)
    normal_png = build_normal_map()
    data, gltf = build_glb(meshes, jpeg, normal_png)
    TARGET.write_bytes(data)
    tris = sum(len(m.tris) for m in meshes)
    verts = sum(len(m.pos) for m in meshes)
    print(f"meshes={len(meshes)} verts={verts} tris={tris}")
    print(f"atlas jpeg={len(jpeg)/1024:.1f} KB  normal png={len(normal_png)/1024:.1f} KB  glb={len(data)/1024:.1f} KB")
    pos = np.asarray(body.pos)
    print("body bbox", pos.min(axis=0).round(4), pos.max(axis=0).round(4))
    allpos = np.concatenate([np.asarray(m.pos) for m in meshes])
    print("total bbox", allpos.min(axis=0).round(4), allpos.max(axis=0).round(4))
    print("ratio length/height", round((allpos.max(0)[0] - allpos.min(0)[0]) / (allpos.max(0)[1] - allpos.min(0)[1]), 2))
    for mesh in meshes:
        vol = mesh.signed_volume()
        print(f"  {mesh.name:14s} tris={len(mesh.tris):5d} vol={'n/a' if mesh.material != 'Body' and mesh.material != 'Eye' else round(vol,5)}")


if __name__ == "__main__":
    main()

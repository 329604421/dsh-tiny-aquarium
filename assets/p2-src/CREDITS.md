# P2 源资产与许可

## 本项目自制素材（2026-11-19 定稿）

- `neon-tetra.glb`：以用户提供的红绿灯侧面、正面、俯视图为参考制作的**自制群游鱼资产**。
  第一次多视角重建因深菱形身体与尾部收束不合格而拒绝；第二次以完整侧面重建，并用正面/俯视做四角度对照。
  正式版 10,000 面 / 6,519 顶点 / 约 372 KB，内嵌 512² baseColor JPEG 与 256² normal JPEG。
  原始 GLB/OBJ、预览、参考图和生成记录保存在 `scripts/neon-tetra/source/`；`polish_photo.py` 烘焙节点旋转、
  压缩贴图并移除非必要 PBR 扩展，`src/neon-tetra.js` 提供六区权重与顶点泳姿。验收记录见
  [docs/P2-红绿灯重制.md](../../docs/P2-红绿灯重制.md)。
- 银鲦 `silver-fish.glb` 已撤下并移到 `.probe/retired/silver-fish.glb`，不再是正式资产，不随包发布。

- `clownfish-ocellaris.glb`：以用户提供的多视角小丑鱼照片为参考、经多视角 3D 重建并优化的
  **自制英雄鱼资产**。20,000 面 / 11,937 顶点 / 1 个连通 mesh，约 901 KB；内嵌
  1024×1024 baseColor JPEG 与 512×512 切线空间法线 PNG，无外部依赖、无 glTF 扩展。
- 运行时：`src/clownfish.js`。单网格按解剖位置烘焙 `aBody` / `aRegion` 分区权重，身体做
  **脊柱行进波 + 截面/法线旋转**，胸鳍、腹鳍、尾鳍、背鳍、臀鳍分别按鳍根权重摆动；
  `ClownfishPilot` 驱动悬停、巡游与冲刺。资产本身没有骨骼动画或烘焙动画片段。
- 2026-11-19 对比后确定：照片重建版的外形明显更自然，正式采用；程序化雕刻版
  （15,336 面 / 7 mesh / 541 KB）作为备选，生成器保留在 `scripts/clownfish/build_clownfish.py`，
  输出到 `scripts/clownfish/alternates/`，不会覆盖正式资产。
- 照片版原始网格保存在 `scripts/clownfish/source/clownfish-photo-base.glb`；
  `scripts/clownfish/polish_photo.py` 负责把淡粉高光与灰橙提回参考照片的饱和橙色，
  `npm run asset:clown:photo` 可复现正式 GLB。
- `clownfish-atlas.png`、`clownfish-normal.png`：程序化备选版的历史图集预览。
- `clownfish-reference.jpg`：早期参考照片，保留作配色比对；正式资产不直接采样它。
- `clownfish-ocellaris-viewer.html`：本地可旋转预览页，数据与上方 GLB 一致。
- 重制记录与验收数据见 [docs/P2-小丑鱼重制.md](../../docs/P2-小丑鱼重制.md)。

旧版小丑鱼（照片 + 低模，10,206 面 / 669 KB）已废弃，备份在 `.probe/clownfish-backup/`，不随包发布。

写实路线筛选后的候选资产，**总 382 KB**，全部为 glTF 2.0 二进制（`.glb`），无外部依赖、无 glTF 扩展。

实测数据由 `node scripts/audit-fish.mjs` 生成，完整结果见 `scripts/fish-audit.json`。

## 清单

| 文件 | 物种 | 面数 | 体积 | 贴图 | UV | 动画 | 许可 | 作者 / 来源 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `neon-tetra.glb` | 红绿灯 | 10,000 | 约 372 KB | 512² baseColor + 256² normal | 有 | 顶点着色器分区泳姿 | 本项目自制 | 用户提供的四视图参考与多视角重建 |
| `clownfish.glb` | 小丑鱼 | 686 | 80 KB | 无 | 无 | 骨骼 `Armature\|Swim` | CC0 1.0 | Quaternius · quaternius.com |
| `goldfish-long.glb` | 金鱼（长尾） | 1036 | 37 KB | 无 | 有 | 无 | CC-BY 3.0 | Poly by Google · poly.pizza |
| `goldfish.glb` | 金鱼（短身） | 508 | 34 KB | 32×32 | 有 | 无 | CC-BY 3.0 | Poly by Google · poly.pizza |
| `crawfish.glb` | 小龙虾 | 1556 | 55 KB | 无 | 有 | 无 | CC-BY 3.0 | Poly by Google · poly.pizza |
| `seahorse.glb` | 海马 | 956 | 36 KB | 无 | 有 | 无 | CC-BY 3.0 | Poly by Google · poly.pizza |
| `anemone.glb` | 海葵 | 1024 | 72 KB | 32×32 | 有 | 无 | CC-BY 3.0 | Poly by Google · poly.pizza |

## 署名义务

- **CC0**（Quaternius 两款）：无强制义务。作者希望致谢，建议在插件 README 写一句
  `Fish models by Quaternius (quaternius.com), CC0 1.0`。
- **CC-BY 3.0**（Poly by Google 五款）：**必须署名**。分发时在插件 README 与
  `presets.json` 的 `author` / `license` / `source` 字段中保留以下信息：

```
Goldfish, Goldfish (long tail), Crawfish, Seahorse, Anemone
by Poly by Google, licensed under CC-BY 3.0
via Poly Pizza (https://poly.pizza)
```

## 已知限制（实测修正）

1. **贴图基本没有**：只有 `goldfish` 与 `anemone` 各带一张 32×32 的贴图，等于纯色占位；
   其余五款完全没有 baseColor 贴图。写实表面只能靠程序化鱼皮补（见
   `docs/P2-入缸标准.md` 第 4 节）。
2. **UV 与动画互斥**：恰好是"有动画的两款没有 UV、有 UV 的五款没有动画"。
   所以表面方案不能建立在 UV 之上，必须在物体空间做三平面投影。
3. **单位不可信**：
   - Quaternius 两款带 **100× 节点缩放**（Blender 的 cm/m 残留），按节点树直接加载会是 8 米长的鱼；
   - Poly by Google 五款的原始几何从 245 单位到 69885 单位不等，同一批资产单位都不统一。
   接入时一律按目标体长重标定，不读资产元数据。
4. **Google 五款无骨骼**：只能整体位移与姿态旋转，尾鳍摆动需要顶点着色器按体轴渐次位移。
5. **生物混养**：`clownfish` / `seahorse` / `anemone` 为海水种，现缸体（细砂底、无活石珊瑚）是淡水造景。
   本期不进缸。

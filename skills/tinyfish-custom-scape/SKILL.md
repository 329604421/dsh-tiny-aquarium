# 定制水草与造景

> 前置：先读完 `tinyfish-custom-core`。
> 细则底稿：`<ROOT>/docs/guides/鱼缸造景3D资产制作指南.md`

---

## 1. 一套造景 = 素材 + 摆放 + 占位

引擎不猜你的意图，只按清单做三件事：把素材按 `layout` 摆几次、用 `collision` 约束鱼、在 `airStone`
位置冒气泡。所以一次定制造景要交三样：

| 交付 | 写在哪 | 作用 |
| --- | --- | --- |
| 一个 `.glb` 素材单元（一簇草 / 一组石 / 一段沉木） | `assets-src/models/scene/<slug>.glb` | 被摆放多次 |
| `params.layout` | 清单 | 每处的位置（cm）、缩放、绕 Y 旋转 |
| `collision` | 清单 | 鱼的占位：实体用 `box/solid`，植物用 `cylinder/soft` |

**一个 GLB 就够了**：既可以做「一整块布好的景」（`layout` 只写一条、`scale: 1`），
也可以做「一簇草」再摆 20 次。前者省事、后者省体积，看你的素材复杂度选。

---

## 2. 边界（越过就会被体检或鱼群拦住）

| 项目 | 限制 |
| --- | --- |
| 叶片顶点 | X ∈ ±19 cm、Z ∈ ±11.5 cm，不得穿出玻璃 |
| 高度 | 叶尖 ≤ Y 23 cm（水面 26.7 cm，留投喂通道） |
| 中心与前方 | 保留主要观赏与投喂水域，不要密植遮满 |
| 占位体 | 不越出玻璃与水面；单个实体不超过水面积 55% |
| 最小通行 | 实体之间留 ≥ 4 cm，鱼才穿得过去 |

---

## 3. 清单写法

```json
{
  "id": "scape.driftwood-tunnel",
  "category": "scape",
  "displayName": "沉木隧道",
  "origin": "custom",
  "source": "assets-src/models/scene/driftwood-tunnel.glb",
  "params": {
    "layout": [
      { "x": -8, "y": 1.65, "z": -4, "scale": 1, "rotY": 12 },
      { "x": 9, "y": 1.65, "z": 2, "scale": 0.85, "rotY": -30 }
    ],
    "airStone": [-15, 2.1, -7]
  },
  "collision": [
    { "type": "box", "kind": "solid", "center": [-8, 6, -4], "size": [10, 9, 7] },
    { "type": "cylinder", "kind": "soft", "center": [9, 6, 2], "radius": 4, "height": 9 }
  ]
}
```

- `layout` 的 `x/y/z` 与 `collision` 全部是**厘米**，`rotY` 是**度**。
- `y` 一般写 `1.65`（砂面），让素材底部压进砂里一点，不要悬空。
- `collision` 可以从简：石与木用 3～6 个盒子拼，水草每簇一个圆柱即可。**宁少勿多**——
  占位过大会让鱼卡死，占位缺失只是鱼穿草（可接受）。

---

## 4. 制作步骤

1. 先画一张俯视布局草图（三区：后景 / 中景 / 前景），标出主石或主木的位置，发给用户确认。
2. 建模。要求：
   - 原点在素材**底部中心**，`Y` 向上，米制，`scale = 1`；
   - 水草根部固定、叶尖收细；石块底部平、能压进砂面；
   - 材质 PBR metallic-roughness，贴图内嵌（≤1024²）；
   - 不要做十字交叉面片冒充叶片，也不要用平面贴图假装立体。
3. 导出 `.glb` 到 `assets-src/models/scene/<slug>.glb`。
4. 写 `layout` 与 `collision`，体检 → 登记 → 构建：

```bash
cd <ROOT>
node scripts/custom-asset.mjs audit --id scape.<slug> --file assets-src/models/scene/<slug>.glb \
  --params '{"layout":[...],"airStone":[-15,2.1,-7]}' \
  --collision '[{"type":"box","kind":"solid","center":[-8,6,-4],"size":[10,9,7]}]'
node scripts/custom-asset.mjs add --id scape.<slug> --file assets-src/models/scene/<slug>.glb \
  --display-name "沉木隧道" --license CC0-1.0 --author 我 \
  --params '...' --collision '...'
npm run build
```

5. 让用户重启 DSH，在定制页「外观与手感 → 水草与造景」一行右侧的下拉里选中。

---

## 5. 验收

```bash
node scripts/custom-asset.mjs audit --id scape.<slug>
npm run build && npm run probe:scape
```

人工确认：

- [ ] 鱼能穿过空隙，不会持续顶着一个看不见的盒子；
- [ ] 草叶不穿玻璃，水面上方没有叶片探出；
- [ ] 投喂的颗粒能落到砂面，不被整片密植挡住；
- [ ] 切换造景后旧实例被释放（FPS 不掉、连切三次不涨内存）；
- [ ] 省电模式下摆幅降低，但生态层没有整片消失。

---

## 6. 常见错误

| 现象 | 原因 | 修法 |
| --- | --- | --- |
| 鱼卡在原地抖 | 占位体太大或互相咬合 | 拆小盒子，留 ≥ 4 cm 通道 |
| 石木悬空 | `layout.y` 写高了 | 用 1.65，底部压进砂里 |
| 整片草在飘 | 材质带自身动画，又叠加了引擎摆动 | 二者只留一个 |
| 鱼穿草而过 | 没有 `soft` 圆柱占位 | 每簇草加一个 `cylinder/soft` |
| 造景一半在缸外 | 用了米而不是厘米写 layout | 全部乘 100 |
| 切换后越来越卡 | 素材没被释放 | 确认是单个 Group、无外部纹理句柄 |

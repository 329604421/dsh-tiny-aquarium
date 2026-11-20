# 小鱼缸定制 · 通用契约

> 这份 skill 是四个资产维度（缸体 / 灯具 / 水草与造景 / 鱼群）和投喂习惯维度的**共同前提**。
> 加载任何具体维度 skill 之前，先读完这一份：路径、单位、清单字段、构建、体检、回退都只在这里写一次。

插件根目录（后文记作 `<ROOT>`）：`{{ROOT}}`

---

## 0. 开工前先看现状（不要问用户「你现在是什么配置」）

用户的这条消息里只有一句需求和几个空行——现状要你自己读，不要反问。按顺序做：

1. 读 `<ROOT>/presets.json`：`presets` 数组里就是全部内置与定制资产。
   - `origin: "custom"` 的是已经做过的定制件，`createdAt` 倒序就是定制页的显示顺序。
   - 同 `category` 的行先列一遍，新 id 不能与已有 id 冲突。
   - 文件顶部 `"units": "cm"` 提醒你：清单里的 `bounds` / `collision` 是**厘米**。
2. 读 `<ROOT>/lib/build-info.json` 或 `<ROOT>/package.json` 确认版本与插件根目录。
3. 需要看内置资产的参数时读源码：`src/species.js`（内置鱼群：红绿灯 ×5、小丑鱼 ×2）、
   `src/core.js`（`SPACE` 米制游动空间、`LIMITS` 投喂上限）、`src/scape-data.js`（内置三套造景）。
4. 把「我看到的现状 + 我打算怎么改」用三五行复述给用户，等一句确认再动手。

**当前缸体尺寸、水面高度、可游动范围、玻璃敲击面、食物与投喂坐标都是固定契约**（见 §3），
它们不会因为用户没说而改变，也不需要问。

---

## 1. 你要交付的不是「一个模型」，是一组可验收的东西

一件合格的定制资产 = **资产文件 + 清单条目 + 体检结果**。三者缺一，插件里就看不到它。
具体到不同维度：

| 维度 | 交付物 | 落到哪 |
| --- | --- | --- |
| 缸体 | 一个 `.glb`（玻璃、边框、底座） | `assets-src/models/tank/<slug>.glb` |
| 灯具 | 一个 `.glb`（灯杆、灯臂、灯头、灯管） | `assets-src/models/lamp/<slug>.glb` |
| 水草与造景 | 一个 `.glb`（可复用的石/木/草束）+ 摆放清单 + 占位体 | `assets-src/models/scene/<slug>.glb` |
| 鱼群 | 一个单网格 `.glb`（内嵌贴图） | `assets-src/models/fish/<slug>.glb` |
| 投喂习惯 | 一组参数（没有模型） | `presets.json` |

**文件名就是 id 的后半段**：`tank/relic-round.glb` → `tank.relic-round`。构建按文件名内联，名字不一致等于没登记。

---

## 2. 位置（绝对路径）

| 用途 | 路径 |
| --- | --- |
| 插件根目录 | `<ROOT>`（本机为上面那一行） |
| 资产源目录 | `<ROOT>/assets-src/models/{tank,lamp,fish,scene}/` |
| 清单文件 | `<ROOT>/presets.json` |
| 构建入口 | `<ROOT>/scripts/build.mjs`（`npm run build`） |
| 体检与登记 | `<ROOT>/scripts/custom-asset.mjs` |
| 下线归档 | `<ROOT>/assets-src/custom-archive/<日期>/` |
| 四份制作指南（细则） | `<ROOT>/docs/guides/` |
| 本阶段说明 | `<ROOT>/docs/P5-AI定制工厂.md` |

只允许写**上面这些白名单里的路径**，并且一次只动一个维度。

> ⚠️ **开工前先自检这一条**：如果 `<ROOT>/scripts/custom-asset.mjs` 不存在，说明当前这份是
> **npm 安装的运行时副本**（只随包发运行时代码，不含定制工具链）。此时**不要**尝试构建、
> 也不要就地手改 `node_modules` 里的文件——直接告诉用户：定制需要在源码目录里做，
> `git clone https://github.com/329604421/dsh-tiny-aquarium` 之后用
> `dsh plugin --profile desktop add <本地源码目录>` 装一份源码版，再在新会话里重新发起定制。
> 除这一条以外，其余契约照旧。

---

## 3. 单位与坐标系（最容易错的一段）

- **长度单位：米（m）**。导出 `.glb` 时 1 unit = 1 m，不要按厘米导出。
  清单里的 `bounds` 与 `collision` 反过来写**厘米**（历史约定，`presets.json` 顶部的 `"units": "cm"` 就是这个意思）。
- **Y 轴向上**，缸底中心为原点 `(0,0,0)`，**+Z 朝前**（面向观众），+X 朝右。
- 缸体与水体的固定契约（**定制不得改动**）：

| 项目 | 数值 |
| --- | --- |
| 外框 | 40 × 30 × 25 cm（X × Y × Z） |
| 水面高度 | Y = 26.7 cm |
| 可游动范围 | X ∈ [-19.3, 19.3]、Z ∈ [-11.8, 11.8] cm |
| 砂面 | Y ≈ 1.65 cm |
| 敲击面 | 前玻璃 Z ≈ +12.5 cm；投喂面在水面高度 |

- 鱼资产的朝向：**吻端朝 -X，背朝 +Y**（或在清单 `params.axis` / `params.facing` 里声明别的约定，并说明理由）。

---

## 4. id 规则

- 形如 `类别.slug`，类别只能是 `tank` / `lamp` / `scape` / `fish` / `feeding`。
- slug 只允许小写字母、数字与中划线，2～28 个字符，例如 `relic-round`、`koi-red`。
- **不得占用内置 id**：`tank.clear-40`、`lamp.arch`、`scape.moss`、`scape.jungle`、`scape.driftwood`、
  `fish.neon-tetra`、`fish.clownfish`、`feeding.standard`。
- 定制资产永远**新增条目**，不覆盖、不改写任何内置 `.glb` 或内置清单行。

---

## 5. 清单条目字段（写进 `presets.json` 的 `presets` 数组）

```json
{
  "id": "fish.koi-red",
  "category": "fish",
  "version": 1,
  "file": "custom-bundle",
  "sourceType": "glb",
  "displayName": "红白锦鲤",
  "origin": "custom",
  "createdAt": "2026-11-20T05:00:00.000Z",
  "license": "CC0-1.0",
  "author": "我",
  "source": "assets-src/models/fish/koi-red.glb",
  "triangles": 18000,
  "textures": 1024,
  "params": { "targetLength": 0.08, "count": 2, "cruise": 0.6, "rig": "smooth" }
}
```

- `origin` 必须是 `"custom"`，定制页据此显示「定制」标记，并允许下线。
- `license` / `author` / `source` 不能为空；缺失会被体检拦下。
- **优先用 `node scripts/custom-asset.mjs add ...` 生成条目**，它会自动填面数、尺寸、时间戳，比手写可靠。

---

## 6. 构建与生效（为什么必须两步）

`.glb` 不能运行时加载：宿主的包资源路由只提供图片，模型必须在构建期内联进 chunk。
所以定制完成后：

```bash
cd <ROOT>
node scripts/custom-asset.mjs audit --id <新id>     # 体检
node scripts/custom-asset.mjs add   --id <新id> --file <相对路径> --display-name "中文名" \
                                    --license CC0-1.0 --author 我 --params '<JSON>' [--collision '<JSON>']
npm run build                                       # 重新生成 client.scene.js 与自定义资产包
```

然后**重启 DSH**（或在宿主支持热更新时重新打开鱼缸）：定制页会出现带「定制」标记的新条目。
请如实告诉用户这一步：不要让他以为点完按钮就换缸了。

`npm run build` 会：

1. 扫描 `assets-src/models/{tank,lamp,fish,scene}/*.glb`，生成 `src/custom-bundle.generated.js`（自动生成，**不要手改**）；
2. 把资产内联进 `lib/client.scene.js`；
3. 记录插件根目录到 `lib/build-info.json`。

---

## 7. 体检（不过就不登记）

```bash
node scripts/custom-asset.mjs audit --id <id> --file <相对路径>
node scripts/custom-asset.mjs check      # 清单与文件一致性 + 全部定制条目的预算
node scripts/custom-asset.mjs list       # 看清单现状
node scripts/custom-asset.mjs archive --id <id>   # 下线（移动，不删除）
```

判据（与脚本同一份常量，见 `<ROOT>/src/customize.js`）：

| 判据 | 要求 |
| --- | --- |
| id | `<类别>.<slug>`、未被占用、文件名与 slug 一致 |
| 几何 | 网格非空；面数不超预算（缸体 40k / 灯具 24k / 造景 60k / 鱼 30k） |
| 体积 | 单文件 ≤ 1.6MB（鱼 1.2MB、灯具 800KB） |
| 贴图 | 必须内嵌（不能 `uri` 外链），最大边 ≤ 1024 |
| 许可 | `license` / `author` / `source` 非空 |
| 缸体 | 外框 40×30×25 cm（±5%），锚点 `tank-local-bottom`，朝向 `+z` |
| 灯具 | 锚点 `tank-local`，色温 2700–6500K，亮度 0.3–2 |
| 造景 | 有 `params.layout` 与 `collision`，占位体不越出玻璃与水面，最大实体不超过底面积 55% |
| 鱼 | `params.targetLength` 0.02–0.12 m、`count` 1–6，有内嵌颜色贴图，体形最长边 ≥ 最短边 1.6 倍 |
| 投喂 | 参数落在允许区间且 min ≤ max |

体检输出要**整段贴给用户**，不要只说「通过了」。

---

## 8. 回退（必须提前想好）

- 用户不满意 → 定制页切回内置资产即可，定制条目仍留在清单里。
- 要彻底移除 → `node scripts/custom-asset.mjs archive --id <id>`：`.glb` 与清单条目一起进
  `assets-src/custom-archive/<日期>/`，脚本会打印恢复命令。**不做物理删除。**
- 配置里若仍指向已下线的 id，打开鱼缸时自动回退到同类内置资产，不黑屏、不报错。

---

## 9. 禁止项（长会话里最容易忘的一段）

1. 不改 `src/` 下的引擎、行为与交互代码；不改 `lib/` 下的构建产物。
2. 不改、不删内置资产：`assets/p2-src/` 里的 `.glb`、以及 `presets.json` 里 `origin` 不是 `custom` 的行。
3. 不删除任何文件；替换用「新增 + 切换」。
4. 不联网下载模型、贴图或参考图；参考图必须由用户拖进会话。
5. 不使用外链贴图（`uri`），一律内嵌。
6. 不一次改两个维度；不擅自扩大范围（例如顺手改配色、改行为参数）。
7. 不在没有体检结果的情况下说「已完成」。

---

## 10. 回报格式（每次交付都按这个写）

```
新 id / 中文名 / 文件路径：
面数 / 贴图 / 体积：
关键参数（尺寸、数量、速度等）：
体检结果：PASS（贴原始输出）或 未通过项
生效方式：已 build，需重启 DSH
剩余风险：
回退步骤：node scripts/custom-asset.mjs archive --id <id>
```

---

## 11. 常见失败与定位

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 定制页看不到新条目 | 没跑 `add`，或 id 与文件名不一致 | 跑 `node scripts/custom-asset.mjs check` |
| 构建成功但缸里没变化 | 没重启 DSH | 重启后重新打开鱼缸 |
| 资产巨大/漂浮/错位 | 按厘米导出，或锚点不在缸底中心 | 按米重导出，锚点 `tank-local-bottom` |
| 鱼不动或抽搐 | 网格不连通，或贴图缺失导致材质退化 | 合并成一个网格，内嵌 baseColor |
| 鱼穿玻璃 | `params.count` 太多或体长过大 | 减小 `count` / `targetLength` |
| 造景把鱼卡死 | 占位体过大或切碎了水体 | 拆小 `collision`，留 ≥ 4 cm 通行 |

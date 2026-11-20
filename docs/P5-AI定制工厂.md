# P5 · AI 定制工厂

> 适用版本：0.1.0（P5 完成）。需求依据：§5.4 / §5.5 / §5.6 / §11.6，验收条目 AC-36～AC-39。

P5 要解决的问题不是「再做一个编辑器」，而是：**用户想要一只别人缸里没有的鱼、一个不是方形的缸、一种自己的投喂手感时，不必改代码、不必等版本**。做法是把五份已有制作指南封装成随包 skill，让「定制」变成一次带约束的会话——模型负责创意与建模，插件负责契约、体检、登记与回退。

## 1. 五个入口与一次交接

设置页页尾是「AI 定制」区块，五行对应五个维度。点一行等于做三件事：拼提示词 → 跳新会话 → 把提示词作为草稿塞进去。

| 维度 | 维度 id | 按钮副标题 | 提示词里的目标 | 交付物 |
| --- | --- | --- | --- | --- |
| 缸体 | `tank` | 换形状、比例、边框与玻璃质感 | 换掉外框，保留水体与判定 | `assets-src/models/tank/<slug>.glb` + 清单条目 |
| 灯具 | `lamp` | 换灯型、材质与色温 | 换外观，接管射灯参数 | `assets-src/models/lamp/<slug>.glb` + 清单条目 |
| 水草与造景 | `scape` | 新增一套石木水草布局与出气点 | 新增一套可摆多处的造景 | `assets-src/models/scene/<slug>.glb` + 清单条目 |
| 鱼群 | `fish` | 从参考图新增一个鱼种 | 新增一个可上下水的鱼种 | `assets-src/models/fish/<slug>.glb` + 清单条目 |
| 投喂习惯 | `feeding` | 调发现延迟、争抢半径与散开时长 | 只调参数，不出模型 | `presets.json` 里一条 `feeding.*` |

需求文档的 §5.4～5.6 与 AC-36 写的是「四个维度」（缸体、灯具、造景、鱼种）。实现把**投喂习惯**也接到了同一个入口上：它已经有完整指南（[P4 投喂习惯与动作制作指南](P4-投喂习惯与动作制作指南.md)），而且不需要出模型，是五个维度里唯一「几分钟内必然走完」的一条，很适合当整条链路的第一个成功案例。验收按「至少四个」的超集执行。

### 交接的前置校验

按钮不是永远可点。`handoffBlockers(environment)` 只看客户端拿得到的事实，返回原因码数组：

| 原因码 | 触发条件 | 界面文案键 |
| --- | --- | --- |
| `noHandoffApi` | 宿主没有 `uiWorkspace.startSession` | `customNoHandoff` |
| `noWorkspaceList` | 拿不到工作区列表快照 | `customNoWorkspaceList` |
| `noWorkspace` | 工作区列表已就绪但为空 | `customNoWorkspace` |
| `noSkills` | 随包 skill 注册失败 | `customNoSkills` |

有阻断项时按钮不交接，直接把原因写在按钮下方——而不是点了没反应。没有阻断项时调用：

```js
ctx.uiWorkspace.startSession(undefined, { prompt, whenDraftExists: 'append' })
```

`workspaceId` 传 `undefined` 表示「当前工作区」；`whenDraftExists: 'append'` 保证已有草稿只被追加，不清空用户已经写了一半的内容。调用本身会导航到 Conversation，所以设置面板随之关闭——这正是 AC-36 要的行为。

### 批次 id 与去重

每次交接生成 `batchId = <36 进制时间戳>-<维度>`，放在草稿最后一行：

```
（批次 m3k9x1a-tank：这段内容重复出现时只做一次）
```

`whenDraftExists: 'append'` 意味着连点两次会把两段草稿都追进去。批次号是给模型看的去重键：读到两段同号内容时只开一次工。这也是「重复点击不产生两份任务」的实现方式——不去猜用户意图，而是让重复可识别。

## 2. 提示词只是一条 `/skill` 草稿

最早的实现把契约抄进了提示词：九段、1500 多字，路径白名单、体检命令、回报格式全在输入框里。问题是**那段文字会一直躺在用户眼前**——他并不需要改这些，而这些内容本来就是 skill 该负责的事。

现在 `buildPrompt(dimensionId, { now })` 只生成三段：

```
/aquarium-custom-core /aquarium-custom-tank 帮我给鱼缸换一个新缸体。

外形（方缸 / 圆角 / 异形）：
材质与配色：
参考图（拖进本会话）：

（批次 loyw3v28-tank：这段内容重复出现时只做一次）
```

| 段 | 作用 |
| --- | --- |
| 首行 | `/skill` token + 一句「帮我做什么」 |
| 中间 | `dimension.fields` 逐行输出，2～4 个空行 |
| 末行 | 批次号 |

长度从 1574 字符降到 121～143 字符。`npm test` 里有两条护栏：一条硬上限（`text.length < 400`），一条反向断言（提示词里不许再出现 `assets-src/`、`custom-asset.mjs`、`【回报】`），防止草稿又被堆长。

### 为什么 `/skill-name` 就够了

`/name` 是 DSH 的标准 skill 引用方式，不是本插件的约定。宿主 `@deepseek-ai/dsh-tool-skill` 的「用户显式调用」是这么实现的：

> 已认领用户消息中**任意位置、以空白为界**、指名工作区目录中某个用户可调用 skill 的 `/name` token，会把该 skill 的完整 `<skill_content>` 渲染作为 `user` 角色的指令上下文注入。

三个直接后果：

1. **契约可以全部搬进 skill 正文**，草稿只剩用户真正要回答的东西；
2. **不需要模型先调一次 `skill` 工具**，也就没有「模型忘了加载」这一步失败模式；
3. `userInvocable: true` 必须在注册时打开（`host.js` 里已开），否则这个 token 只会被当成普通文字。

首行放两个 token（核心 + 维度）：核心 skill 承载路径、单位、清单字段、体检、回退这些共享契约，维度 skill 只写差异。两份都注入是零往返的代价，比让模型自己判断「要不要再加载一份」可靠。

### 契约搬走之后，谁告诉模型现状

`/skill` 注入的是静态正文，读不到「用户现在用的是哪套造景」。这件事交给核心 skill 的第一节：

> **§0 开工前先看现状**：读 `<ROOT>/presets.json` 列同类别条目、读 `lib/build-info.json` 确认版本、需要时读 `src/species.js` / `src/core.js` / `src/scape-data.js`，然后把「我看到的现状 + 打算怎么改」用三五行复述，等一句确认再动手。

提示词里也因此不再需要 `root`：绝对路径由 `host.js` 在注册 skill 正文时把 `{{ROOT}}` 替换掉（见 §3）。
## 3. 六份 skill

`skills/` 下六份 `SKILL.md`，在 `host.js` 里用 `ctx.skills.register` 随包注册：

```js
ctx.inject(['skills'], child => { registerSkills(child); });

ctx.effect(() => ctx.skills.register({
  name: 'aquarium-custom-fish',
  description: '…',
  whenToUse: '…',
  content,                                   // 读 skills/<dir>/SKILL.md，{{ROOT}} 已替换
  resourceBase: { kind: 'directory', path },  // 指向真实目录，模型能直接 ls
  invocation: { modelInvocable: true, userInvocable: true },
}));
```

| skill | 目录 | 职责 |
| --- | --- | --- |
| `aquarium-custom-core` | `skills/aquarium-custom-core/` | 通用契约：交付物、绝对路径表、米/厘米双单位、`TANK_BOX`、id 规则、清单字段、构建两步、体检判据表、回退、禁止项、回报格式、常见失败 |
| `aquarium-custom-tank` | `skills/aquarium-custom-tank/` | 缸体：外框 40×30×25 cm ±5%、玻璃内外面、底座、不能挡投喂落点与敲击面 |
| `aquarium-custom-lamp` | `skills/aquarium-custom-lamp/` | 灯具：锚点、朝向、色温与亮度区间、发光件命名约定 |
| `aquarium-custom-scape` | `skills/aquarium-custom-scape/` | 造景：`layout[]` 多处摆放、`collision[]` 占位体、不越界、最大占地 ≤55%、出气点 |
| `aquarium-custom-fish` | `skills/aquarium-custom-fish/` | 鱼种：体长 0.02～0.12 m、1～6 尾、必须有内嵌颜色贴图、体形比例、不带 `Swim` 剪辑 |
| `aquarium-custom-feeding` | `skills/aquarium-custom-feeding/` | 投喂习惯：九个参数的名字、含义、区间、缺省值与成对乱序处理 |

三条设计取舍：

- **核心 skill 承载契约，维度 skill 只写差异。** 五份维度 skill 都有「引擎已提供 / 不可改契约 / 制作步骤 / 验收清单 / 常见错误」五节，但只有核心 skill 出现清单字段的完整示例和体检表——避免五份正文各写一遍再慢慢漂移。
- **正文里不放数字常量，只放结论。** 真正的数字（`TANK_BOX`、体积与面数预算、投喂区间）由 `src/customize.js` 单一来源导出，体检脚本、提示词生成、skill 正文共用同一份。skill 正文是给人读的说明书，代码是唯一事实来源。
- **`resourceBase` 指向目录而不是文件。** 模型可以顺着 skill 目录去找附属资源，不必猜插件装在哪。

## 4. 契约层：`src/customize.js`

纯数据 + 纯函数，没有 I/O、没有 `import`。浏览器侧（提示词生成、设置页）、Node 侧（体检脚本、CLI）共用同一份常量，是这套设计里唯一的「双端共享」模块。

| 导出 | 内容 |
| --- | --- |
| `BUILTIN_IDS` | 内置条目 id 集合，用于「未占用」判定 |
| `DEFAULT_PRESET_IDS` | 五个维度各自的默认内置 id，回退终点 |
| `CUSTOM_LIMITS` | 每类资产的预算：缸体 40k 面 / 1.6MB，灯具 24k / 800KB，造景 60k / 1.6MB，鱼 30k / 1.2MB，投喂 64KB |
| `TANK_BOX` | **厘米制**外框契约：40×30×25，水面 26.7，X ±19.3，Z ±11.8 |
| `parseCustomId` / `isValidCustomId` | `<类别>.<slug>` 解析；slug 2～28 位小写字母数字短横 |
| `DIMENSIONS` | 五个维度：`id / category / title / labelKey / hintKey / skills / goal / promptGoal / fields`。**只有界面与草稿需要的东西留在这里**，路径、体检、回报格式都在 skill 正文里 |
| `SHARED_RULES` | 六条共享红线 |
| `buildBatchId` / `buildPrompt` | 批次 id 与那条短草稿（`/skill` token + 一句目标 + 待填空行） |
| `FEEDING_PARAMS` | 九个投喂参数，各带 `min / max / fallback / label` |
| `defaultFeedingParams` / `normalizeFeedingParams` | 缺省值；越界回退 + `min > max` 对调，返回 `{ params, repaired }` |
| `handoffBlockers` / `BLOCKER_KEYS` | 交接前置校验与文案键映射 |

**单位是这套契约里最容易出错的地方，因此写死成规则**：清单与资产体检用厘米（跟制作指南一致），运行时几何与碰撞用米。`TANK_BOX` 是厘米制，`src/core.js` 的 `SPACE` 是米制；两者不是同一份东西，混用会静默产生 `NaN`（见 §10 的事故记录）。

## 5. 清单与运行时视图

`presets.json` 从 P5 起是资产的唯一事实来源，内置与定制同构。内置造景在清单里是 `substrate.*` 与 `plant.*` **成对**登记（P3 的布局本来就分底床与植物两层），而设置页要的是「一造景一行」。

`src/custom-catalog.js` 负责抹平这个差异：

```js
const catalog = createCatalog(manifest.presets);
```

| 成员 | 作用 |
| --- | --- |
| `rows` / `count` | 全部条目与条数 |
| `listPresets(category)` | 按类别取行，内置在前、定制按 `createdAt` 倒序 |
| `getPreset(id)` / `isCustom(id)` | 单条查询 |
| `customPresets(category)` | 只取定制条目 |
| `resolvePresetId(id, category)` | **回退入口**：命中 → `DEFAULT_PRESET_IDS[category]` → 同类第一个内置；返回 `{ id, preset, repaired }` |
| `sanitizeCustomIds(ids, category)` | 过滤未登记/非法的 id（配置里残留的定制 id 走这里） |
| `feedingPresetOf` / `feedingParamsOf` | 投喂习惯的 preset 与归一化参数 |
| `displayNameOf` / `customBadgeKey` | 显示名与「AI 定制」标记的文案键 |
| `tankBoxOf` / `lampParamsOf` / `scapeLayoutOf` | 清单参数 → 运行时形状（`scapeLayoutOf` 做厘米→米并支持 box 与 cylinder 两种占位体） |
| `customSpeciesOf` | 清单条目 → `School` 需要的 species 对象 |

`createCatalog` 不读 JSON：浏览器侧用打包后的 `import`，Node 侧用 `fs` 读出来再传进去。原因是 Node 22 下 `import x from './x.json'` 必须带 import attribute，而浏览器构建不需要——与其在两端各写一套，不如把清单当参数传。

**内置造景的虚拟行**：`createCatalog` 会按 `params.presetId` 把成对的 `substrate.*` / `plant.*` 合成虚拟的 `scape.*` 行。这样 `resolvePresetId('scape.unknown', 'scape')` 才有东西可回退——否则内置造景根本没有 `category: 'scape'` 的行，回退会返回空字符串。

## 6. 构建管线

`.glb` 不能运行时从磁盘加载（插件装在宿主的目录里，客户端没有文件系统权限），所以走构建期内联：

1. `scripts/build.mjs` 扫描 `assets-src/models/{tank,lamp,fish,scene}/*.glb`，生成 `src/custom-bundle.generated.js`：

   ```js
   export const CUSTOM_BUNDLES = { 'fish.rainbow': new Uint8Array([...]) };
   export const CUSTOM_BUNDLE_IDS = ['fish.rainbow'];
   ```

   **id 由文件名推导**（`rainbow.glb` → `fish.rainbow`），这是「文件名必须等于 slug」这条体检判据存在的原因：文件名不一致会导致「登记了但构建看不到」。

2. esbuild 用 `loader: { '.glb': 'binary' }` 把每个 GLB 内联成 `Uint8Array`，`define: { __AQ_PLUGIN_ROOT__ }` 注入插件根目录（提示词与 skill 正文里的绝对路径来源）。`lib/build-info.json` 同时写入 `pluginRoot` 供 Node 侧读。

3. 运行时用 `GLTFLoader.parse(buffer)` 解析——不走网络加载器，因此不联网。

自动生成文件在仓库里保留一份空壳（`CUSTOM_BUNDLES = {}`），保证首次 clone 不 build 也能跑测试。

## 7. 体检：`scripts/lib/audit.mjs`

体检是这条链路上唯一的闸门。`auditCandidate({ id, category, file, stats, entry, existingIds })` 返回 `{ pass, checks[] }`，每条 check 带 id、结论与一句可读的原因。

先做一次极简 GLB 解析（`scripts/lib/glb.mjs`）：读 magic / version / chunk，统计网格、图元、材质、三角面、节点、动画、贴图尺寸与体积，并从 POSITION 访问器的 min/max 取包围盒——不依赖 three.js，因此体检脚本可以在没有 WebGL 的环境里跑。

| check id | 判据 | 适用维度 |
| --- | --- | --- |
| `id-format` | id 形如 `<类别>.<slug>`，且未被占用 | 全部 |
| `file-name` | **文件名与 id 的 slug 一致** | 全部 |
| `file` | 资产可读且未超体积预算 | 全部 |
| `geometry` | 网格非空、面数在预算内 | 缸体/灯具/造景/鱼 |
| `texture` | 贴图内嵌（不是外部 URI）且单边 ≤1024 | 缸体/灯具/造景/鱼 |
| `license` | `license` / `author` / `source` 齐全 | 全部 |
| `tank-box` | 外框 40×30×25 cm ±5%（**资产按米导出，比较前 ×100**） | 缸体 |
| `tank-anchor` | 锚点与朝向符合约定（缸底中心、+Z 朝前） | 缸体 |
| `lamp-anchor` | 灯具挂在缸体局部坐标上 | 灯具 |
| `lamp-light` | 色温与亮度在允许区间 | 灯具 |
| `scape-layout` | 给出非空 `layout[]` | 造景 |
| `scape-collision` | 给出非空 `collision[]` | 造景 |
| `scape-inside` | 占位体不越出玻璃与水面 | 造景 |
| `scape-passage` | 最大实体占地 ≤ 水面积的 55%（留出通行） | 造景 |
| `scape-air` | 出气点在缸内 | 造景 |
| `fish-params` | 体长 0.02～0.12 m，数量 1～6 | 鱼 |
| `fish-texture` | 有内嵌颜色贴图 | 鱼 |
| `fish-shape` | 最长边 ≥ 最短边 1.6 倍（像鱼，不像球） | 鱼 |
| `fish-animation` | **不带内置动画剪辑** | 鱼 |
| `feeding-range` | 九个参数全落在区间内且不需要乱序回退 | 投喂 |

两条判据值得单独说明：

- **`fish-animation` 是硬拦截而不是提示。** 引擎用顶点行波驱动泳姿，GLB 里再带一条 `Swim` 剪辑，两个变形会叠加成双倍扭曲——肉眼上像鱼在抽搐。所以「带剪辑的鱼」不是更好，是更差。
- **`scape-passage` 量的是水面积而不是缸底面积。** 占位体的目的是给鱼留通道，鱼活动在水体里，所以分母取水面横截面积。

`FEEDING_TABLE` 与 `normalizeFeedingParams` 共用 `FEEDING_PARAMS`，因此「skill 正文写的区间」「界面提示的区间」「体检拦截的区间」永远一致。

## 8. 登记与下线：`scripts/custom-asset.mjs`

五条命令：

```powershell
node scripts/custom-asset.mjs list
node scripts/custom-asset.mjs audit --id fish.rainbow --file assets-src/models/fish/rainbow.glb
node scripts/custom-asset.mjs add --id fish.rainbow --file <路径> --display-name 虹彩鱼 --license CC0 --author you --params '{...}'
node scripts/custom-asset.mjs check
node scripts/custom-asset.mjs archive --id fish.rainbow
```

| 命令 | 行为 |
| --- | --- |
| `list` | 打印全表（id / 类别 / 来源 / 面数 / 名称），末尾给出条数与定制数 |
| `audit` | 只跑体检，不写任何文件；不通过时退出码非 0 |
| `add` | **先跑体检，不通过不写清单**；通过后写入条目（内置在前、定制前插按时间倒序），并提示 `npm run build` |
| `check` | 清单 ↔ 文件 ↔ 预算三方对账：清单条目是否有对应 `.glb`、目录里是否有未登记的资产、每条定制是否仍在预算内 |
| `archive` | 把 `.glb` 移入 `assets-src/custom-archive/<日期>/`，写 `archive.json`，移除清单条目，打印恢复命令 |

`archive` **不物理删除**，只移动 —— 工作目录不在 git 里时删除不可逆，而「下线」的需求里从来不包括「我要找不回来」。它会明确打印恢复步骤：

```
回退（恢复）步骤：把文件移回 assets-src/models/fish/rainbow.glb，
再执行 node scripts/custom-asset.mjs add --id fish.rainbow --file <该路径>
```

`add` 的写入顺序（内置在前、定制倒序前插）意味着最新的定制资产出现在设置页列表顶部，与用户的心理顺序一致：刚做出来的最容易找。

## 9. 场景侧装配

五个维度在 `src/scene.js` 里的接法互不相同，因为它们的「替换粒度」不同。

### 缸体：换外壳，不换判定

四片玻璃与底座被拆成两组：`glassPanels`（四片玻璃 + 底座）与 `shellDecor`（可隐藏的装饰件）。定制缸体生效时：

- `glassPanels` 的材质换成 `glassHitOnly`（不可见但保留射线命中），**敲击与拖动判定照旧**；
- `shellDecor` 隐藏；
- 定制资产 `add` 到 `tank` 节点下。

底砂与水面的焦散是刻意保留的：底砂属于造景维度，水面是水体契约的一部分。

### 灯具：接管射灯，不新增光源

灯具比缸体麻烦——它不只是外观，还带光照。定制灯具生效时：

1. 隐藏内置的 `lampStem / lampArm / lampTop / bulb`，并把内置 `beam` 光锥置为 `visible = false`；
2. **保留 `spot` 这个唯一的聚光灯**，只按清单参数改 `color`（色温经 `kelvinColor()` 转 sRGB）、`angle`、`penumbra`、`target`；
3. 把定制资产里名字匹配 `/bulb|tube|glow|?lamp_?light/i` 的网格换成自发光材质，存进 `customGlow`；
4. `animateMaterials()` 里统一驱动：`spot.intensity = light * 0.44 * lampGain`，`customGlow` 的 `emissiveIntensity` 跟随同一条 `light` 曲线。

这样「关灯」对定制灯具同样有效，不需要定制资产自己实现调光。

### 造景：同一套摆位算法跑两遍

`createCustomScape(preset)` 复用 `scapeLayoutOf()`：把清单里的 `layout[]`（厘米→米）逐处摆放，`index > 0` 时用 `root.clone(true)` 复用几何，返回与内置 `createScape` 完全同形的对象：

```js
{ id, group, airStone, collision, motion, stats, update, setQuality }
```

同形是关键——下面对 `scape` 的所有调用（碰撞求解、水草摆动 uniform、省电降频、出气点位置）都不需要知道它是内置还是定制。

### 鱼群：接到两个内置鱼种之后

定制鱼种被追加进 `schools`，每个条目带 `custom: preset.id`。两个细节：

- **喂食索引要接着排**：`feedingIndexOffset` 从 `SPECIES.neonTetra.count + SPECIES.clownfish.count` 起累加，否则定制鱼会跟内置鱼抢同一个食物槽位，表现为「两条鱼同时叼同一颗」。
- **`space` 必须用米制的 `SPACE`**，不能用清单的 `TANK_BOX`（厘米制且没有 `floorY`）。这条踩过坑，见 §10。

`snapshot()` 里的 `custom.fish` 报的是已下水的定制鱼种 id 列表；`custom.roots` 只统计缸体/灯具/造景这类直接挂在 `tank` 下、需要单独释放的根节点——鱼由 `School` 持有，`School.dispose()` 会遍历回收几何与材质，不重复登记。

### 投喂习惯：就地改权重，不重建场景

`FEEDING` / `STARTLE` 原本是 `Object.freeze` 的模块常量，P5 改成「可变对象 + `FEEDING_BASE` 基线」：

```js
export function applyFeedingPreset(params) { /* ...返回 { ...FEEDING, repaired } */ }
export function resetFeedingPreset()     { /* 回到基线 */ }
```

场景 api 暴露 `setFeedingPreset(params)`，同时应用 feeding 与 startle 两组参数并返回 `repaired` 列表。客户端用 `useEffect` 监听 `feedingPresetId` 调它，**不进 `createScene` 的依赖数组**——重建场景会让鱼瞬移，也会打断正在进行的抢食。

## 10. 一次实测与一次事故

### 端到端实测

用一条 508 面的金鱼 GLB 当探针（`fish.gold-probe`，3 尾，`targetLength 0.06`），跑 `npm run p5:check`：

```
ok   built-in scene has no custom roots
ok   built-in scene counts both schools
ok   custom fish id reaches the scene
ok   custom fish is owned by its school, not the asset list
ok   custom fish joins the school            (7 → 10 尾)
ok   custom species reports a behaviour
ok   custom fish position is finite
ok   custom fish stays inside the glass
ok   unknown scape falls back to a real preset
ok   unknown tank falls back
ok   unknown lamp falls back
ok   fallback scene still renders fish
ok   out-of-range feeding values are repaired
ok   repaired values fall back to the built-in feel
ok   feeding switch keeps the same fish
ok   feeding switch keeps the same scape
```

探针资产验证完即下线（`archive`），随包不携带任何定制素材。

### 事故：定制鱼的 y 坐标变成 NaN

**现象**：定制鱼能入缸、条数对、x/z 正常，但 `y` 恒为 `NaN`（JSON 里显示成 `null`），朝向恒为 0，控制台抛 `TypeError: Cannot read properties of null (reading 'x')`。

**根因**：`customSpeciesOf()` 把清单的 `TANK_BOX` 直接当成了鱼的模拟空间。`TANK_BOX` 是**厘米制**外框（`width: 40`），且没有 `floorY` 字段；而鱼群求解器要的是米制 `SPACE`（`floorY: 0.018`）。于是：

```js
path.y = THREE.MathUtils.clamp(path.y + f.height, floorY + 0.022, waterY - 0.018);
//                                            undefined + 0.022 = NaN
```

`Math.max(NaN, x)` 恒为 `NaN` → 整条鱼的 y 被打穿 → 位移向量含 `NaN` → 朝向计算 `lengthSq()` 返回 `NaN`，与任何数比较都是 `false`，所以朝向分支整个被跳过（`yaw/rx/rz` 保持 0）→ 下游某处读到 `null` 坐标继续炸。

**修复**：`customSpeciesOf` 的 `space` 改为直接引用 `src/core.js` 的米制 `SPACE`，并在代码里写明「`TANK_BOX` 是厘米制、没有 `floorY`，不能当 `space`」。

**为什么单测没抓到**：这是数据形态问题，纯函数测试只校验「`space` 有值」，不校验「单位对不对」。真正抓到它的是 `p5:check` 里那句 `Number.isFinite(x/y/z)` —— 现在的判据把「位置是有限数」写成了显式断言，就是为了守住这条。

**另一个坑（排查成本更高）**：预览页面里的 3D 场景走 `require.async('./client.scene.js')`，加载的是 `lib/` 下的**构建产物**。改完 `src/` 不 `npm run build` 就直接跑校验，看到的永远是旧代码——第一轮「改了还是 NaN」整整多花了一轮。凡是校验结果与源码改动不符，先确认产物时间戳。

## 11. 设置页：五个维度一块，每个数字都对得上

### 为什么砍掉「场景」和「造景与生物」两块

原来页面是 5 个区块：场景（缸体/灯具/造景）、造景与生物（鱼群/投喂习惯）、AI 定制、显示与光照、Token 统计。前两块和 AI 定制在做同一件事的两半——**挑一个现成的**，和**让 AI 做一个新的**。同一件事出现在页面两处，用户得先想「我要换造景，该去哪个块」。

现在合成一块「AI 定制」，每个维度一行：

```
水草与造景                                     [水草丛林 ▾]  [AI 定制]
新增一套石木水草布局与出气点
```

左边是「这是什么维度」，右边两个控件是「换一个」的两种做法。页面高度少了约 380px（`scrollHeight` 2072 → 1693）。

鱼群那行特殊：内置两种鱼常在，定制鱼种是**逐条上下水**而不是替换，所以它的子行（紧跟在鱼群下面）保留「加入缸里 / 移出」按钮。没有定制鱼种时这些子行不渲染。

三个实现细节：

- **控件与按钮包在 `.dsh-aq-row-tail` 里**，选择框定宽 168px，五行右缘才对齐；不定宽时每个下拉按内容伸缩，看着像没对齐。
- **窄窗口（≤720px）** 让 `row-tail` 整块换到下一行右对齐，否则 5 行 × 3 个元素会挤成两截。
- **`sceneSection` / `lifeSection` 两个文案键删掉**，`smoke` 里反向断言 `dsh-aq-scene` / `dsh-aq-life` 两个锚点不再出现。

### 统计为什么「看着不对」

原来的账本只暴露两个数：已兑换、待投喂。用户喂掉 5 勺之后看到「已兑换 10 勺 / 待投喂 5 勺」，很自然会问少的那 5 勺去哪了——**账本没错，是页面少给了一个数**。

现在补齐成三行，并满足一条恒等式（初装那 5 勺只进「已投喂」，不进「已兑换」）：

```
已兑换 10 勺 · 2 次
已投喂 5 勺
待投喂 5 勺
        ↑ 已投喂 + 待投喂 = 初装 5 勺 + 已兑换
```

为此账本新增 `delivered` 计数（`token-ledger.js` + `host.js` 的 Ledger schema）：

| 位置 | 行为 |
| --- | --- |
| `takePellets(space)` | `delivered += room`（真正被场景接收的那部分） |
| `refund(count)` | `delivered -= count`（场景拒收 = 没真落水，计数要退） |
| `reset()` | 归零，与其它账目一起重开 |
| `isLedgerState` | `delivered` 可选；旧载荷缺它按 0 起算，不阻塞升级 |

另外把「兑换次数」从待投喂行挪到已兑换行（`10 勺 · 2 次`），待投喂行只留一个纯数字。

### 投喂：三个真 bug 与「库存制」

用户报了三件事：**投喂之后鱼食数没有扣减 / 设置页「已投喂」「待投喂」不计数 / 悬浮按钮徽章不显示鱼食数**。三句话是同一个根因的三种症状。

**根因**

| # | 问题 | 后果 |
| --- | --- | --- |
| 1 | 手动点缸口走 `sim.feed()`，直接往水体加 4 粒，**完全没经过账本** | 喂多少次库存都不动；P1 的自由投喂和 P4 的账本从来没接上线 |
| 2 | `pump()` 在场景创建、`onStats`（2s 一次）、每轮轮询三处自动调用 | 开缸瞬间把队列倒空：`foodQueue` 变 0 → 徽章条件 `foodQueue > 0` 不成立 → 徽章消失；「待投喂」恒为 0 |
| 3 | `delivered` 只在 `pump()` 里增长 | 手动投喂不计入，「已投喂」停在自动投放的那几个数 |

顺带修掉一处静默漏更新：`publishLedger()` 的去重比较只比了 6 个字段，**漏了 `delivered`**，只改 `delivered` 的更新不会通知订阅者。

**修复**

| 位置 | 改动 |
| --- | --- |
| `src/scene.js` | 投喂前先问 `options.takeFood(1)`（一勺）；返回 0 就 `onFeed('empty')`、一粒不落；否则落 `LIMITS.batch × 勺数` 粒，并把结果与实际勺数回传 `onFeed(result, scoops)` |
| `src/client.jsx` | `takeFood()` = `ledger.takePellets(want, 1)` + `publishLedger()`；`onFeed` 里被场景拒收（缸满 / 150ms 连点）就 `refund` 并 `persist(true)`——投放是已花掉的库存，必须立刻落盘；**删掉三处 `pump()`** |
| `src/core.js` | `feed(point, now, count)` 支持投指定粒数，一勺默认 4 粒 |
| `src/token-ledger.js` | `takePellets(space, step)` 加步长参数：默认整单位（自动投放的原契约不变），手动投喂传 `step = 1` |
| `src/locales.js` | 新增 `empty`：「鱼食已喂完，攒满 5M token 再换 5 勺」 |

**证据**（`npm run probe:autofeed`，`errors: []`）

```
关缸（初装）   queue 5 勺 · delivered 0 · 徽章 5
开缸后         queue 5 勺 · 缸里 0 粒        ← 不再自动倒空
喂 1 次后      queue 4 勺 · delivered 1 · 缸里 4 粒
喂 5 次后      queue 0 勺 · delivered 5 · 缸里 20 粒   ← 一勺一勺喂完
喂 6 次后      提示「鱼食已喂完」，账本不动
关缸再兑换     queue 5 勺 · 徽章 5
```

`probe:feeding` 与 `probe:tap` 都靠手动投喂喂出食物，现在开头要先攒一批库存（`setTokens(0)` 建基线 → `setTokens(6M)` 换 5 勺），否则点水面投不出东西。

### 界面上的「4」不是库存

紧接着又报一条：「页面中写着 4 粒鱼食，但点击投喂告诉我鱼食为零」。查下来是两处都在显示**别的数字**，从不显示库存：

| 位置 | 原来 | 问题 | 现在 |
| --- | --- | --- | --- |
| 全屏左侧鱼食罐按钮 | 写死 `粒 · 4` | P1 时代它是「每批投 4 粒」的说明，读起来就是「还有 4 粒」；库存为 0 时仍显示 4 | 读账本：`库存 5 勺`；为 0 时直接写 `已喂完`。带 `data-stock` 属性供探针定位 |
| 右下角角标 | `活动鱼食 4 / 100 · 55 FPS` | 那是**缸里正在漂的颗粒数**，25 秒内被吃光就归零，跟库存无关 | `缸内鱼食 4 粒 / 100 · 库存 0 勺 · 55 FPS`，两个数各带单位，不再互相冒充 |

`probe:autofeed` 相应加了三条断言：开缸后按钮副标题必须是「库存 5 勺」、角标必须同时含「库存 5 勺」、喂空后按钮必须变成「已喂完」。这类「文案冒充数字」的问题单测抓不到——账本全对、界面全错——只能靠端到端断言钉住。

### 库存单位：粒 → 勺

用户接着提了两件事：**「粒」这个词把库存和颗粒混为一谈**，而且**点一下就把 4 粒库存花掉**，初装 5 粒只够点一次多一点。于是把库存单位独立成「勺」，颗粒仍叫「粒」：

| 概念 | 单位 | 说明 |
| --- | --- | --- |
| 鱼食罐库存 / 已兑换 / 已投喂 / 待投喂 | **勺** | 账本只记勺数：`foodQueue`、`earned`、`delivered`、`SCOOPS_PER_UNIT = 5`、`WELCOME_SCOOPS = 5`、`QUEUE_CAP = 100` |
| 落进水里的食物 | **粒** | 一勺 = `LIMITS.batch` = 4 粒；缸内上限仍是 100 粒 |

一次点击 = 舀一勺 = 扣 1 个库存、落 4 粒。5 勺能连喂五次，而不是「一次 4 粒、第二次就空」。

代码上的三个关键点：

- `token-ledger.js` 的 `takePellets(space, step)` 改成 `takeScoops(want = 1)`：不再需要「批量向下取整」，一勺就是一勺；快照里的 `pellets` 字段改名为 `scoops`，语义跟着单位走。
- `scene.js` 只问 `takeFood(1)`，落食量由 `LIMITS.batch * scoops` 决定——账本不该知道一勺几粒，那是渲染层的常数。
- `LIMITS.batch` 保持 4 不动：它现在只表示「一勺几粒」，与库存无关。

## 12. 生效与回退

| 动作 | 需要重启 DSH | 说明 |
| --- | --- | --- |
| 在设置页切换缸体/灯具/造景/投喂习惯 | 否 | 只是换 id，场景就地重建或就地改权重 |
| 定制鱼种「加入缸里 / 移出」 | 否 | 改 `customFishIds`，场景重建鱼群 |
| 新增或下线定制资产 | **是** | `.glb` 在构建期内联，`npm run build` 之后宿主加载到的才是新产物 |

回退有三条路，代价从低到高：

1. **设置页切回内置**：立即生效、不重启、不动文件。适合「做出来了但不喜欢」。
2. **`custom-asset.mjs archive --id <id>`**：资产移入归档目录、清单条目移除。配置文件里残留的 id 由 `resolvePresetId` 回退到同类内置资产，并在设置页标出「已回退」提示——这是 AC-38「下线后回退同类内置资产，不黑屏」的实现。
3. **手写清单条目回滚**：清单是纯 JSON，`presets.json` 在版本控制里，`git checkout presets.json` 即可。

「不黑屏」不是靠 `try/catch` 兜出来的，而是靠**每一层都允许失败**：单个 GLB 解析失败只影响那一个条目（`options.onCustomError`），内置资产永远在清单里且在代码里有对应的程序化实现，所以任何定制资产的失败都不会让缸变空。

## 13. 验收（AC-36～AC-39）

### AC-36 定制入口与交接

| 要求 | 实现 | 证据 |
| --- | --- | --- |
| 设置页五个维度各有入口 | `SettingsPage` 的「AI 定制」区块遍历 `DIMENSIONS` 渲染，按钮带 `data-dimension` | `.screenshots/settings-custom-light-1440.png`；`npm run smoke` 断言五个 `data-dimension` 与「AI 定制」文案 |
| 提示词完整且精简 | 首行 `/skill` token + 一句目标，中间是待填空行，末行批次号 | `npm run preview` 输出 `custom handoff {"promptLength":128,"whenDraftExists":"append"}`；断言首行 token、空行、批次号，并断言长度 < 400 且不含契约细节 |
| 主视图切到目标会话、面板关闭 | `ctx.uiWorkspace.startSession(undefined, ...)` 负责导航 | 真实宿主行为待在 `verify:host` 里确认（见「未闭环项」） |
| 原草稿只追加不清空 | `whenDraftExists: 'append'` | `npm run preview` 断言 `lastHandoff().options.whenDraftExists === 'append'` |
| 重复点击不产生两份任务 | 草稿末行写「（批次 <id>-<维度>：这段内容重复出现时只做一次）」 | `buildBatchId` 单测；预览里连续两次交接得到两个不同 batchId、相同维度 |
| 工作区不可用时明确提示 | `handoffBlockers` 四个原因码 + 四条文案，按钮下方就地显示 | `handoffBlockers` 单测覆盖四种触发 |

### AC-37 定制闭环

「按钮 → 会话 → 资产 → 体检 → 选择 → 生效」六步的真实链路已在鱼种维度走通一次（§10），并留下三类证据：

- 清单条目：`custom-asset.mjs add` 写入的记录（`origin: "custom"`、`triangles`、`license`、`params`）；
- 设置页：鱼群行下方的子行「测试金鱼 / `fish.gold-probe` · AI 定制 · 3 条」+「加入缸里」（`.screenshots/settings-light-1440.png`）；
- 场景：`p5:check` 的 `custom fish joins the school`（7 → 10 尾）与 `custom fish stays inside the glass`。

### AC-38 定制安全与回退

| 场景 | 结果 | 证据 |
| --- | --- | --- |
| 模型写入非白名单路径 | 提示词【路径】段列出白名单并写「白名单之外的文件一律不要碰」；skill 正文重复一遍 | 模板断言 |
| 体检不通过 | `add` 先跑 `auditCandidate`，不通过直接退出、不写清单 | `audit` 单测覆盖各判据；CLI 的 `add` 里先 audit 后写 |
| 生效失败 | 单条解析失败只触发 `onCustomError`，其余资产与内置资产照常 | `p5:check` 的 `unknown * falls back` 三条 |
| 下线已启用资产 | `archive` 移除条目，`resolvePresetId` 回退 `DEFAULT_PRESET_IDS`，设置页标「已回退」 | `p5:check` 的 fallback 三条 + `resolvePresetId` 单测 |

### AC-39 契约稳定性

| 要求 | 结果 |
| --- | --- |
| 旧配置与旧资产全部可用 | `normalizeConfig` 只校验形状，未知 id 原样保留并交给运行时回退，因此旧配置文件不需要迁移 |
| 内置资产文件与清单条目未被改写 | 体检只读；`add` 只在数组里前插定制条目；`archive` 只动定制条目。`custom-asset.mjs check` 会报出内置条目的缺失或多余 |
| 定制资产可再次被选中 | 清单条目保留 `origin: "custom"` 与 `createdAt`，列表按时间倒序，可反复切换 |

### 回归套件

```powershell
npm test              # 75 项单测（定制契约 14 项 + 既有 61 项：输入仲裁、水面、时钟、造景、投喂、Token）
npm run build         # 生成 lib/client.js + client.scene.js + 定制 bundle
npm run smoke         # 桩宿主：槽位、图标、设置页、五个定制入口
npm run preview       # 本机 Edge：短草稿、交接参数、AI 定制区块截图
npm run p5:check      # 定制资产端到端：入缸、回退、投喂习惯就地切换
npm run probe:scape   # P3 回归：三预设渲染、水摆、避让、资源回收
npm run probe:feeding # P4 回归：真实吃食、发现/聚集/抢食/散开
npm run probe:tap     # P4 回归：敲击受惊、急逃、平复
npm run probe:autofeed # 投喂库存闭环：兑换只入队、开缸不倒空、投喂扣库存、空罐有提示
```

### 未闭环项（需要在真实宿主里确认）

- **`startSession` 的导航行为**：预览里是桩，只记录参数；真实宿主是否立即切换到 Conversation、是否关闭设置面板，需要 `DSHAQ_URL` 指向同版本 DSH 跑 `npm run verify:host`。
- **`whenDraftExists: 'append'` 的实际合并效果**：桩不模拟草稿合并，需要在有未发送草稿的会话里连点两次，确认原文还在、两段提示词按序追加。
- **宿主是否发布 bundle 重建通知**：如果宿主能感知 `lib/` 变化并热重载，那么「重启 DSH 才生效」这句文案可以放宽成「刷新即可」。当前文案取保守说法。

## 14. 边界与后续

- 定制是**多轮对话任务**，不是一次点击就出的流水线。模型可能给出方案后停下等确认，也可能中途失败；失败时清单没变、鱼缸照旧，按提示词里的回报格式重来即可。
- 参考图不能程序注入。提示词里明确写了「图片由我拖进会话」，因为插件没有往会话里塞附件的通道。
- 一次只改一个维度。想同时换缸又换鱼，就点两次按钮、走两个会话——两个批次在清单上不冲突（一个写 `tank.*`、一个写 `fish.*`），并行也不会撞车。
- 后续可做：定制资产的缩略图（当前列表只有文字）、把体检结果回写到设置页（现在只在 CLI 输出）、造景的「自由摆放单株」——后者需要先解决水草实例化与碰撞的交互，不属于 P5。

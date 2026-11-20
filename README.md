# 小鱼缸 Tiny Tank（DSH 三维鱼缸）

DSH 桌面工作台里的透明三维鱼缸。左侧导航栏多一页「定制」，右下角多一个圆形鱼缸入口：点进去是铺满窗口的玻璃缸，可以拖动旋转、滚轮放大、单击玻璃把鱼惊一下，也可以舀一勺鱼食喂它们。鱼食不是白给的——DSH 的 Token 用量每满 5M 换 5 勺，装好就先送 5 勺。

> 正式名：**小鱼缸**（英文名 **Tiny Tank**）。包名与插件 id 是 `dsh-eco-aquarium` / `eco-aquarium`；界面上一律用「小鱼缸」，侧栏那一页叫「定制」。
>
> - 想定制缸体、灯具、造景、鱼种或投喂习惯 → [AI 定制工厂](https://github.com/329604421/dsh-eco-aquarium/blob/main/docs/P5-AI定制工厂.md)
> - 想调整投喂手感、受惊动作、接入新鱼或替换鱼食罐指针 → [投喂习惯与动作制作指南](https://github.com/329604421/dsh-eco-aquarium/blob/main/docs/P4-投喂习惯与动作制作指南.md)

## 安装

在已安装 `dsh` 的环境里二选一：

```bash
# ① 从 npm 装（推荐）：装完即用，不触发构建授权
dsh plugin --profile desktop add dsh-eco-aquarium
```

```bash
# ② 从源码装：要自己 build；只有这条路能用「AI 定制工厂」
git clone https://github.com/329604421/dsh-eco-aquarium.git
cd dsh-eco-aquarium && npm install && npm run build
dsh plugin --profile desktop add "$PWD"
```

桌面版也可以在 DSH 里走 **插件 → 添加插件**，选择本地插件目录。

装完重启 DSH（桌面版 `Ctrl+R`，或退出重开）：左侧导航栏出现鱼缸图标（与「插件」「自动化任务」同级），主界面右下角出现圆形鱼缸按钮。替换已装版本后必须重启，客户端 JS 才会加载新一代模块。

> ⚠️ `--profile` 要填**本机真实存在的 profile 名**，先看一眼：`ls ~/.dsh/profiles/`。
> 桌面版是 `desktop`，`dsh web` 命令行版是 `web`。填一个不存在的名字不会报错，只会静默建一个空 profile 并装进去——表现就是「装上了，但界面里什么都看不见」。
>
> 这里的 `--profile` 与 `package.json` 里的 `dsh.client.platform: "web"` 是两件不同的事：前者由你选、指 profile 目录；后者由插件声明、只认 `"web"`（桌面版与命令行版共用同一套浏览器界面）。

## 长什么样

| 投喂：一勺 4 粒，鱼群错峰抢食 | 全屏观赏：可拖动、可放大到 2.2× |
| --- | --- |
| ![投喂](https://raw.githubusercontent.com/329604421/dsh-eco-aquarium/main/docs/screenshots/01-feeding.png) | ![全屏](https://raw.githubusercontent.com/329604421/dsh-eco-aquarium/main/docs/screenshots/02-fullscreen.png) |
| **定制页：五个维度各一行，右边可换现成的或让 AI 做一个新的** | **Token 统计：已兑换 / 已投喂 / 待投喂 三个数能自己对上** |
| ![定制页](https://raw.githubusercontent.com/329604421/dsh-eco-aquarium/main/docs/screenshots/03-customize.png) | ![Token](https://raw.githubusercontent.com/329604421/dsh-eco-aquarium/main/docs/screenshots/04-token.png) |
| **灯光跟随宿主深浅色自动判断** | **放大后画面沿圆形边界模糊收边** |
| ![深色](https://raw.githubusercontent.com/329604421/dsh-eco-aquarium/main/docs/screenshots/05-dark.png) | ![放大](https://raw.githubusercontent.com/329604421/dsh-eco-aquarium/main/docs/screenshots/06-zoom.png) |


## 运行环境

- 宿主：DSH Desktop 0.2.2-rc.3（同版本官方 Web GUI 亦可用于验收）
- 渲染：Three.js（WebGL2），随包内联，按需懒加载，运行时不联网
- 槽位：`sidebar.panellist`（导航行）+ `main`（定制页）+ `shell.overlay`（悬浮入口与全屏视图）
- 配置：插件 volatile Config，经 `ctx.configForms` 原子读写
- Node：≥ 22.19（仅源码安装与构建时需要）

## 两个入口

职责分开：

- **左侧导航栏 →「小鱼缸」定制页**：切换缸体 / 灯具 / 水草与造景 / 鱼群 / 投喂习惯，调灯光、画质与 Token 统计；页内「外观与手感」区块把五个维度的定制请求交给新会话。
- **右下角悬浮 logo → 全屏鱼缸**：日常看鱼、拖动、敲击、投喂的玩法入口，背后是玻璃拟态的半透明遮罩。悬浮按钮是原样的鱼缸线稿 logo，按钮**整个圆**会被水从下往上逐步填满，填满比例就是下一次兑换的进度：每满 5M token 装满一次，自动换 5 勺鱼食存进「鱼食罐」，右上角的琥珀棕计数徽章显示库存勺数，喂一次少一勺；刚装好时徽章已经是 5，第一次开缸就能喂。

## 定制页

页眉只有一行小字「定制」、应用名与一句话说明；页面按「外观与手感 / 显示与光照 / Token 统计」三块排列。

| 区块 | 内容 | 当前状态 |
| --- | --- | --- |
| 外观与手感 | 五个维度各一行：左边是现在用的，右边可以换一个现成的，或点「做一个新的」让 AI 做一份 | 缸体/灯具/造景/投喂习惯是下拉，鱼群是只读摘要 + 定制鱼种逐条上下水；已登记的定制件带「定制」标记 |
| 显示与光照 | 灯光模式（跟随主题 / 常亮 / 常灭）、渲染质量（自动 / 标准 / 省电） | 可用，写入本机配置 |
| Token 统计 | 页首概览（累计用量 / 待投喂 / 距下次兑换 + 进度条）；明细含统计起点、已兑换、已投喂、待投喂、重置统计 | 可用；「已投喂」让「已投喂 + 待投喂 = 初装 5 勺 + 已兑换」能自己核对 |
| 看鱼缸 | 「打开鱼缸」按钮 | 可直接拉起全屏鱼缸 |

## 全屏鱼缸

点右下角悬浮按钮进入，`Esc` 或点空白处关闭。操作栏竖排在左侧中部，画布铺满整个窗口（底部只保留一行操作提示），右侧留出完整的宽屏观赏区。视图下方铺一层深色半透明遮罩：浅色 `rgba(23,41,32,.54)`、深色 `rgba(3,9,6,.72)`，叠加 `backdrop-filter: blur(20px) saturate(1.05)`。宿主正文被压成柔和的色块（仍可感到"后面有东西"），玻璃缸与底砂始终有对比度。

| 操作 | 结果 |
| --- | --- |
| 左右拖动缸体 | 绕竖直轴旋转，水面产生延迟、可衰减的晃动 |
| 滚轮 / `+` `-` | 以当前尺寸（1.0×）为最小尺寸放大到 2.2×；放大后画面沿圆形边界模糊收边 |
| 单击玻璃 | 出现局部敲击光圈；鱼群按距离错峰受惊，远离敲击点急逃，约 1～3 秒平复后恢复游动；抢食中的鱼会先避让再重新觅食 |
| 灯光按钮 | 本次查看内切换开 / 关，可「恢复自动」；默认值来自定制页 |
| 鱼食罐 → 点击缸口 | 库存按「勺」计：点一次舀一勺，落进水里是 4 粒一小撮，不会一次倒空；指针变为倾斜小罐，水面上方进一步倾斜；鱼群聚集抢食后分组散开；再次点击或 `Esc` 退出。按钮副标题显示当前库存（`库存 4 勺`），为 0 时直接写「已喂完」，右下角角标同时给出「缸内鱼食 4 粒 / 100 · 库存 4 勺」 |
| Token 统计块 | 显示累计用量、距下次兑换与进度条；「重置统计」需二次确认（5 秒内再点一次，超时自动撤销） |
| 点击空白遮罩 / 关闭按钮 | 关闭并恢复原焦点 |

投喂上限 100 粒，最小间隔 150ms；鱼群按距离在约 0.3～1 秒内错峰响应，共享目标但采用不同接近角度，同一颗粒只会被成功消费一次。食物耗尽后约 3～5 秒分组散开并回游；未吃完的颗粒约 25 秒后自然淡出。

渲染质量已从全屏视图移到定制页：全屏视图不再暴露会改变画质的控件，左侧那一格改为 Token 统计与重置入口。

左下角常驻一行出处说明：鱼缸、鱼群与布景由 Kimi 3.1 Pro 编写，程序代码由 DeepSeek-V4.1 Flash 编写；并提示如果要做定制，请在此基础上换用更前沿的模型。窄窗口下它也不会被隐藏（只有缸体说明与角标会收起来）。

## Token 投喂

Token 用量换鱼食，全程本地进行，不联网、不计费：

| 环节 | 规则 |
| --- | --- |
| 采样 | 每 1 分钟读一次会话列表的 `tokenUsage` 投影；父会话与子代理一起算；不补读没打开过的会话 |
| 起点 | 插件安装或上次重置的时刻；某会话首次被看到时只记基线，之前的用量不计 |
| 初装 | 新账本自带 5 勺鱼食，装好就能连喂五次，不必先攒 5M；这 5 勺只算库存、不算「已兑换」 |
| 兑换 | 每满 5M token 换 5 勺，余量保留；鱼食罐上限 100 勺，满了就先攒着 |
| 投放 | 由你点缸口喂，开缸不会自动把库存倒空：**点一次只舀一勺**，一勺落 4 粒；库存为 0 时提示「鱼食已喂完」，攒够 5M 自动补 5 勺 |
| 展示 | 悬浮按钮被水填满的比例 = 未兑换积攒的比例，填满即兑换；右上角徽章 = 库存（待投喂）的鱼食数，喂一次少一批、初装就是 5；全屏视图与定制页有精确数值 |
| 重置 | 定制页或全屏视图内二次确认；清空累计与待投喂、统计起点改为当前时间、重新发放 5 勺初装鱼食，缸里的鱼食不受影响 |
| 对账 | 定制页同时给「已兑换 / 已投喂 / 待投喂」三个数（单位都是勺），满足 `已投喂 + 待投喂 = 初装 5 勺 + 已兑换`；投放即刻落盘，重启不会把喂过的鱼食退回来 |

统计结果写在插件配置的 `ledger` 字段里（与 `scapePresetId` 同一条通道），所以重启、换设备窗口都不会清零；后台进度每 5 分钟落盘一次，兑换与重置立即落盘。

## 配置字段

| 字段 | 取值 | 行为 |
| --- | --- | --- |
| `schemaVersion` | `1` | 结构版本，未知值回退 |
| `tankPresetId` | `tank.clear-40` 或已登记的 `tank.*` | 内置长方缸或定制缸体；清单里找不到时回退内置并提示 |
| `lampPresetId` | `lamp.arch` 或已登记的 `lamp.*` | 内置夹式射灯或定制灯具；同上回退 |
| `scapePresetId` | `scape.moss` / `scape.jungle` / `scape.driftwood` 或已登记的 `scape.*` | 苔藓石景 / 水草丛林 / 沉木疏林（默认水草丛林）或定制造景；同上回退 |
| `feedingPresetId` | `feeding.standard` 或已登记的 `feeding.*` | 内置投喂手感或定制手感；切换时只改行为权重，不重建场景 |
| `customFishIds` | `fish.*` 数组 | 已下水（`加入缸里`）的定制鱼种；每条 1～6 尾，挂在两个内置鱼种之后 |
| `lightMode` | `auto` / `on` / `off` | 定制页持久化；全屏视图内的手动开关只影响本次查看 |
| `qualityMode` | `auto` / `standard` / `eco` | 定制页持久化；全屏视图不再提供该控件 |
| `ledger` | `{ v, epochAt, observed, pending, foodQueue, earned, exchanges, baseline }` | Token 统计账本；整块原子写入，`baseline` 为 `[sessionId, tokens]` 列表（上限 200 条） |

这五个 id 字段都只校验形状（非空字符串 / 字符串数组），不对着内置枚举硬校验：定制条目可以被下线，而配置文件里残留的 id 必须在运行时回退到同类内置资产，而不是把鱼缸开成空白。

## 开发与验证

```powershell
npm install
npm test              # 输入仲裁、粒子、水面、时钟、灯光等单元回归
npm run build         # lib/client.js + 懒加载 lib/client.scene.js
npm run smoke         # 用桩宿主加载构建产物，校验三个槽位与页面渲染
npm run preview       # 用本机 Edge 截图悬浮层、入口水位、定制页与导航图标
npm run scape:manifest # 从布局源数据同步 P3 植物与石木清单
npm run probe:scape   # 三预设渲染、水摆、避让、投喂与资源回收判据
npm run probe:feeding # 真实吃食、发现/聚集/抢食/散开与双态罐指针验收
npm run probe:tap     # 真实敲击、受惊/急逃/平复与单次事件响应验收
npm run probe:autofeed # 鱼食库存闭环：兑换只入队、开缸不倒空、投喂扣库存、空罐有提示
npm run p5:check      # 定制资产端到端：入缸、未知 id 回退、投喂习惯就地切换
npm run verify:host   # 需 DSHAQ_URL 指向同版本官方 DSH Web GUI
npm run pack:plugin   # 生成 releases/dsh-eco-aquarium-0.2.0.tgz
```

定制资产的日常操作走一条 CLI（体检、登记、下线、对账）：

```powershell
node scripts/custom-asset.mjs list                     # 清单全表，标出内置/定制
node scripts/custom-asset.mjs audit --id fish.rainbow --file assets-src/models/fish/rainbow.glb
node scripts/custom-asset.mjs add --id fish.rainbow --file assets-src/models/fish/rainbow.glb `
  --display-name 虹彩鱼 --license CC0 --author "you" --params '{"targetLength":0.055,"count":3}'
node scripts/custom-asset.mjs check                    # 清单 ↔ 文件 ↔ 预算三方对账
node scripts/custom-asset.mjs archive --id fish.rainbow  # 下线：资产移入 assets-src/custom-archive/<日期>/
```

`verify:host` 在真实宿主中检查懒加载、透明 WebGL2、volatile 配置、敲击/旋转/投喂、主题联动、上下文丢失、资源回收等，并把截图、录屏与 `host-results.json` 写入 `docs/evidence/`。`npm run preview` 不需要宿主，直接渲染同一份构建产物，产物落在 `.screenshots/`。

## 权限与外部服务

装之前值得知道它碰什么、不碰什么：

| 项目 | 说明 |
| --- | --- |
| 网络 | **不联网**。Three.js、鱼与造景的 `.glb`、贴图全部在构建期内联进 `lib/`，运行时不发请求、不加载远程资源 |
| 外部服务 | **没有**。不需要任何 API key、账号、遥测或云存储 |
| 读什么 | 会话列表的 `tokenUsage` 投影（只有数字，只读，用来算鱼食），以及自己的插件配置 |
| 写什么 | 只有自己的插件配置（`ledger` / 五个预设 id / `lightMode` / `qualityMode`）。绝不写你的会话内容、仓库或其它插件 |
| AI 定制工厂 | 唯一会写文件的功能，而且只写本插件目录下的 `assets-src/models/` 与 `presets.json`，随后要你手动 `npm run build` 才生效。它需要**源码安装**；npm 安装的副本里点「做一个新的」，skill 会告诉你去 clone 仓库 |
| 重置 | 定制页「重置统计」只清本插件的 Token 账本，不动会话数据 |

## 当前已知边界

- 五个维度都能定制，但**定制只改外观与手感**：缸体外框、水面高度、可游动范围、玻璃敲击面、食物与投喂坐标都是硬契约，定制资产不得改动。
- 定制素材在**构建期**被打包（esbuild `binary` loader 内联为 `Uint8Array`），因此新增或下线资产后必须 `npm run build` 并重启 DSH 才生效；运行期不读磁盘、不联网。
- 定制鱼种沿用内置的顶点行波泳姿，**不接受带动画剪辑的 GLB**（会与顶点变形叠加成双倍形变）；`Swim` 这类剪辑会在体检里被拦下。
- 一次定制是多轮任务，模型可能中途失败；失败时清单没有变化，鱼缸照旧，按提示词里的回报格式重试即可。
- 以鼠标操作为主，暂不包含音效、触屏与缩放。
- 半透明遮罩依赖 `backdrop-filter`；若宿主关闭硬件加速，会退化为纯色半透明层（仍可读，但看不到背景模糊）。
- 详细验收结果、基线数据与接口契约见 [docs/P1-验收记录.md](https://github.com/329604421/dsh-eco-aquarium/blob/main/docs/P1-验收记录.md)。

## 鱼群：红绿灯与小丑鱼

当前正式鱼群：**红绿灯 ×5**（4 cm 群游、四视图参考的照片重建资产、六区虚拟骨骼）和 **小丑鱼 ×2**
（照片重建资产、分区鳍权重 + 脊柱弯曲、领地式驾驶）。银鲦已撤下，旧 GLB 移到 `.probe/retired/`，不再随包。
缸体与 P1 的交互全部未改动。

红绿灯使用完整侧面重建，正面与俯视图作四角度对照；正式资产 10,000 面、约 372 KB，内嵌 512² 颜色贴图与
256² 法线贴图。`src/neon-tetra.js` 先按烘焙后的解剖坐标划分身体与五种鳍，再驱动头部稳定的身体行波、
尾鳍滞后和胸鳍划水。原始模型、参考图、坐标/贴图处理脚本均在 `scripts/neon-tetra/`；详见
[docs/P2-红绿灯重制.md](https://github.com/329604421/dsh-eco-aquarium/blob/main/docs/P2-红绿灯重制.md)。

小丑鱼最终采用用户认可的多视角照片重建版：20,000 面、901 KB，1024² 颜色贴图 +
512² 法线贴图。它是一张连通网格，`src/clownfish.js` 按体轴/背腹/侧向位置烘焙身体与五种鳍的
分区权重，胸鳍划水、腹鳍慢半拍、尾鳍滞后都绕各自鳍根驱动；身体仍做行进波 + 截面/法线旋转，
`ClownfishPilot` 负责悬停 / 巡游 / 冲刺。程序化 15,336 面版本保留为备选，生成器输出到
`scripts/clownfish/alternates/`，不覆盖正式资产。详见 [docs/P2-小丑鱼重制.md](https://github.com/329604421/dsh-eco-aquarium/blob/main/docs/P2-小丑鱼重制.md)。

鱼的接入不是"把模型丢进来"，而是按 [docs/P2-入缸标准.md](https://github.com/329604421/dsh-eco-aquarium/blob/main/docs/P2-入缸标准.md) 过一遍体检：

| 命令 | 作用 |
| --- | --- |
| `node scripts/audit-fish.mjs` | 对 `assets/p2-src/*.glb` 跑准入体检，输出表格与 `scripts/fish-audit.json` |
| `node scripts/fish-lab.mjs` | 三视图调色台，复刻缸内光照，判断鱼皮与配色 |
| `node scripts/fish-probe.mjs` | 读回鱼群真实状态（泳层 / 位移 / 帧率 / 控制台）做程序化验收 |
| `npm run lab:clown` | 小丑鱼三行调试台：四角度 / 四泳姿相位 / 四近景 |
| `npm run lab:clown:swim` | 一个完整尾拍周期，侧视 / 3/4 / 俯视，检查弯曲与鳍的跟随 |
| `npm run lab:clown:fins` | 按区域给单网格顶点着色，检查身体有没有被误判成鳍 |
| `npm run motion:clown` | 缸内 8 帧联系表（0.35 s 间隔），看悬停—巡游—冲刺的节奏 |
| `npm run lab:neon` | 红绿灯三行调试台：四角度 / 四泳姿相位 / 四近景 |
| `npm run lab:neon:swim` | 红绿灯完整尾拍周期：侧视 / 3/4 / 俯视 |
| `npm run lab:neon:fins` | 红绿灯六区着色，检查胸鳍与身体误判 |
| `npm run motion:neon` | 红绿灯缸内 8 帧联系表（0.35 s 间隔） |
| `npm run asset:neon` | 从保留的红绿灯重建源文件烘焙坐标并压缩正式 GLB |
| `npm run asset:clown:photo` | 从 `scripts/clownfish/source/` 重跑照片贴图调色，生成正式 GLB |
| `npm run asset:clown:procedural` | 重建程序化备选版（输出到 `scripts/clownfish/alternates/`，不覆盖正式资产） |

未入缸的历史候选资产大多没有可用贴图，因此早期曾用物体空间程序化鱼皮做验证。当前红绿灯与小丑鱼均使用
独立照片重建资产和内嵌贴图，不再以通用低模换色代替新鱼种。

资产来源与署名义务见 [assets/p2-src/CREDITS.md](https://github.com/329604421/dsh-eco-aquarium/blob/main/assets/p2-src/CREDITS.md)。需要从参考图片制作新的鱼种时，按
[鱼种 3D 资产构建指南](https://github.com/329604421/dsh-eco-aquarium/blob/main/docs/guides/鱼种构建指南.md) 的流程执行，覆盖多视角重建、坐标校准、分区绑定、材质、动效和验收。

追食、共享食物目标与敲击受惊已在 P4 接入，制作与参数说明见
[投喂习惯与动作制作指南](https://github.com/329604421/dsh-eco-aquarium/blob/main/docs/P4-投喂习惯与动作制作指南.md)；完整群体避让与路径求解仍属后续阶段。
新鱼种不必再改代码：按 [鱼种构建指南](https://github.com/329604421/dsh-eco-aquarium/blob/main/docs/guides/鱼种构建指南.md) 做出静态 GLB，走 `custom-asset.mjs` 体检登记即可入缸，
泳姿由引擎的顶点行波统一驱动（因此仍不接受自带 `Swim` 剪辑的资产）。

## 生态造景

三套预设均由本地程序化几何组成，不加载网络图片或模型：

| 预设 | 组成 | 运行时占位 |
| --- | --- | ---: |
| 苔藓石景 | 6 块层叠石、288 个苔藓实例、67 片低草／阔叶 | 10 |
| 水草丛林 | 后景高草、中景茎草与阔叶、前景矮草、4 块石 | 11 |
| 沉木疏林 | 6 根锥形分枝沉木、4 块散石、58 片点缀草叶 | 14 |

水草使用根部固定、叶尖增益、逐叶异相的顶点动画；省电模式降低摆幅并将更新量化到 15 Hz。
`scene.getCollision()` 输出当前造景的米制占位数据，P3 先做轻量中心避让，P4 再接入完整空间求解。
制作与扩展契约见 [鱼缸造景 3D 资产制作指南](https://github.com/329604421/dsh-eco-aquarium/blob/main/docs/guides/鱼缸造景3D资产制作指南.md)。

## AI 定制工厂

五个维度各有一个「做一个新的」入口，和「当前用哪个」的下拉并排在同一行。点了就跳到新会话，草稿只有三样东西：

```
/aquarium-custom-core /aquarium-custom-tank 帮我给鱼缸换一个新缸体。

外形（方缸 / 圆角 / 异形）：
材质与配色：
参考图（拖进本会话）：

（批次 loyw3v28-tank：这段内容重复出现时只做一次）
```

`/skill-name` 是 DSH 的标准写法：用户消息里任何位置、以空白分隔、指名用户可调用 skill 的 `/name` token，宿主会把那份 skill 的正文整段注入当轮（见 `@deepseek-ai/dsh-tool-skill` 的「用户显式调用」）。所以路径白名单、单位、体检判据、回报格式这些契约全在 skill 正文里，草稿只留用户真正需要自己回答的几项——一屏能看完。

| 维度 | 入口 id | 承载 skill | 交付物 |
| --- | --- | --- | --- |
| 缸体 | `tank` | `aquarium-custom-core` + `aquarium-custom-tank` | `assets-src/models/tank/<slug>.glb` + 清单条目 |
| 灯具 | `lamp` | `aquarium-custom-core` + `aquarium-custom-lamp` | 同上（`lamp/`） |
| 水草与造景 | `scape` | `aquarium-custom-core` + `aquarium-custom-scape` | 同上（`scene/`） |
| 鱼群 | `fish` | `aquarium-custom-core` + `aquarium-custom-fish` | 同上（`fish/`） |
| 投喂习惯 | `feeding` | `aquarium-custom-core` + `aquarium-custom-feeding` | 只改 `presets.json` 的 `params`，不出模型 |

六份 skill 随包注册（`ctx.skills.register`，正文来自 `skills/*/SKILL.md`），`resourceBase` 指向真实目录，正文里的 `{{ROOT}}` 在注册时替换成本机绝对路径——模型拿到的是能直接 `ls` 的路径，不用猜工作区在哪。

模型产出资产后走同一条闸门：`custom-asset.mjs add` 先跑体检（id 形状、文件名与 slug 一致、体积与面数预算、贴图内嵌且 ≤1024、许可已填、缸体尺寸 ±5%、造景不越界、鱼不带动画剪辑、投喂参数区间与乱序），不通过不写清单；通过后内置在前、定制按时间倒序插入，定制页立即出现带「定制」标记的条目。生效需要 `npm run build` + 重启 DSH，因为 `.glb` 是构建期内联的。

回退三条路：定制页切回内置即生效（不重启）；`custom-asset.mjs archive` 下线资产并把配置文件里的残留 id 交给运行时回退；不满意就直接删清单条目重来。

完整实施说明与 AC-36～39 的验收方法见 [docs/P5-AI定制工厂.md](https://github.com/329604421/dsh-eco-aquarium/blob/main/docs/P5-AI定制工厂.md)。



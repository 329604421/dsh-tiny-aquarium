# P4 方案：Token 用量 → 鱼食（5M 兑换 5 勺）

> 状态：**已实现（2026-11-20）**，实现与本文档一致，UI 两处按用户要求调整（见 §10.1）
> 依据版本：DSH Desktop `0.2.2-rc.5`（`@deepseek-ai/dsh`）、`@deepseek-ai/dsh-token-meter@0.2.2-rc.5`
> 修订：2026-11-20 评审结论——**本地持久化 + 以插件安装为起点 + 子代理全算 + 不补读冷会话 + 轮询 1 分钟 + 增加「重置统计」按钮**

> ⚠️ **P5 变更（2026-11-20 晚）：投放语义已改为「库存制」，本文档 §5 的「自动投放」不再成立。**
> 现在兑换只入队，**开缸不会自动把库存倒进缸里**；库存按「勺」计，用户每点一次缸口舀走一勺（落 4 粒），
> 库存为 0 时提示「鱼食已喂完」。下文出现的「粒」若指库存，一律按「勺」理解；
> 常量 `PELLETS_PER_UNIT` / `WELCOME_PELLETS` 已改名为 `SCOOPS_PER_UNIT` / `WELCOME_SCOOPS`。
> 原因：手动投喂绕过账本（`sim.feed` 免费加食物）+ 开缸自动清空队列，导致「投喂后鱼食数不减、
> 徽章永远为空、待投喂恒为 0」。逐条证据与改动见 [P5 文档 §11](P5-AI定制工厂.md)。

## 0. 结论与已定决策

**可以实现，不需要 DSH 提供新接口。** 本版方案按以下决策定稿：

| # | 决策 | 落地方式 |
|---|---|---|
| 1 | 统计要**本地持久化**，但起点是**插件安装那一刻**，安装前已消耗的不计 | 首次运行写入 `epochAt` 并给当时所有可见会话建基线；此后跨重启沿用持久化的基线与余额 |
| 2 | 子代理会话也计入，不区分 | 汇总时遍历 `ctx.sessions.list` 的全部 `ids`（列表按 lineage 展平，子代理行在内），不做过滤 |
| 3 | **不补读**没打开过的会话 | 不用 `refreshProjections`；只累加已有投影值的会话，成本恒定，1 分钟一次也不会卡 |
| 4 | 轮询间隔 **1 分钟** | `setInterval(60_000)`；隐藏页被节流时，回到前台立即补一次 |
| 5 | 持久化**不能放 localStorage** | 桌面版 GUI 端口是运行时分配的（本机实测 `127.0.0.1:64970`，web 层默认端口却是 3080），origin 会变；改走插件配置（宿主侧、与端口无关） |
| 6 | 增加**「重置统计」按钮**，行为要明晰 | 设置页新增只读统计块 + 危险操作按钮；二次确认；重置 = 以当前用量重建基线、余额归零、立即落盘 |

预估工作量：**纯逻辑 ~170 行 + 客户端接线 ~135 行 + 配置字段 + 场景 3 处小改 + 单测**，1.5 个工作日。

---

## 1. 需求与实现语义

| # | 需求 | 实现语义 |
|---|---|---|
| 1 | 每 1 分钟拉取并统计全局 token，粗到 M | 客户端 `apply` 起 1 分钟轮询；启动时先做一次**只建基线、不自增**的采样；展示用 M（1 位小数），内部整数 token |
| 2 | 安装后才从 0 累积，安装前不计 | 首次运行记录 `epochAt`；某会话首次被看到时把当前累计值记为基线、贡献 0；此后只加正增量 |
| 3 | 累积满 5M 自动兑换 5 粒鱼食 | `pending >= 5_000_000` → 扣 5M、`foodQueue += 5` |
| 4 | 只能整块兑换，不能拆分 | 只在整块时触发；余量 `pending % 5M` 保留；鱼缸空位不足 5 个时整批延后，不投放半批 |
| 5 | 可以手动重置统计 | 二次确认后：`epochAt=now`、基线重建为"重置瞬间各会话累计值"、`observed/pending/earned/exchanges` 归零、`foodQueue` 回到赠送的 5 粒、立即落盘；已投进水里的鱼食不受影响 |
| 6 | 初次安装默认就有 5 粒鱼食 | 新账本 `foodQueue = WELCOME_PELLETS(5)`；徽章与设置页立刻显示 5，用完之后才靠兑换补；`gifted` 标记持久化，重启不重发 |

**三个关键设计点**

- **兑换（credit）与投放（delivery）分离**：token 是钱，鱼食是现货，`foodQueue` 是"已付款待发货"。鱼食有 25 秒寿命、上限 100 粒，鱼缸关着时投放等于浪费，所以只在鱼缸打开时整批发货。
- **持久化必须原子**：基线（baseline）与余额（observed/pending/foodQueue）必须在**同一次写入**里落盘，否则重启后会出现"余量已加、基线还是旧的"→ 重复计账。
- **重置 = 重新安装**：重置不是"把数字改 0"而是重放首次安装的全部动作（清账 → 重新发放 5 粒赠送 → 以当前用量建基线 → 立刻落盘 → 立刻轮询一次），这样"重置后"和"安装后"走的是同一段代码，语义不会分叉。

---

## 2. 官方能力核对（实测）

| 能力 | 结论 | 证据 |
|---|---|---|
| 每会话累计 token | 有，`tokenUsage` 投影，四桶互不重叠 | `dsh-token-meter/src/projection.ts:15-20`、`usage-projection.ts:111-144` |
| 全局累计 | **没有**，必须插件自己聚合 | token-meter 只注册 per-session 单元 |
| 客户端读值 | `ctx.sessions.list` 快照的 `projectionsBySession[id].values.tokenUsage` | `dsh-api-session-controller/src/client/sessions/service.ts:61-70` |
| 列表行自带投影值 | 是（`projectionValues` 来自该会话的投影存储） | `manager.ts:753-768` |
| `tokenUsage` 是 summary key | 是；`contextPressure`/`contextBreakdown` 才是 `summary:false` | `token-meter/src/projection.ts:70-78`、`usage-projection.ts:202-212` |
| 冷会话读取 | 需 `refreshProjections(id)`（本版**不用**） | `contract/sessions.ts:101-106` |
| fork 带继承前缀 | 是，`inheritedEventCount`；`tokenUsage.init()` 忽略它 | `dsh-session/src/index.ts:590-595`、`usage-projection.ts:115` |
| 是否有计价/费用接口 | 没有 | 账户只有余额（`dsh-deepseek-account/src/index.ts:216`） |
| 配置持久化 | 插件配置走宿主 profile，客户端用 `configForms` 读、`mutate` 写；`.volatile()` 字段原地更新、不重启插件 | dsh-doc `references/configuration.md:12`；本插件 profile 里 `scapePresetId` 就是这么存下来的 |

**为什么不用 localStorage**：桌面窗口加载的是 Host 报给 Electron 的 URL（`dsh-desktop-host/lib/index.js:515-518` → `http://127.0.0.1:<实际端口>`），而端口来自 `webServer.port`，`dsh-web-app` 的默认是 3080、桌面启动参数里没有 `--port`，实际却绑在 64970 —— 说明端口是运行时分配的。**端口一变 origin 就变，localStorage 直接换一份**，进度会莫名清零。所以持久化放宿主侧配置。

---

## 3. 数据流

```text
每 60s
  ctx.sessions.list.getSnapshot()
    └─ 遍历 ids：projectionsBySession[id].values.tokenUsage（四桶求和）
                    │
                    ▼
     TokenLedger.observe(entries)          （纯函数，可单测）
       · 首见 → 记基线，贡献 0
       · 再见 → delta = now − base，只取正增量
       · observed += delta；pending += delta
       · pending ≥ 5M 且队列有空位 → 整块兑换 → foodQueue += 5×blocks
                    │
                    ├─ 有变化 →（节流）写回插件配置：baseline + 余额，一次原子写
                    ▼
     鱼缸打开且空位 ≥ 5 → scene.feedAuto(5) → Simulation.dropFood → 鱼群抢食

用户点「重置统计」（设置页）
     → ledger.reset() → 立刻 poll() 重建基线 → 立刻落盘 → UI 显示"自 <重置时间> 起"
```

---

## 4. TokenLedger（`src/token-ledger.js`，纯逻辑）

```js
export const TOKEN_UNIT = 5_000_000;   // 每块 5M
export const PELLETS_PER_UNIT = 5;     // 每块 5 粒
export const QUEUE_CAP = 100;          // 待投放上限（= 鱼缸食物上限）
export const LEDGER_VERSION = 1;

export function createTokenLedger(state = null, options = {}) {
  const { unit = TOKEN_UNIT, pellets = PELLETS_PER_UNIT, cap = QUEUE_CAP } = options;
  const baseline = new Map(state?.baseline ?? []);   // sessionId -> 上次看到的累计 token
  let epochAt = state?.epochAt ?? Date.now();        // 统计起点：安装或最近一次重置
  let observed = state?.observed ?? 0;               // 自起点累计 token
  let pending  = state?.pending  ?? 0;               // 未兑换余量，0 ≤ pending < unit
  let foodQueue = state?.foodQueue ?? 0;             // 已兑换待投放（粒）
  let earned = state?.earned ?? 0;                   // 累计兑换粒数
  let exchanges = state?.exchanges ?? 0;

  function observe(entries) {
    let gained = 0;
    for (const { id, tokens } of entries) {
      if (!Number.isFinite(tokens) || tokens < 0) continue;
      const previous = baseline.get(id);
      baseline.set(id, tokens);                       // 总是前移基线
      if (previous === undefined) continue;           // 首见即基线：起点之前/首次见到的量不计
      const delta = tokens - previous;
      if (delta <= 0) continue;                       // 会话重建、日志回退：不产生负增量
      observed += delta;
      pending += delta;
    }
    while (pending >= unit && foodQueue + pellets <= cap) {
      pending -= unit; foodQueue += pellets; earned += pellets; exchanges += 1; gained += pellets;
    }
    return { gained, snapshot: snapshot() };
  }

  /** 只保留当前列表里仍存在的会话，防止配置无限膨胀。 */
  function prune(ids) {
    const keep = new Set(ids);
    for (const id of baseline.keys()) if (!keep.has(id)) baseline.delete(id);
  }

  function takePellets(space) {                       // space = 鱼缸剩余空位
    const count = Math.floor(Math.min(foodQueue, space) / pellets) * pellets;  // 只整批发货
    foodQueue -= count;
    return count;
  }

  /** 投放失败退票，只在"统计滞后导致误判空位"的竞态下用到。 */
  function refund(count) { foodQueue += count; }

  /**
   * 重置：等价于"重新安装一次插件"。
   * 不在这里塞当前用量 —— 调用方随后立刻 poll() 一次，
   * 让"首见即基线"这条既有规则自然完成基线重建，避免两条路径语义分叉。
   */
  function reset() {
    baseline.clear();
    epochAt = Date.now();
    observed = 0; pending = 0; foodQueue = 0; earned = 0; exchanges = 0;
    return snapshot();
  }

  const snapshot = () => ({
    epochAt, observed, pending, foodQueue, earned, exchanges,
    toNextUnit: Math.max(0, unit - pending), unit, pellets,
  });

  /** 落盘载荷：基线与余额必须一起写。 */
  const serialize = () => ({
    v: LEDGER_VERSION, epochAt, observed, pending, foodQueue, earned, exchanges,
    baseline: [...baseline].slice(-200),              // 上限 200 条会话
  });

  return { observe, takePellets, refund, prune, reset, snapshot, serialize };
}
```

要点：

- `baseline` 遇到回退只前移、不产生负增量 → 任何"总量下降"都不会算成负数。
- `pending` 与 `foodQueue` 分离：队列满不影响继续累计，攒够了待投放后再一次补兑。
- 无时钟、无随机、无 DOM（`epochAt` 用调用方注入的 `Date.now()` 由测试替换）→ `node --test` 直接表驱动断言。

---

## 5. 兑换、投放与重置规则

| 规则 | 行为 |
|---|---|
| **初次安装赠送** | 每个新账本带 `WELCOME_PELLETS = 5` 粒初始库存，装好即可投喂，不需要先攒 5M。它是**库存不是收入**：`earned`/`exchanges` 仍只统计兑换；`gifted` 标记随账本持久化，重启只读取不重发；旧版没有该字段的载荷在升级时补发一次 |
| 兑换粒度 | 只有 `pending ≥ 5M` 才触发；一次可补多块（关窗很久后一次到账 15 粒） |
| 不可拆分 | `pending = 4_999_999` → 0 兑换；永不出 4 粒或 2.5 粒 |
| 余量 | 兑换后保留 `pending % 5M` |
| 队列上限 | `foodQueue + 5 > 100` → 不兑换，`pending` 继续攒（不是丢弃）；赠送入库同样不超过 100 |
| 投放粒度 | **P5 起**：点一次缸口舀一勺（库存 −1，落 `LIMITS.batch` = 4 粒），不再一次倒 4 粒库存；库存为 0 时提示「鱼食已喂完」。~~原本一次 5 粒、不足就等下一轮~~ |
| 投放时机 | **P5 起**：只在用户点缸口时投放（`scene.takeFood()` → `sim.feed(point, now, count)`），开缸与轮询都不再自动倒库存。~~原本 `onStats` + 打开鱼缸 + 轮询三处触发 `pump()`~~ |
| 提示 | 兑换时状态行「+5 粒鱼食」，与现有 `announce()` 同机制；赠送入库不弹提示 |
| **重置** | 二次确认后清空账本、重新发放 5 粒赠送；基线取"重置瞬间各会话的累计值"，所以重置前的用量一律不再计入；**已投进水里的鱼食留在缸里**（只是粒子，几秒后被吃或过期，不动它更自然） |

---

## 6. 轮询（1 分钟）

```js
// src/client.jsx apply() 内
ctx.effect(() => {
  let disposed = false;
  let timer = null;

  function poll() {
    if (disposed) return;
    const state = ctx.sessions.list.getSnapshot();
    if (!state.ids.length) return;
    const entries = state.ids.map(id => ({
      id, tokens: totalOf(state.projectionsBySession[id]?.values?.tokenUsage),
    })).filter(e => e.tokens !== undefined);
    const { gained } = ledger.observe(entries);
    ledger.prune(state.ids);
    if (gained > 0) announceLater(gained);
    persistThrottled();          // 见第 7 节：≥5 分钟一次，或余额变化时立即写
    publish();                   // 通知 UI
  }

  const resetTimer = () => { clearInterval(timer); timer = setInterval(poll, 60_000); };
  const onVisible = () => { if (document.visibilityState === 'visible') { resetTimer(); poll(); } };

  poll();                        // 启动即建基线（不自增）
  resetTimer();
  document.addEventListener('visibilitychange', onVisible);
  resetApi.current = () => {     // 供设置页按钮调用
    ledger.reset();
    publish();
    poll();                      // 立刻用当前用量重建基线
    flushPersist();              // 不节流：重置结果必须马上落盘
  };
  return () => {
    disposed = true; clearInterval(timer);
    document.removeEventListener('visibilitychange', onVisible);
    flushPersist();
  };
});
```

- **启动必须先采样一次**：否则启动后到第一次轮询这 1 分钟的用量会被当成"起点之前"永久丢掉。
- **1 分钟成本可忽略**：不补读冷会话，每次只是读内存快照 + 求和，微秒级；生产 I/O 另有节流。
- **隐藏页节流**：`setInterval` 在后台会被拉长，`visibilitychange` 回前台立即补一次并重置节奏。
- **重置后立刻 poll**：不清就投喂的前提下，必须马上把当前用量记成基线，否则下一轮会把整个历史当成新增。

---

## 7. 持久化（宿主侧配置）

### 7.1 存在哪

写进本插件自己的配置项 `ledger`（宿主 profile 的 `cordis.patch.yml` 里的一行 YAML），客户端通过 `configForms` 读写。和现有 `scapePresetId` 完全同一条通道，与端口、origin、浏览器存储都无关。

```yaml
- id: eco-aquarium
  name: dsh-eco-aquarium
  config:
    scapePresetId: scape.driftwood
    qualityMode: auto
    ledger:                      # 新增（volatile，原地更新不重启插件）
      v: 1
      epochAt: 1763600000000
      observed: 12400000
      pending: 3900000
      foodQueue: 10
      earned: 10
      exchanges: 2
      baseline:
        - [sess_ab12, 8300000]
        - [sess_cd34, 4100000]
```

### 7.2 写入策略

| 时机 | 是否写 |
|---|---|
| 兑换发生（`foodQueue` 变化） | 立即写 |
| 每次轮询 | **节流**：距上次写 ≥ 5 分钟才写 |
| 页面隐藏 / 插件卸载 | 立即写（`flushPersist()`） |
| **用户点击重置** | **立即写**（重置必须能被崩溃安全地保住） |
| 值没变化 | 不写 |

最坏情况 ~12 次/小时；`mutate` 失败（revision 冲突）重试一次，再失败就放弃——内存账本仍然正确，下次写会自愈。

### 7.3 语义边界

| 场景 | 行为 |
|---|---|
| 首次安装 | 读不到 `ledger` → 建 `epochAt=now`、所有当前可见会话为基线、余额全 0；显示"自 2026-11-20 09:58 起" |
| 正常重启 | 恢复 baseline + 余额；宿主若在关窗期间继续跑过任务，这部分增长会在下次启动被正确计入（这正是持久化基线的意义） |
| 崩溃（丢 ≤5 分钟） | 基线也停在上次写入点，重启后从旧基线算增量 → **补回来，不会重复计** |
| 某会话被删除 | `prune()` 移除其基线；不影响已累计值 |
| 会话累计值回退 | 只前移基线，不产生负增量 |
| **用户重置** | `epochAt=now`、基线重建、余额归零、立即落盘；设置页"统计起点"跟着变 |
| 用户清空配置 / 重装插件 | `ledger` 缺失 → 回到"首次安装"语义（以当时用量为新基线，进度归零） |

> 注意：写入 `ledger` 的字段必须声明为 `.volatile()`，否则每次写都可能重启插件、把鱼缸关掉。新增可选字段不需要 bump `schemaVersion`；但 `ledger.v` 要预留，将来改结构时用它做迁移或丢弃。

---

## 8. 文件级改动清单

| 文件 | 改动 | 规模 |
|---|---|---|
| `src/token-ledger.js` | **新增**：纯逻辑 ledger（`observe/prune/takePellets/refund/reset/serialize`）+ `totalOf()` | ~170 行 |
| `tests/token-ledger.test.mjs` | **新增**：node --test 表驱动用例（含重置与往返） | ~180 行 |
| `src/host.js` | Config 增加 `ledger`（volatile，可空对象） | ~15 行 |
| `src/core.js` | `Simulation.dropFood(point, count)`（空位不足整批拒绝）；`feed()` 改为复用它；`LIMITS.autoFeedBatch = 5` | ~25 行 |
| `src/scene.js` | API 增加 `feedAuto(count)`：随机水面点 → `dropFood` → 涟漪 | ~20 行 |
| `src/client.jsx` | `inject` 加 `'sessions'`；模块级 token store；轮询 + 恢复/节流落盘；`PlayView` 展示与 `pump()`；**设置页新增「Token 统计」块与重置按钮（含二次确认）** | ~135 行 |
| `src/locales.js` | `tokenUsage` `tokenNext` `tokenFood` `tokenQueue` `tokenSince` `tokenReset` `tokenResetConfirm` `tokenResetDone` `tokenResetCancel` 等 zh/en 文案 | ~18 行 |
| `src/aquarium.css` | badge 两行/两个 pill 样式 + 设置页统计块 + 危险按钮样式 | ~35 行 |
| `package.json` | 无新增依赖 | 0 |

**实现落点（2026-11-20 核对）**：

| 文件 | 实际改动 |
|---|---|
| `src/token-ledger.js` | 新增纯逻辑账本；另导出 `totalOf()`、`isLedgerState()`、`emptyLedgerSnapshot()`；`WELCOME_PELLETS = 5` 为初装赠送，`gifted` 标记一次性发放 |
| `tests/token-ledger.test.mjs` | 23 个用例覆盖 A1–A13、裁剪、退票、版本不符、常量，以及赠送的发放/不重发/旧载荷补发/重置回补/上限 |
| `src/host.js` | Config 新增 `ledger`（`z.object(...).default(零值).volatile()`）；子字段全部非 volatile，否则 schemastery 直接拒绝嵌套 volatile；`gifted` 为布尔默认 `false` |
| `src/core.js` | 新增 `Simulation.dropFood(point, count)`（整批或拒绝），`feed()` 复用它；`LIMITS.autoFeedBatch = 5` |
| `src/scene.js` | API 新增 `feedAuto(count)`：随机水面点 → `dropFood` → 涟漪 |
| `src/client.jsx` | `inject` 加 `'sessions'`；账本 store + 1 分钟轮询 + 节流落盘；入口整按钮水位 + 徽章、`useArmedAction`（5 秒二次确认）、操作栏 Token 块、设置页首屏概览与「Token 统计」块 |
| `src/aquarium.css` | 入口整按钮水位 / 浪头动画 / 徽章弹跳 / 操作栏 Token 块 / 危险按钮；设置页自己承担滚动（宿主 `.mainPanel` 是定高 flex 列且 `.centerCol` 裁剪溢出，页面不滚就看不到下半截） |
| `src/locales.js` | 上述 UI 的中英文案 |
| `scripts/autofeed-probe.mjs` | 新增 `npm run probe:autofeed`：真实浏览器验证兑换后自动投 5 粒、关窗只入队，并验证初装 5 粒首次开缸自动落下 |
| `scripts/preview-panel.mjs` | `?ledger=returning` 复用「已有账本」状态跑既有截图；`?mode=closed` 拍初装徽章 `5`，并断言 `earned === 0` |
| `scripts/preview-panel.mjs` | 设置页滚动断言：`.dsh-aq-page` 必须 `overflow-y:auto` 且能滚到底，否则 `npm run preview` 直接失败 |

> 与文档的差异：轮询读取的字段是 `sessions.list` 快照的 `ids` + `byId[id].projectionValues.tokenUsage`（回退到 `projectionsBySession[id].values.tokenUsage`），不是 `state.ids` 直接取投影；`byId` 由 `projectList()` 从展平后的 lineage 条目构建，子代理行在内。

---

## 9. 场景接线（伪代码）

```js
// core.js
dropFood(point, count) {
  if (LIMITS.food - this.food.length < count) return 'full';   // 整批拒绝，绝不投一半
  if (point.x < SPACE.minX || point.x > SPACE.maxX || point.z < SPACE.minZ || point.z > SPACE.maxZ) return 'outside';
  for (let i = 0; i < count; i++) this.food.push({ id: this.nextId++, state: 'active', age: 0, alpha: 1, /* …同 feed */ });
  this.waveVelocity = clamp(this.waveVelocity + 0.005, -0.075, 0.075);
  return 'added';
}

// scene.js api
feedAuto(count) {
  const x = SPACE.minX + Math.random() * (SPACE.maxX - SPACE.minX);
  const z = SPACE.minZ + Math.random() * (SPACE.maxZ - SPACE.minZ);
  const result = sim.dropFood({ x, z }, count);
  if (result === 'added') { lastFeedPoint = new THREE.Vector3(x, SPACE.waterY, z); feedRippleAt = sim.time; }
  return result;
}

// client.jsx —— 投放泵
function pump() {
  const scene = sceneRef.current;
  if (!scene) return;
  const space = LIMITS.food - (statsRef.current.food ?? 0);
  if (space < 5) return;                 // 空位不足整批，等下一轮
  const count = ledger.takePellets(space);
  if (count <= 0) return;
  if (scene.feedAuto(count) !== 'added') ledger.refund(count);   // 极端并发下的退票
  persistThrottled(true);
}
```

---

## 10. UI 与文案

### 10.1 浮层 badge（看鱼时）

**已实现版本（2026-11-20 用户二次改版）**：右下角悬浮入口是**圆形按钮**，只保留**原有的鱼缸线稿 logo**（缸体、水面波纹、右侧挂式过滤管、底部颗粒，与导航栏 `AquariumGlyph` 同一份矢量）；**水填满的是整个按钮**，不是图标内部——`pending / 5M` 决定水位，水从按钮底部升起、液面横贯整个按钮宽度，满格时水抵到按钮顶缘。满格即触发兑换，兑换后水位回到余量重新上涨。右上角计数徽章显示**待投喂**的鱼食数（`foodQueue`），配色取鱼食罐的琥珀棕（`--aq-jar: #b77a45`，与罐盖同色）而不是红，兑换瞬间有一次性弹跳，投放后随队列减少。`title` 里仍保留完整数值（`Token 用量 / 待投喂 / 距兑换`），鼠标悬停即可读到精确量。

**初次安装的状态**：还没花任何 token 时，徽章就已经是 **5**（`WELCOME_PELLETS`），水位为 0——这是送给新装的库存，不计入「已兑换」。第一次打开鱼缸时这 5 粒会自动落下，徽章随之清空；之后再想喂鱼就得靠 5M 兑换了。

> 水面必须**一条填充路径**：水体与浪头同属一个 `<path>`，水色由这条路径自带渐变。**不要**再用「矩形水块 + 一条压在上面的半透明波峰」的写法——两层 30% 左右的 alpha 在交界处会叠成约 50%，压出一条比水面更深、偏蓝的硬边（浅色底上尤其刺眼）。水位只靠 `translateY` 位移，浪头形状写死在 `d` 里。

全屏视图的左侧操作栏里，原来的「渲染质量」下拉已移除（该配置只保留在设置页），原位置改为 **Token 统计块**：累计用量、距兑换还差多少、横向进度条、重置统计按钮（同样二次确认，5 秒超时自动撤销）。这条与下方 10.2 的"浮层不放重置入口"结论相反，是用户明确要求，用二次确认而不是隐藏来防误触。

原方案的浮层两行文字（保留作参考）：

```text
Token 12.4M（自 11-20 09:58 起） · 待投放 10 粒 · 距 +5 粒还差 3.6M
兑换时状态行：+5 粒鱼食已投下         （3.2s 后消失）
```

数值一律 `(n / 1e6).toFixed(1) + 'M'`。**浮层不放重置按钮**：破坏沉浸感，而且这是不可逆操作，误触代价高。

### 10.2 设置页「Token 统计」块（放"显示与光照"之后）

```text
┌ Token 统计 ─────────────────────────────┐
│ 统计起点      2026-11-20 09:58（安装）   │
│ 累计用量      12.4M                      │
│ 距下次兑换    还差 3.6M                   │
│ 待投放        10 粒（2 次兑换，未投喂）    │
│ 已兑换        10 粒                      │
│                                          │
│                    [ 重置统计 ]           │
└──────────────────────────────────────────┘
```

**二次确认交互**（不用 `window.confirm`：阻塞、主题不一致、无法走本地化文案）：

1. 点「重置统计」→ 按钮就地变成危险色的「确认重置（5 秒后自动取消）」，其余控件不变；
2. 5 秒内再点 → 执行；5 秒超时、按 Esc、点到别处 → 撤销并恢复原文案；
3. 执行后状态行显示「统计已重置，从现在起重新累计」，按钮恢复原文案；
4. `configForms` 不可写（`writable === false`）时按钮禁用，`title` 说明原因。

**重置后可观察的结果**：统计起点变成当前时间、累计用量与待投放清零；鱼缸里已经在沉的鱼食不受影响；下一次兑换仍要重新攒满 5M。

---

## 11. 验收标准

| # | 断言 | 验证 |
|---|---|---|
| A1 | 启动首轮不产生增量（只建基线） | 单测：`observe([{id:'a',tokens:1e9}])` → `observed=0` |
| A2 | 同会话 1e9 → 1e9+5.1e6：兑换 1 块、`pending=0.1e6`、`foodQueue=5` | 单测 |
| A3 | `pending=4.99e6` → 0 兑换 | 单测 |
| A4 | 总量下降 1e7 → 无负增量 | 单测 |
| A5 | 新会话首见即 6e6（fork 继承）→ 0 兑换 | 单测 |
| A6 | `foodQueue=98` 时再兑一块 → 不兑换、`pending` 保留 | 单测 |
| A7 | `takePellets(3)` → 0、票不减；`takePellets(10)` → 10 | 单测 |
| A8 | `serialize()` → `createTokenLedger(payload)` 往返等价（含 baseline） | 单测 |
| A9 | 重启后进度保留：写入 → 重新构造 → `observed/pending/foodQueue` 一致 | 单测 |
| A10 | 崩溃场景（基线停在旧值）→ 重启后补回增长且不重复 | 单测（模拟两段 payload） |
| A11 | **重置后** `observed/pending/foodQueue/earned/exchanges` 全 0，`epochAt` 为当前时间 | 单测 |
| A12 | **重置瞬间的用量成为新基线**：重置时 A=100M，之后 A 涨到 105M → 只兑换 1 块（不是 21 块） | 单测 |
| A13 | 重置立即落盘：重置后序列化再构造，仍是全 0 + 新 epoch | 单测 |
| A14 | 二次确认：第一次点击不执行；5 秒后自动撤销；连点两次只执行一次 | 手工 / smoke |
| A15 | 鱼缸关闭时轮询照常累加，打开后自动整批补投 | 手工 + smoke |
| A16 | 页面隐藏 10 分钟回前台 → 立即补一次轮询，账不丢 | 手工 |
| A17 | 配置里出现 `ledger` 后插件不重启、鱼缸不被打断 | 手工（改一次造景后再观察） |

---

## 12. 测试计划

1. **纯逻辑单测**（现有 `npm test` → `node --test tests/*.test.mjs`）：A1–A13，外加非法 tokens、重复 id、`unit/cap` 改写、`baseline` 上限裁剪、`refund` 退票。
2. **fake ctx 集成测**：伪造 `{ sessions: { list: { getSnapshot } } }` 与假 `configForms`，验证：一轮轮询后的账本、落盘节流（1 分钟内多次 poll 只写一次）、**重置路径写一次且不被节流吞掉**。
3. **客户端 smoke**（可选，参考 `scripts/smoke-client.mjs`）：把 `unit` 临时改成 1e3，30 秒内看到一次兑换与投放，再点一次重置确认 UI 与账本都归零；跑完恢复生产常量（不要在代码里留魔法开关）。
4. **手工验收**：开着鱼缸跑长任务 → 重置 → 确认 badge/设置页归零且鱼缸继续正常；关窗 10 分钟再开；改一次造景确认插件没重启；最后看一眼 `cordis.patch.yml` 的 `ledger` 块。

---

## 13. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| 端口/origin 变化导致 localStorage 丢账 | 进度清零 | 已改用宿主配置持久化（本轮核心修正） |
| 配置写入过于频繁 | profile 文件 churn、revision 冲突 | 节流 5 分钟 + 仅变化时写 + 失败重试一次 |
| `ledger` 字段写成非 volatile | 每次落盘都重启插件、鱼缸被关 | host.js 里显式 `.volatile()`；验收项 A17 专门看这个 |
| 基线持久化与余额不同步 | 重复计账 | 用同一个 `mutate` 原子写 `serialize()` 全量 |
| 重置被误触 | 进度清零 | 只在设置页、二次确认、5 秒自动撤销；浮层不放 |
| 重置后忘记重建基线 | 下一轮把全部历史当新增，瞬间"暴富" | 重置实现固定为"清账 → 立刻 poll"，并在单测 A12 锁死 |
| 未打开过的会话不计（本版取舍） | 纯后台跑完的子代理可能漏算 | 已确认接受；将来要精确可切"方案 B"（见附录） |
| provider 用量在消息结束才回报 | 兑换最多延迟 1 个 turn + 1 分钟 | 可接受，累计快照不会漏计 |
| 后台标签页定时器被节流 | 轮询延后 | `visibilitychange` 回前台立即补 |
| 鱼食 25 秒寿命 + 上限 100 | 攒多了浪费 | 队列上限 100、整批投放、只在鱼缸打开时投 |
| HMR/重复注册导致多个定时器 | 重复记账 | 全部包在 `ctx.effect` 里，清理时 `disposed=true` 并 `flushPersist()` |

---

## 14. 可后置的收尾项

1. **兑换动画**：目前是状态行文字 + 涟漪；想更有"游戏感"可加一次金色水波（复用 `feedRing`）。
2. **统计排空**：重置前若有 `foodQueue`，可选择"先把券投完再清"（默认直接清，更符合"重置"预期）。
3. **方案 B（未来升级）**：宿主端 `ctx.on('session/event', …)` 直接按 `assistant/message` 的 `usage` 精确累加（与 token-meter 同款替换语义），完全不轮询、天然不受"没打开就不报"影响；代价是要处理 attempt 替换与 host→client 的写通道。当前方案 A 已够用，先不做。

---

## 15. 明确不做（范围外）

- 不做计费/费用换算（无计价接口，价格会变）。
- 不做跨设备、跨 profile 的统计（只统计当前 profile 的会话列表）。
- 不做按模型/项目的用量拆分。
- 不做"手动投喂消耗 token"或反向兑换。
- 不为 P4 增加用户可调参数（5M / 5 粒 / 1 分钟 / 队列上限都是常量）。
- 不在浮层里做重置入口。

---

## 附录：为什么不能用"总和相减"

```text
启动时：A=100M，B=50M            → 总和 150M（基线）
1 分钟后：A=103M，B 被删除        → 总和 103M
相减法：103 − 150 = −47M          ✗
本方案：A 的增量 +3M，B 消失不产生增量 → 正确累计 3M  ✓
```

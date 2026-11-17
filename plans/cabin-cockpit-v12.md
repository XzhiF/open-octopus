# 全域座舱（cockpit-v12）落地实现计划

> 目标：把 `docs/cabin-design/cockpit-v12.html` 以**高保真、真数据、完整可用**的方式落进
> `packages/web-app`。
>
> 操作逻辑（用户口径，2026-11-14 修正）：**classic 与全域是两套互不干扰的界面**。
> classic 舱面右上角「⛶ 全域」按钮进入全域；全域里「← 返回作战舱」回到 classic。
> classic 的编队行**仍然是原来的作业详情窗**，不因全域改道。
> 所有关闭按钮统一放**左侧**，沿用 classic 窗口灯组的习惯。
>
> 原型是视觉真源，但有四处**高于原型 / 与原型不同**：
> 1. 关闭按钮在左（原型 v12 在右）；
> 2. 所有数字、列表、时间线、diff、验收、聊天都是真实接口，**不保留任何 mock / 演示数据**；
> 3. 不实现原型里「一句话切场景 / 换色 / 跃迁」的自然语言 `interpret()` —— 真实输入框就是聊天输入框，
>    说了话就是发消息。场景切换只走按钮与快捷键；
> 4. 简报窗**没有任何按钮**，10 秒自动收（用户明确要求：不用赶时间去点）。
>
> 本计划可拆给子代理并行执行。每个 Step 只读自己的 Context Brief 即可开工。
>
> **本稿已过一轮对抗式评审（29 条），critical/major 全部并入。** 评审结论与处置见 §8。

---

## 0. 现状（所有 Step 的公共背景）

### 0.1 线上现有作战舱

- 路由：`/cabin/:cabinId`。**两种入口**：
  - 桌面内：`CabinModeProvider.activeCabinId` → `ConversationHome` → `CabinDesktopHost`，
    **不改路由**（URL 仍是 `/`），桌面与窗口都还挂着；
  - 深链 / 新标签：`AppShell.ShellBody` 见 `route.kind === 'cabin'` → 整屏换掉桌面，渲染 `CabinShellRoute`。
- 壳：`DesktopHeader` + `CabinChatHost`（生产 `ChatSidebar` + `ChatPane` + `CabinFleet` + `CabinCrew` + `CabinModulesLayer`）。
- 编队：`components/cabin/CabinFleet.tsx`。**真实尺寸 148px，`max-width:1320px` 起隐藏**
  （`app/cabin-cockpit.css:372-377,413-415`）。数据 `listCabinJobs(cabinId)`，10s 轮询。
  两种行：`cabin_jobs` 账本行（点击 `openJobDetail`）与**历史舱无 job 时**由活态任务合成的
  `task:<id>` 行（点击 `openTaskInChat`）。非 task 行的进度条是**假值 45%**（`CabinFleet.tsx:85`），本计划要删掉这个假值。
- 作业详情：`components/cabin/modules/CabinJobDetail.tsx`（469 行，五页签已实现真数据）：
  概览（events 时间线）· 对接（三方同屏）· 运行（`CabinRunSummary`）· 变更（`ChangesWindow`）· 验收（`AcceptanceWindow`）。
  **但它从 `useCabinContext()` 取 `cabinId / cabin / selectedJobId / refresh`**（`:58,69-81,132,141,154,169,184`），
  所以抽出来必须改成 props。
- 聊天：`ChatPane.tsx`（1752 行）+ `ChatArea.tsx`（1323 行）。模型 / effort / 上下文窗口在
  `useComposerSettings`（**进程级** localStorage `octopus.composer.settings.v2`），
  队列 / steer / 停止 / Esc 停止 / 附件 / `@分身` / `/斜杠` **全在 composer 内部**
  （`ChatArea.tsx:322-435,797-1045,909,1192`）。这是本计划最关键的一条约束，见 §2.4。
- 汐音：`CockpitProvider` + `useXiyinState`。`useCockpit()` 已暴露
  `prefs / setPref / mood / setMoodOverride / presenceLine / presenceDueAt / snoozePresence /
  testPresence / setCrewBusy`；`THEMES` 6 套（terminal/hyperion/luna/amber/acid/crimson），
  `--ck-a/--ck-b/--ck-c` 写 root；`PRESENCE_RATES` 是**真实分钟**（quiet 12–24 / std 6–16 / active 3–8）。
- 数据：`lib/cabin-api.ts` 已有
  `listCabins / createCabin / getCabin / listCabinJobs / getCabinJob / getCabinJobTrace / getCabinTrace /
  noteCabinJob / resumeCabinJob / setCabinJobPriority / setCabinFocus / getCabinUsage / dispatchCabinJob /
  listCabinWorktrees / cabinEventsUrl(SSE: cabin_status · cabin_init_progress · heartbeat)`。
- 真实字段：`CabinJob` 只有 `id/kind/ref_id/session_id/iteration_id/title/mandate/prompt/priority/
  created_at/ended_at/status?`。**没有 branch / agent / doing / cost**。
  `CabinAttentionItem` 有 `title/question/detail/task_id/repo/wt/deep_link/priority`，**`job_id` 可空**
  （服务端 `derive-cabin-view.ts` 的 `finding-*` 就是 `job_id: null`）。
- 路由类型：`CabinRoute` 是**全字面量**接口（`id:'cabin'`、`path:'/cabin/:cabinId'`、
  `componentKey:'cabin-shell'`），直接加一条 `path` 不同的对象**过不了类型检查**。
  `CABIN_COMPONENTS` 与 `ShellBody` 都只认这一个壳。

### 0.2 视觉真源

- `docs/cabin-design/cockpit-v12.html`（自包含，浏览器直接打开）
- `docs/cabin-design/design/11-global-mode.md`
- 设计稿与原型冲突时：**尺寸取原型**，交互取设计稿，真实数据取本计划 §1.5。

### 0.3 关键尺寸（从 v12 源码抄，不得凭感觉）

| 块 | 值 |
|---|---|
| HUD | 高 48；`padding:0 20px`；底边框 1px |
| stage | `padding:12px 20px 0`；左栏 300 + gap 16 |
| 编队行 | 高 ~52；组标题 8.5px / 行名 12px / 副行 9px |
| 立绘 | 344 × `min(60vh,548)`；`left:6 bottom:6`；`z-index:3` |
| 作业面让位 | `padding-left:366px`；≤1360 → 334；≤900 → 300；`padding-bottom:8` |
| 作业头 | 行1 28px（灯组 + 类型 + 标题 + 状态 + 页签）；行2 20px（分支/在做/元信息/动作）；gap 3 |
| 页签 | 24px 高胶囊；选中 `--a` 12% 底 + 1px 内描边 |
| ticker | 30px；rig 24px；输入框 54px；`padding:10px 20px 16px`；gap 8 |
| 聊天浮窗默认 | `x = arena.left + scene.paddingLeft`，`y = arena.top`，`w = arena.width - paddingLeft`，`h = arena.height - 8`；mini 47；夹回 8px |
| 简报 | 340 宽；`right:26 top:66`；10s 自动收；**无按钮** |
| 舱壁流光 | 3px 四边；2.4s；只走边缘 |
| 星野 | **300 星（reduced 130）+ 230 尘埃（reduced 90）**；彗星 7–17s；`prefers-reduced-motion` 近静止 |

---

## 1. 契约（先拍死，所有 Step 依此）

### 1.1 路由与 URL

新增一条兄弟壳路由：

```
/cabin/:cabinId/cockpit?job=<jobId>&tab=<overview|relay|run|changes|accept>
/cabin/:cabinId/cockpit?task=<taskId>
/cabin/:cabinId/cockpit?attn=<attentionId>
（跨舱看别的舱的作业时追加 &cabin=<所属舱>；只在 ref.cabinId ≠ 入口舱时写）
```

- **`cabinId` 永远是「入口舱」**：决定聊天绑哪个主会话、返回按钮回哪里。
  面显示哪条作业由 `?job/?task/?attn` 决定，**可以是别的舱的**（跨舱只读查看），
  此时用 `&cabin=` 记住归属，重载/分享不丢。
- 参数优先级 `job > task > attn`；都缺 → 默认选中（§1.3）。
- 点编队行用 `replace` 同步 URL（不污染浏览器历史）；进入 / 退出用 `push`。
- 深链打开时：若 `?job` 属于另一个舱，仍以路径里的 `cabinId` 为入口舱。

`CabinRoute` 改成**两个字面量形状的联合**（不是把字段放宽成 `string`，那样会丢掉约束）：

```ts
interface CabinShellRouteDecl {
  kind: 'cabin'; id: 'cabin'; path: '/cabin/:cabinId'
  componentKey: 'cabin-shell'; title: (p: RouteParams) => string
}
interface CabinCockpitRouteDecl {
  kind: 'cabin'; id: 'cabin-cockpit'; path: '/cabin/:cabinId/cockpit'
  componentKey: 'cabin-cockpit'; title: (p: RouteParams) => string
}
export type CabinRoute = CabinShellRouteDecl | CabinCockpitRouteDecl
```

`matchAppRoute` 用 `end:true`，两条路径互不吞并；`CABIN_ROUTES` 里 cockpit 放前面只为可读。
`ShellBody` 必须改成**按 `route.componentKey` 分发**（现在按 `kind` 一刀切）。

### 1.2 入口

1. **唯一入口**：classic 舱壳右上角的 `⛶ 全域` 按钮（`CabinChatHost`）→
   `enterCockpit({ cabinId })`，不带 ref，由 §1.3 默认选中落一条真行。
2. **classic 不改道**：`CabinFleet` 行点击保持原行为（job → `openJobDetail` 作业详情窗；
   合成 task 行 → `openTaskInChat` 任务线程）。不删行内数据、不加「详情」小按钮、不做 `⌥G`。
3. **返回**：全域 HUD 左侧「← 返回作战舱」→ `exitCockpit`（有 origin 回 origin，否则 `/cabin/:entryCabinId`）。
4. **跨舱**：全域编队里点别的舱的作业 → 只换面，**不重绑聊天**；聊天的「对接」页签投递只对入口舱开放（§3.4）。

### 1.3 默认选中

无 ref 时：`需要你` 第一条（attention priority 降序）→ `运行中` 第一条 → `排队` 第一条 → 空态。
进入后再无有效 ref（作业结束被移出）→ 自动落到下一条「需要你」，没有就停在与该行相邻的一条。

### 1.4 出口与 Esc

- HUD 左侧 `← 返回作战舱`：
  - 有 origin（从桌面内进来的）→ 回 origin 路径（桌面与窗口原样恢复，`CabinModeProvider` 在 `ShellBody` 之上，状态不丢）；
  - 直接深链进来的 → `/cabin/:entryCabinId`。
  - origin 存在 `sessionStorage['octopus.cockpit.origin']`，进入时写入，返回时消费一次后清除。
- 浏览器后退：回到进入前的位置（`push` 语义保证）。
- **Esc 逐层**（**与 v12 一致**，只由 `CockpitLayerStack` 处理）：
  `popover → 立绘控制条 → 任务模块窗 → 编队抽屉 → 聊天浮窗 → 作业面`。
  最外层（作业面）Esc 只收面，**不退出路由**；退出只走返回按钮 / 浏览器后退。
- Radix 的 `Popover/Dialog` 必须 `onEscapeKeyDown={e => e.preventDefault()}`，把 Esc 让给唯一的
  `CockpitLayerStack`（capture 阶段监听），否则会双触发。

### 1.5 真实数据边界（**不许出现假数字**）

| 原型字段 | 真实来源 | 缺失时 |
|---|---|---|
| 状态 / 进度 | `CabinJobView.status`；进度只对 **有 v4 phaseViews** 的 task 用 `taskPct` | 没有 phaseViews 的 task 也 `null`（`taskPct` 的 50% 回退是猜的，不画条）；workflow/subagent 一律 `null` |
| 分支 | `task_spec.branch` → 否则 task 的工作树分支 | 整段省略，不留空分隔符 |
| 正在做什么 | `getCabinJob().events` 最后一条 `summary` → 否则 `attention.title` | 都没有就省略（不回退成状态文案，行1 已有状态） |
| 执行者 | `job.session_id` / `job.ref_id` 短 id | 显示舱名 |
| 用时 | `created_at → ended_at ?? now` | — |
| ¥ | `getCabinUsage(cabinId).byJob[job.id]` | 省略该段 |
| 模型 | `pro-max / pro / se`（`lib/agent/composer-settings.ts`） | 会话未就绪时显式「未就绪」 |
| 上下文构成 | `useAgentChat().contextUsage` | 「未就绪」 |
| token | `LlmUsageAggregates`（`useSessionLedger`） | 同上 |
| 本舱消耗 | `getCabinUsage` + `useBillingCurrency` | 同上 |
| 分身数 | `GET /api/agent/sessions/running` | HUD **隐藏**该统计，不写 0 冒充 |
| 在场 | `CockpitPrefs.presenceOn/presenceRate`（真实分钟） | — |
| 到达 | `CabinView.attention` 新增 id（10s 轮询；SSE `cabin_status` 可加速） | — |

- 「模拟回流」只在 `import.meta.env.DEV` 或 `?demo=1` 下渲染，生产不出现。
- 任何 `--` / `0` / `45%` 都不许当占位；要么真值，要么明确「未就绪 / 无此数据」。

### 1.6 关闭按钮规范（用户硬要求）

- **所有 header 的第一个可聚焦元素 = 关闭**，视觉在左。覆盖：聊天浮窗、作业面、模型/上下文/在场
  popover、立绘控制条、任务模块窗、编队抽屉。
- 关闭/最小化/锁定**按 classic 顺序从左排**：`✕ → — → 📌`，右侧只放拖拽握把与只读读数。
- **简报窗不设任何按钮**（含关闭）：10s 自动收，Esc 可提前收（走 LayerStack）。
- 用 DOM 顺序测试断言，**不许用 CSS `order` 反转**来伪装。

---

## 2. 架构

### 2.1 一个状态所有者（本轮最重要的修正）

草案把壳当纯拼装件，导致每个子组件各持一份 selection / 轮询 / telemetry，点行换不了面、
舰桥读不到聊天。改成：

```
CockpitShell
└─ CabinProvider（已有）
   └─ CockpitProvider（已有：prefs / mood / presence / --ck-*）
      └─ CockpitStateProvider      ← S1 新建；唯一可变状态
         └─ CockpitLayerStack      ← S1：Esc 栈
            └─ CockpitFleetProvider ← S2：唯一一次编队轮询
               └─ 布局：Hud / FleetRail / Face / ChatCore+ChatWindow+CommandBar / Bridge / Crew / Brief / Effects
```

`CockpitStateProvider` 的契约（S1 必须先把类型落死，后续 Step 只读它）：

```ts
// components/cockpit/state/cockpit-state.ts
export type CockpitRef =
  | { kind: 'job';       cabinId: string; id: string }
  | { kind: 'task';      cabinId: string; id: string }
  | { kind: 'attention'; cabinId: string; id: string }

export type CockpitTab = 'overview' | 'relay' | 'run' | 'changes' | 'accept'

export interface CockpitChatApi {
  model: string
  effort: 'low' | 'medium' | 'high' | 'max'      // 以 composer-settings 的真实档为准
  contextWindow: '200k' | '1m'
  streaming: boolean
  queueDepth: number
  canSend: boolean                                // 无主会话 → false
  contextUsage: ContextUsageData | null           // lib/agent/types
  usage: LlmUsageAggregates | null                // packages/shared/src/ledger
  submit(text: string): void                      // 程序化发送（真正的 composer 管线，含队列）
  stop(): void
  setModel(id: string): void
  setEffort(e: CockpitChatApi['effort']): void
  setContext(w: CockpitChatApi['contextWindow']): void
}

export interface CockpitState {
  entryCabinId: string
  selection: CockpitRef | null
  tab: CockpitTab
  select(ref: CockpitRef | null, tab?: CockpitTab): void
  setTab(tab: CockpitTab): void

  chat: CockpitChatApi | null
  reportChat(api: CockpitChatApi | null): void

  chatWindow: {
    open: boolean; mini: boolean; pinned: boolean; alpha: number
    rect: { x: number; y: number; w: number; h: number } | null
    set(patch: Partial<Omit<CockpitState['chatWindow'], 'set'>>): void
    openWithFocus(): void
  }

  railOpen: boolean
  setRailOpen(open: boolean): void

  /** 特效走信号量：谁都能触发，S1 星野 / S8 光效各自订阅，互不改文件。 */
  fx: {
    pulseNonce: number; pulseColor: string
    edgeNonce: number;  edgeColor: string
    jumpNonce: number
    pulse(color?: string): void
    edge(color?: string): void
    jump(): void
    say(line: string, mood?: MoodKey): void
    lastSaid: { nonce: number; line: string; mood?: MoodKey } | null
  }

  layer: {
    register(id: string, priority: number, close: () => void): () => void
    closeTop(): boolean
  }
}
```

- **`chat` 为 `null` 时**，舰桥 / ticker 显示「会话未就绪」，**不显示 `--`**。
- `chatWindow` 的几何/收起/锁定/透明度放在 state（不是组件内 state），因为浮窗关闭后
  ChatPane 仍要常驻（§2.4），且 S9 的键盘要能操作它。
- 选中的 `CockpitRef` 由 S1 的 `entry/use-cockpit-url-sync.ts` 单向同步到 URL；
  S9 在此之上补 origin / 默认选中 / 跨舱规则。

### 2.2 目录与文件所有权（**按目录切，不按文件切**）

```
packages/web-app/
├─ app/cockpit/
│  ├─ index.css              S1  只 import 下面这些 + token / 布局
│  ├─ base.css               S1  HUD / stage / 星野 / 安静层 / ticker / 通用 token
│  ├─ rail.css               S3
│  ├─ face.css               S4
│  ├─ chat.css               S5
│  ├─ bridge.css             S6
│  ├─ crew.css               S7
│  └─ fx.css                 S8
├─ components/cockpit/
│  ├─ shell/                 S1  CockpitShell / CockpitHud / CockpitStarfield / CockpitQuiet / CockpitTicker
│  ├─ state/                 S1  cockpit-state.ts / CockpitStateProvider / CockpitLayerStack
│  ├─ entry/                 S1→S9  cockpit-url.ts（纯函数）· use-cockpit-url-sync.ts · use-cockpit-entry.ts
│  ├─ fleet/                 S2  CockpitFleetProvider / fleet-model.ts / use-fleet-query.ts
│  ├─ rail/                  S3  CockpitFleetRail
│  ├─ face/                  S4  CockpitFace / CockpitJobHeader / CockpitAttentionFace
│  ├─ chat/                  S5  CockpitChatHost / CockpitChatWindow / CockpitCommandBar / geometry.ts
│  ├─ bridge/                S6  CockpitBridge + 两个 popover
│  ├─ crew/                  S7  CockpitCrew
│  └─ fx/                    S8  CockpitBrief / CockpitEffects
└─ components/cabin/
   ├─ job-progress.ts        S2  从 CabinFleet 抽出的 taskPct（S9 让 CabinFleet 改 import）
   └─ job-face.tsx           S4  从 CabinJobDetail 抽出的五页签主体（props 驱动）
```

**S1 必须把上面每一个文件都建成「真实空壳」**（导出正确签名，渲染 `null` 或「载入中」），
并让 `CockpitShell` 一次性 import 全部。这样 S2–S9 只改自己目录里的文件，
**永远不需要动 S1 的壳**（草案的 `CockpitSlot` 占位方案会让 5 个 Step 抢改同一个文件）。

`app/cockpit/index.css` 由 S1 一次写全 `@import './base.css'; … './fx.css';`，
后续 Step 各自填自己的空 css 文件。

### 2.3 文件修改表

| 文件 | 改什么 | 谁 |
|---|---|---|
| `lib/routes.tsx` | `CabinRoute` 改联合 + 新增 cockpit 路由 | S1 |
| `lib/route-components.tsx` | `CABIN_COMPONENTS` 加 `cabin-cockpit` + `CockpitShellRoute` | S1 |
| `components/providers/app-shell.tsx` | `ShellBody` 按 `componentKey` 分发 | S1 |
| `app/globals.css` | 加 `@import './cockpit/index.css'` | S1 |
| `components/cabin/CabinFleet.tsx` | **不改**（classic 行点击仍是作业详情窗 / 任务线程） | — |
| `components/cabin/modules/CabinJobDetail.tsx` | 改成薄容器，读 context 传 props 给 `JobFace` | S4 |
| `components/cabin/__tests__/CabinV3.test.tsx` | **不改**（继续断言 classic 行为） | — |
| `components/agent/chat/ChatArea.tsx` | `composerSlot?: HTMLElement \| null`、`composerVariant?: 'full' \| 'cockpit'`（**不删 composer**） | S5 |
| `components/agent/chat/ChatPane.tsx` | `onTelemetry`、`composerSlot`、`composerVariant` 透传 | S5 |
| `components/cabin/CabinChatHost.tsx` | 右上角加唯一入口按钮 `⛶ 全域`；抽出会话解析/事件桥给 `CockpitChatHost`（旧行为不变） | S5/S9 |
| `components/cabin/modules/CabinRunSummary.tsx` | 加 `showOpenRun?: boolean`（全域里不重复开窗） | S4 |

### 2.4 聊天怎么接（关键决策，替代草案的「隐藏 composer」）

草案打算 `hideComposer` + 新写 `send` 指令，会一次性丢掉队列、steer、停止、Esc 停止、附件、
`@分身`、`/斜杠`、以及「流式中不许直发」的保护（`useAgentChat.ts:487-490` 直接 return）。
改成**把真 composer 搬过去**：

- `ChatArea` 新增 `composerSlot?: HTMLElement | null`：有值时用 `createPortal` 把
  **原封不动的 composer JSX** 渲染进这个容器；无值时行为与今天逐字节一致。
- 新增 `composerVariant?: 'full' | 'cockpit'`：`'cockpit'` 只隐藏**已经搬到舰桥**的
  模型/上下文读数（避免重复），保留 textarea、附件、队列、停止、`@`、`/`、Esc。
- 全域底栏的 54px 输入区就是这个 slot。**输入框永远是真实 composer**，
  所以队列 / steer / 停止 / 附件天然可用，不需要另写一套。
- `CockpitChatHost` + `ChatPane` **全程挂载**：浮窗的 `✕ / —` 只切
  `chatWindow.open/mini`，用 `display:none` 隐藏 transcript 区域；
  **portal 内容不受隐藏祖先影响，输入框仍在底栏**。这样舰桥的 telemetry 永远有值，
  不会因为关窗变成永久 `--`。
- `layerRoot` 传**舱面挂载层 `#ck12-layer-root`**（不是 arena，也不是浮窗）：
  arena 在 `.ck12-stage` 的 stacking context（z-index 2）里，子节点再高也压不过 fixed 的
  聊天浮窗（z24）；这个层与 app 同大、`z-index:25`、`pointer-events:none`，
  `TaskModulesLayer`（运行/YAML/子代理窗）浮在整个舱面上，空层不吃点击。
- 全域里 `ChatPane` 传 `hideDock`：浮窗只留 transcript，右侧竖排作业坞（文件/活动/调试/消耗）
  在作业面里已有对应入口，不重复塞进浮窗。
- 全局输入框聚焦 → `chatWindow.openWithFocus()`（v12 行为）。
- 模型选择是**进程级**语义（`octopus.composer.settings.v2`），全域与桌面共用；
  舰桥的 popover 里注明「全局」，不做舱级 key（避免两套真源）。
- token 粒度：`contextUsage` 流式期间实时变；`sessionUsage` 在**回合结束**刷新
  （`useSessionLedger` 只在 session 变化与 streaming 真→假时取）。UI 不许暗示「边流边涨」。

### 2.5 特效走信号量

`fx.pulse/edge/jump/say` 只改 state 里的 nonce，不在组件之间互相 import：
- S1 的 `CockpitStarfield` 订阅 `jumpNonce` → `warp.jump()`；
- S8 的 `CockpitEffects` 订阅 `pulseNonce/edgeNonce` → 中心脉冲 / 四边流光；
- S1 的 `CockpitTicker` 订阅 `lastSaid`；S7 只调 `fx.say`；
- 换色调也调 `fx.jump()`（S9 或 S1 的换色按钮里）。

---

## 3. Step 列表

```
Wave 1  S1 路由壳 + 状态层 + 视觉底座 + 星野                (strong)
Wave 2  S2 编队数据层            S5 聊天（composer 搬迁 + 浮窗 + 底栏）   (default / strong)
Wave 3  S3 左栏编队   S4 作业面   S6 舰桥   S7 立绘/在场   S8 到达/特效   (default / strong / default / default / default)
Wave 4  S9 入口/出口 + 关灯组审计 + 键盘                     (default)
Wave 5  S10 真数据 E2E + 响应式 + 性能 + 文档                (strong)
```

- 同一 Wave 内**没有任何两个 Step 共享文件或目录**（S1 已把所有空壳建好）。
- S7 只依赖 S1（在场来自 `CockpitProvider`，与舰桥无关）；S8 只依赖 S2（arrivals）。
- S9 顺序接管 `entry/` 与 `CabinFleet.tsx`，不同 Wave 并行，不冲突。
- 每个 Wave 结束跑一遍 §7 的**集成闸门**再开下一个 Wave。

---

## Step 1 — 路由壳、状态层、视觉底座与星野

**依赖**：无 · **可并行**：否 · **模型**：strong

### Context Brief
- `CabinRoute` 是全字面量接口，直接加对象过不了类型检查，见 §1.1 的联合写法。
- `ShellBody`（`components/providers/app-shell.tsx:42-56`）现在对 `kind==='cabin'` 无条件渲染
  `CabinShellRoute`，必须改成 `CABIN_COMPONENTS[route.componentKey]`。
- 全域座舱**不要 `DesktopHeader`**，它有自己的 HUD。
- `CockpitProvider` 必须在 `CabinProvider` 内（它读 cabin 的 `cockpit_prefs`，写 `--ck-*` 到 root）。
- `app/globals.css` 已在顶部 import `cabin-cockpit.css`，沿用风格加 `cockpit/index.css`。

### Tasks
1. **路由**：按 §1.1 改 `CabinRoute` 联合、`CABIN_ROUTES` 加 cockpit 条、
   `route-components.tsx` 加 `CabinCockpitRoute`（lazy `CockpitShell`）与 `CABIN_COMPONENTS` 条目、
   `ShellBody` 按 `componentKey` 分发。顺手确认 `titleForRoute` / `useIsActiveRoute` 对两条都成立。
2. **`CockpitStateProvider` + `CockpitLayerStack`**：按 §2.1 的接口**写全**（selection / tab /
   chatWindow / railOpen / fx / layer）。`chat` 先恒为 `null`。Esc 栈用 capture 阶段单一监听。
   `fx` 用 `useState` nonce，勿用 `useRef` 绕过渲染。
3. **空壳**：把 §2.2 里 S2–S8 的每个组件文件建成导出正确 props 的 no-op
   （`CockpitFleetRail` 返 `null`、`CockpitFace` 返 `载入中`…），`CockpitShell` 一次性 import 全部。
   `app/cockpit/{rail,face,chat,bridge,crew,fx}.css` 建空文件，`index.css` 写全 import。
4. **CSS 底座**：把 v12 的 token / `.bg` / `.hud` / `.stage` / `.quiet` / `.cmd` 外层 / ticker
   搬进 `base.css`，类名加 `ck12-` 前缀，颜色换 `var(--ck-a/b/c)` 与 `pop-*`，字体用 app 字体。
   `prefers-reduced-motion` 全量保留。
5. **`CockpitStarfield`**：canvas 2D；300 星 z 投影拖尾 + 230 尘埃（reduced 130/90）；
   `jump()` 拉线 + 跃迁环；读 `getComputedStyle(document.body)` 的 `--ck-a/--ck-b` 生成调色板；
   彗星 7–17s；DPR ≤2；`document.hidden` 暂停；卸载清理 RAF/监听。
6. **`CockpitHud`**：品牌、四统计（S1 全部走空态「—」占位文字，**不写 0**；S2 接真值）、
   `← 返回作战舱`（左）、`◐ 换色`（`applyPrefs` + `fx.jump()`）、`⛶`；
   `☰ 编队` 只切 `railOpen`。
7. **`CockpitQuiet`**：真实时钟（每秒）+ 空读数 + `⌥1 / ⌘K` 提示。
8. **`CockpitTicker`**：读 `fx.lastSaid` 与 `chat.streaming`，空的就显示「等她开口」。
9. **载入 / 异常 / 空态**（对齐 `CabinShell` 的 gates）：
   - 载入 → 骨架；
   - 舱不存在 / 404 → 「舱不在了」+ 返回；
   - `status === 'draft' | 'initializing'` → 顶部横幅 + 去初始化的链接；
   - `main_session_id == null` → 聊天区「该舱还没有主会话」、输入框 disabled（S5 落）；
   - 无编队行 → 安静层照常。
10. 响应式断点：≤1360 / ≤1120（左栏浮层，`railOpen`）/ ≤900；无横向溢出。

### Verification
```bash
pnpm --filter @octopus/web-app typecheck      # CabinRoute 联合必须过
pnpm --filter @octopus/web-app test -- components/cockpit
pnpm --filter @octopus/web-app lint
```
- 手工：`/cabin/<id>/cockpit` 与 `/cabin/<id>` 都能开；1440/1280/1024/900 无横向溢出；
- 星野 30fps+；reduced-motion 近静止；卸载后 RAF 停止、`--ck-*` 清理；
- 0 console/page error。

### Exit criteria
- 路由可达、壳构图与 v12 一致；状态层接口齐全且**被所有空壳消费**；
- 没有任何假数字；空态有明确文案。

### Rollback
- 只新增路由与文件，旧舱零改动；删路由条目即回滚。

---

## Step 2 — 跨舱编队数据层

**依赖**：S1 · **可并行**：与 S5 · **模型**：default

### Context Brief
- 每个舱：`listCabinJobs(cabinId)` → `CabinJobView`；`getCabin(id)` → `{cabin, view}`，
  `view.attention: CabinAttentionItem[]`。
- **attention 的 `job_id` 可空**（`finding-*` / 部分裁决审批）。这类必须**保留**，
  否则 HUD 的「需要你」与编队对不上，且会丢掉一整类需要处理的事。
- 历史舱可能**没有任何 job**，但有活态任务 → `CabinFleet` 现在会合成 `task:<id>` 行。
- `useCabinTasks(cabinId)`（`modules/ui.tsx:174-200`）= `listTasks` + **逐任务 `getTask`**（N+1），
  10s 轮询。跨舱直接照搬会放大成几十个请求。
- `cabinEventsUrl(id)` 是现成 SSE（`cabin_status`），可当「立刻重取」的触发器，但**轮询是保底**。
- `taskPct` 现在藏在 `CabinFleet.tsx:28-42`。

### Tasks
1. `fleet/fleet-model.ts`（纯函数，无 React）：
   - `CockpitRow` 三型：
     ```ts
     type CockpitRow =
       | { key: `job:${string}`;  kind: 'job';       cabinId: string; cabinName: string;
           job: CabinJobView; attention?: CabinAttentionItem; pct: number | null }
       | { key: `task:${string}`; kind: 'task';      cabinId: string; cabinName: string;
           task: CabinTaskRow; pct: number }
       | { key: `attn:${string}`; kind: 'attention'; cabinId: string; cabinName: string;
           item: CabinAttentionItem }
     ```
   - `groupOf(row)`：`need | run | queue | done`。
     attention(`awaiting==='person'` 或 stage `blocked`) → need；
     job 有 attention（含 job_id 匹配）→ need；`running` → run；`pending/ready/queued` → queue；
     `ended/cancelled/done` → done。
   - 排序：need 按 `attention.priority` desc；run 按 priority；queue FIFO；done 按 `ended_at` desc 取前 3。
   - `counts`：need / run / queue / done / perCabin / jobs / sessions。
   - **attention ↔ job 合并规则**：`job_id` 命中的 attention 挂到 job 行（行内小徽章），
     不再单独成行；未命中的单独成 `attn:` 行，放在 need 组、job 行之后。
   - `duration(job | task, now)`、`statusLabel`、`metaLine`（舱名 · iteration_code/transport）。
2. `fleet/use-fleet-query.ts`：
   - 对每个非 archived 舱并行 `Promise.all([getCabin, listCabinJobs])`；10s；失败保留上一份快照；
   - **历史舱无 job** → 补一次 `listTasks({cabin_id})` 合成 task 行（只在这类舱发生，故历史舱 3 请求、普通舱 2 请求）；
   - **任务进度富化**：只对「当前可见 + kind 为 task」的行取 `getTask`，**上限 12 条**，
     按 task id 缓存 30s；超限的行 `pct = null`（不画条，不猜）；
   - 可选：订阅 `cabinEventsUrl` 的 `cabin_status` → 立即重取（失败静默回轮询）；
   - 卸载/切舱 abort；**重复请求检查**：普通舱一次 tick 2 个请求、历史舱 3 个。
   - `arrivals` 只报**老舱**的新 attention id：新加入编队的舱，其存量 attention 不算「到达」
     （否则新建/换舱时会凭空弹一张「N 件需要你」的简报）。
3. `fleet/CockpitFleetProvider.tsx`：把上面包成 context
   `{ rows, counts, arrivals, loading, error, refetch }`；`arrivals` = 新增 attention id
   （另含新增 attention-only 行）。**全应用只此一处轮询。**
4. `components/cabin/job-progress.ts`：把 `taskPct` 原样搬出来并导出（S9 让 `CabinFleet` 改 import）。
5. 单测 `fleet/__tests__/fleet-model.test.ts`：分组 / 排序 / 合并 / 三型行 / counts / duration /
   arrivals / 空舱 / 历史舱回退 / 无 job_id 的 attention / 富化上限与 pct=null。

### Verification
```bash
pnpm --filter @octopus/web-app test -- components/cockpit/fleet
```
- 3 舱 × 8 作业 fixture：need 组含 attention-only 行；合并行不重复；切舱不串数据；
- 失败保留快照；网络面板确认 10s 一次、不重复；`taskPct` 单测与原实现一致。

### Exit criteria
- 纯函数覆盖率 ≥90%（用 `pnpm test -- --coverage` 或人工核对分支，**不新引覆盖率工具**）；
- 不引入服务端改动；`pct` 只会是真值或 `null`。

---

## Step 3 — 左栏编队

**依赖**：S2 · **可并行**：与 S4/S6/S7/S8 · **模型**：default

### Context Brief
- 视觉：v12 `.rail`（300px，`z-index:7`）；组标题 `需要你 / 运行中 / 排队 / 已完成`；
  行 `.frow` ~52px；左 2px 状态色；右侧状态文字；舱筛选胶囊 19px；底部一行键盘提示。
- 交互：点行 → `select(ref)`；`↑↓` 换；`⌥1` 回到最紧要；≤1120 变抽屉（读 `railOpen`）。
- 数据只从 `useCockpitFleet()` 来，**不自己 fetch**。

### Tasks
1. `CockpitFleetRail`：舱筛选（全部 + 每舱计数）→ 四组 → 行。
   行内容按 `CockpitRow` 三型分支：
   - job：类型字形 + 标题 + 舱色点 + 副行 + 状态；`pct !== null` 才画条；
   - task：同形，副行是 `repo_group`，带「任务」字样；
   - attention-only：阶段色 + `title` + `question` 截断 + 舱名；右侧「等你」。
2. 选中态：左 2px `--a` + 微光底；`role="listbox"` + `aria-selected`；`aria-activedescendant`。
3. 键盘：`↑↓` 在**当前可见组**内移动并 `select`；`⌥1` 跳 need 首条；Esc 由 LayerStack 收。
4. 新行 `pop` 动画 900ms（S2 `arrivals`）。
5. ≤1120 抽屉：`railOpen` 驱动；点外部 / Esc 收；HUD 的 `☰` 由 S1 提供。
6. 空态：「编队空着 · 从主对话派一条」。
7. RTL：三型行渲染、点击回调、键盘、计数、抽屉、空态、`pct=null` 不画条。

### Exit criteria
- 8 行在 900px 高全可见；不换行/不溢出；点击与选中一致；无假进度条。
- 1440/1280/1024 截图与 v12 的 `.rail` 一致（行高、字号、间距、组标题）。

---

## Step 4 — 作业面：头 + 五页签 + attention 面

**依赖**：S2 · **可并行**：与 S3/S6/S7/S8 · **模型**：strong

### Context Brief
- `CabinJobDetail` 已实现五页签真数据，但**深度耦合 `useCabinContext()`**
  （`cabinId / cabin / selectedJobId / refresh`，`:58,69-81,132,141,154,169,184`）。
  跨舱查看必须改成 props。对接页签的 `octopus:cabin-main-chat`（`:348-354`）只对入口舱开放。
- 复用件：`CabinRunSummary`（运行摘要）、`RunWindow`（DAG+日志，需 `task/runTarget/onTaskAction/onOpenYaml`）、
  `ChangesWindow`、`AcceptanceWindow`（内含 `AcceptanceSurface`）、`SubagentWindow`。
- 作业头字段很多在数据模型里**不存在**（§1.5 的派生表），不许硬塞空值。

### Tasks
1. **抽 `components/cabin/job-face.tsx`**：
   ```ts
   export interface JobFaceProps {
     cabinId: string; cabinVersion: number; workspaceId: string | null
     jobId: string; variant: 'window' | 'cockpit'
     entryCabinId: string                    // 判断对接页签是否可投递
     onMutated?: () => void
   }
   ```
   保留 10s 轮询、重置、task 实体、五页签逻辑；所有 `useCabinContext()` 的点改成 props；
   `CabinJobDetail` 改成薄容器（读 context + 原 header 不动 + `variant="window"`）。
   **旧窗口的 DOM/行为逐字不变 → `CabinV3.test.tsx` / `CabinModulesP3.test.tsx` 必须绿。**
2. **`CockpitJobHeader`**（`variant="cockpit"`）：
   - 行1：`✕`（**第一个**）→ 类型 → 标题（省略号）→ 状态 → spacer → 5 页签；
   - 行2：按 §1.5 派生表拼 `分支 · 在做 · 舱/执行者 · ⏱ · ¥`，**空值整段省略**；
   - 右侧主操作 = `去处理 →`（按 stage 切页签：review→验收、answer/adjudicate→对接、blocked→运行），
     外加按 kind 的真实动作：task → 中止/暂停/恢复；workflow → 交给运行页签的 `RunWindow`；
     subagent → 打开子代理窗。**不新写状态机，全部落到现有 API。**
3. **`CockpitAttentionFace`**（attention-only 行）：阶段徽章、awaiting、`title/question/detail`、
   `repo/wt`、时间。CTA **只在有真实去处时出现**：`task_id` → `octopus:open-task`
   （在聊天里打开该任务，`stage==='review'` 带 `view:'acceptance'`）；
   `finding:` 类目前没有可深链的知识中心路由，**只展示事实、不放按钮**；
   其余 `deep_link` 同理。空字段省略，不做死按钮。
4. **五页签主体**直接嵌 `JobFace` 的 panes；`CockpitFace` 只做 chrome + 选中解析
   （用到 fleet 的 row 拿 `cabinName`）。
5. **运行页签**：保留 `CabinRunSummary` + 现有 `octopus:open-run-window` 事件路径
   （由 ChatPane 的 `TaskModulesLayer` 承载），**不内嵌第二份 `RunWindow`**。
   S5 已把 `layerRoot` 指向 `#ck12-arena`，所以运行窗/ YAML 窗浮在整个舱面上，
   不会被夹在聊天浮窗里。`CabinRunSummary` 不需要新 prop。
6. **非 task 作业**的变更/验收：明确空态（「工作流作业没有交付验收单」），不伪造。
7. 动作反馈：toast + 立即 `refetch()`（S2）；通过/打回后落下一行「需要你」（§1.3）。
8. RTL：
   - 五页签渲染与切换、空态、动作调用（mock API 断言参数）；
   - **DOM 顺序断言**：header 第一个可聚焦按钮是关闭；
   - 跨舱：`cabinId` 与 `entryCabinId` 不同时，「对接」投递按钮不存在。

### Verification
```bash
pnpm --filter @octopus/web-app test -- CabinModulesP3 CabinV3 job-face cockpit/face
```
- 8 条作业 × 5 页签无空面；旧详情窗回归全绿；窄屏（1024）页签不换行、头部不溢出。

### Exit criteria
- 五页签全部真数据；无「占位 / 后续上线」；关闭在左；跨舱不串舱。

---

## Step 5 — 聊天：composer 搬迁 + 浮动对话窗 + 底栏

**依赖**：S1 · **可并行**：与 S2 · **模型**：strong

### Context Brief
- `CabinChatHost` 负责：主会话解析、`shared`、`command`、`ChatPane`、事件桥
  （`octopus:open-task` / `octopus:cabin-main-chat`）。
- `ChatPane` 把 `layerRoot` 传给 `TaskModulesLayer`（`:1521-1533`）；
  `ChatArea` 的 composer 里含队列 / steer / 停止 / Esc / 附件 / `@` / `/`（§0.1）。
- **不要新写 send**。按 §2.4 用 `composerSlot` 把真 composer 搬到全域底栏。
- 几何工具已存在：`lib/window-geometry.ts` 的 `clampRect / resizeRect / stageSize`——复用，
  **不要再写一套 `cockpit-geometry`**。

### Tasks
1. **`ChatArea` 两个新 prop（默认行为不变）**：
   - `composerSlot?: HTMLElement | null`：非空时 `createPortal(composer, slot)`；空时原样内联。
   - `composerVariant?: 'full' | 'cockpit'`：`'cockpit'` 时隐藏模型/上下文读数（舰桥接管），
     其余（输入、附件、队列、停止、`@`、`/`、Esc）全保留。
   - 把内部 `submit` 的入口暴露给上层：给 `ChatPane` 一个 `composerBridgeRef` 或
     `onReady({ submit, stop, streaming, queueDepth })`，**复用同一份提交管线**（含队列/steer）。
2. **`ChatPane` 新 prop**：`onTelemetry?: (t: CockpitChatApi) => void`（含
   `model/effort/contextWindow/streaming/queueDepth/canSend/contextUsage/usage/submit/stop/setModel/setEffort/setContext`），
   并透传 `composerSlot / composerVariant`。默认不传 = 今天的 ChatPane。
3. **`CockpitChatHost`**：从 `CabinChatHost` 抽出会话解析 + `shared` + `command` + 事件桥；
   `CabinChatHost` 改为调用它（旧行为逐字不变）。它负责：
   - 把 `onTelemetry` 的结果写进 `CockpitState.reportChat`；
   - `layerRoot` = 舱面 arena（S1 通过 context 提供 `arenaEl`，或用 `document.getElementById('ck12-arena')`）；
   - `composerSlot` = 底栏的 slot 元素；
   - **全程挂载**；浮窗关闭只 `display:none` transcript 区。
4. **`CockpitChatWindow`**：`position:fixed; z-index:24`；
   默认几何按 §0.3 由 `arena` + `.scene` 的 `paddingLeft` 算（复用 `clampRect`）；
   ticker 收起后 `requestAnimationFrame` 重算一次补满；拖标题栏用 pointer capture、右下 18px resize；
   `📌` 锁拖；`—` 收起 47px；`◍` 五档 `94/82/70/55/100` 写 `--oa`；越界夹回视口；
   灯组在左 `✕ → — → 📌`，右侧只放握把与读数；换作业/换页签**不关窗**。
5. **`CockpitCommandBar`**：ticker（S1）+ rig 槽（S6 填）+ 54px 输入区（`composerSlot`）。
   输入区聚焦 → `chatWindow.openWithFocus()`；`⌘K` 同效；无主会话 → 禁用 + 文案。
6. `chat/geometry.ts`：把「默认几何 / 夹回 / mini」写成纯函数（内部调 `window-geometry`），单测。
7. 单测：几何默认值（1440/1280/1024 × 各 `paddingLeft`）、夹回、mini、透明度档位循环；
   RTL：composer 被 portal 后**仍能输入并触发 submit**（这是本 Step 的命门）。

### Verification
```bash
pnpm --filter @octopus/web-app test -- components/cockpit/chat components/agent/chat
```
- 手工：在底栏输入 → 进入 chat 并流式；流式中再输入 → 队列提示；Esc → 停止；
  附件按钮、`/` 列表、`@` 补全可用；`✕` 关窗后底栏仍可输入、舰桥读数不变；
  拖到左栏上方、缩到 320×240、迷你、锁定、透明度循环。

### Exit criteria
- 聊天能力与现有舱内聊天**等价**（队列/停止/附件/斜杠/提及全在）；
- 旧舱聊天与桌面聊天回归全绿；0 console error。

### Rollback
- 两个新 prop 均为 opt-in；`CabinChatHost` 仅改为委托，行为不变。

---

## Step 6 — 舰桥

**依赖**：S5 · **可并行**：与 S3/S4/S7/S8 · **模型**：default

### Context Brief
- 模型真源：`lib/agent/composer-settings.ts` 的 `pro-max / pro / se`；
  写入 `useComposerSettings`（**进程级**）；读走 S5 的 `CockpitChatApi`。
- 上下文：`ContextUsageData`（`categories[{name,tokens,color}] / totalTokens / maxTokens / percentage / model`）。
- token：`LlmUsageAggregates`（input/output）；**回合结束才更新**。
- 本舱消耗：`getCabinUsage(entryCabinId)` + `useBillingCurrency`。
- 在场：`useCockpit().prefs.presenceOn / presenceRate` + `setPref`；频率是真实分钟。
- 视觉：v12 `.rig` 24px 一行；`◉` 上下文环 `conic-gradient` + mask；popover 334/392 宽，
  向上弹贴按钮，点外 / Esc 收，**关闭在左**。

### Tasks
1. `CockpitBridge` 一行：`◇ 模型 ▾` · `◉ 42% 上下文` · `↑ 12.4k ↓ 3.1k` · `¥ 1.28 本舱` · `◉ 在场 · 标准`。
   `chat === null` → 每项显示「未就绪」并禁止点（**不是 `--`**）。
2. 心智 popover：三个真别名 + 一句说明 + 窗口 + 价格；推理强度用**真实档位**（低/中/高/最大）；
   `setModel/setEffort` 走 `CockpitChatApi`；注明「仅影响对话 / 全局设置」；`⌘⇧M` 循环。
3. 上下文 popover：`已用/上限 + 百分比`、构成条 + 图例（直接画 `contextUsage.categories`）、
   本舱按主体用量（`getCabinUsage.byJob`）、
   **「压缩上下文」= 向 composer 提交 `/compact`**（真路径，经 `submit`），成功后 toast；无接口就不假装本地压缩。
4. 在场 popover：开关 + 频率（quiet/std/active，显示真实分钟区间）+「现在说一句」（`testPresence()`）；
   写 `setPref`。
5. 实时性：`contextUsage` 流式实时；token/成本**回合结束**刷新（UI 文案「回合结束更新」）；
   切模型后 rig 立即变。
6. RTL：三项读数、两个 popover 的开关与写入调用、close 在左、`chat===null` 的禁用态。

### Exit criteria
- 无 `--`；无假值；每个读数都能点到来源；模型切换对下一轮生效；在场频率与真实设置一致。

---

## Step 7 — 立绘、台词与在场

**依赖**：S1（只用 `CockpitProvider`） · **可并行**：与 S3/S4/S6/S8 · **模型**：default

### Context Brief
- `CockpitProvider` 已暴露 `mood / setMoodOverride / presenceLine / presenceDueAt / snoozePresence /
  testPresence / setCrewBusy`；`useXiyinState` 已实现事实优先话术 + 闸门。
- 立绘：`public/cabin/xiyin-*.png` + `moodPortrait(mood)`；`MoodKey` 共 10 个值（画廊不一定要全列，
  以 `cockpit.ts` 的导出为准，不硬编码 9）。
- 台词只进气泡 + ticker（`fx.say`），**不写 chat**。

### Tasks
1. `CockpitCrew`：立绘 344×min(60vh,548) 左下 + 头顶漫画气泡（打字机）+ 名字右侧情绪标签；
   点立绘弹控制条（`说一句 / 互动一下 / 表情画廊 / 在场频率`）。
2. 「说一句」→ `testPresence()`；「互动」→ 随机台词 + `setMoodOverride(mood, 3000)` + heart；
   画廊 → `setMoodOverride`；频率 → `setPref('presenceRate', …)` 并显示真实分钟。
3. `presenceLine` 变化 → `fx.say(line, mood)`（气泡 + ticker 各一份，不进 chat）。
4. `setCrewBusy(chat.streaming)`：流式时闸门等待。
5. `prefers-reduced-motion`：heart / 浮动关掉；打字机直接出全文。
6. RTL：点立绘开控制条、画廊切换、`fx.say` 被调用、**chat DOM 里没有出现这句台词**、关闭在左。

### Exit criteria
- 立绘在所有面状态下原尺寸；控制条不挡脸；在场不写 chat；reduced-motion 下无动画。

---

## Step 8 — 到达、简报与全局特效

**依赖**：S2（arrivals） · **可并行**：与 S3/S4/S6/S7 · **模型**：default

### Context Brief
- 到达源：`useCockpitFleet().arrivals`（新增 attention id）。
- v12 到达动作：右上简报 340px（**无按钮**，10s 自动收）+ 中心脉冲（attention 色）+
  四边流光 2.4s + 编队行 pop + HUD 计数 pop。
- 阶段色：`ATTENTION_STAGE_META`（review 绿 / answer 青 / adjudicate 琥珀 / approval 黄 / blocked 红）。
- 主题：读 `--ck-a/b/c`；换色由 HUD 调 `fx.jump()`。
- 演示触发器只在 DEV / `?demo=1`。

### Tasks
1. `CockpitBrief`：头像 + 阶段 + 标题 + 一句说明 + 时间；10s `setTimeout` 自动收；
   **不渲染任何按钮**；挂到 `layer.closeTop` 以便 Esc 提前收。
2. `CockpitEffects`：`.ck12-edgefx` 四条 3px + `.ck12-fx` 中心脉冲；
   订阅 `fx.edgeNonce / fx.pulseNonce`；`pointer-events:none`；`z-index:21`
   （HUD/底栏之上、popover 之下）；reduced-motion 下不渲染。
3. 同一时刻多条到达合并成一张简报（计数 +N），不叠窗。
4. 到达时 `fx.say` 一句（S7 的气泡 / ticker 消费；S8 不直接依赖 S7）。
5. RTL：简报无 `button`（数量断言为 0）、10s 后消失（fake timers）、合并计数、
   edge/pulse 只在 nonce 变化时触发、reduced-motion 不挂载。

### Exit criteria
- 到达「只报信、不用点」；特效只擦边缘不压字；换色后颜色跟随；无 console error。

---

## Step 9 — 入口 / 出口、关灯组审计、键盘

**依赖**：S3 + S4 · **可并行**：否 · **模型**：default

### Context Brief
- `CabinFleet` 现在：行点击 → `openJobDetail`（job 行）或 `openTaskInChat`（task 行）。
  **这个行为保留**：classic 是一套独立界面，不因全域改道，`CabinV3.test.tsx` 不动。
- 全域的唯一入口是 classic 舱壳右上角的新按钮（`CabinChatHost`），出口是 HUD 左侧「← 返回作战舱」。
- 桌面内进入时 URL 从 `/` 变成 `/cabin/:id/cockpit`，`ShellBody` 会整屏换壳；
  `CabinModeProvider` 在 `ShellBody` 之上，所以返回原路径能恢复桌面，但**必须显式记录 origin**。
- `entry/use-cockpit-entry.ts` 由 S1 建最小版，S9 接管并扩展。

### Tasks
1. `CabinChatHost` 右上角加 `⛶ 全域`（`data-testid="cabin-enter-cockpit"`）→
   `enterCockpit({ cabinId })`；不改动任何既有 DOM/交互（编队、作业坞、聊天）。
2. `CabinFleet`：**零改动**。不把行点击改成 `enterCockpit`，不加「详情」小按钮，
   不动进度条（classic 保持用户熟悉的原样）。
3. `use-cockpit-entry.ts`：
   - `enterCockpit`：写 origin（`sessionStorage`）、`push` 路由；
   - `exitCockpit`：有 origin 回 origin，否则 `/cabin/:entryCabinId`；
   - 默认选中（§1.3）、无效 ref 回退、跨舱 ref 允许；
   - `select` 同步 `replace` URL（含 `tab`）。
4. 键盘：`↑↓`（S3）、`⌥1` 最紧要、`⌥2` 收面、`⌘K` 聊天、`⌥W` 跃迁；
   全部先过 `useIsActiveRoute`（与仓库约定一致），避免和桌面抢键。不做 `⌥G`。
5. **关灯组审计**（逐项 DOM 顺序断言）：
   - 聊天浮窗、作业面、模型/上下文/在场 popover、立绘控制条、任务模块窗、编队抽屉；
   - 简报除外（无按钮）；
   - 不许用 CSS `order`。
6. 换色：HUD `◐` → `applyPrefs` + `fx.jump()` + `fx.pulse()`。
7. 单测/E2E（本 Step 内可手测，S10 补真跑）：
   - **classic 不受影响**：编队行仍开作业详情窗、URL 不变；
   - 点 `⛶ 全域` → 进入全域并由默认选中落一条真行；
   - `?job` / `?task` 深链各落在对应行；返回回原位置（桌面内回桌面）；
   - `Esc` 顺序；深链可分享。

### Exit criteria
- 入口/出口闭环；桌面内进出来回不掉窗口；关闭按钮全在左；旧详情窗仍有入口且测试更新后绿。

---

## Step 10 — 真数据 E2E、响应式、性能、文档

**依赖**：全部 · **可并行**：否 · **模型**：strong

### Context Brief
- `playwright.config.ts` 自己解析 web 端口；`webServer` **只起 Vite**，后端 3001 必须已存在，
  且 `OCTOPUS_SERVER_URL ?? http://localhost:3001`。
- `e2e/tests/auth.spec.ts` 打的是 `/login`，本 SPA **没有登录页** —— 整套 E2E 现在本来就不是全绿。
  **不许把「E2E 全绿」写成总验收条件**；只跑本 Step 新增的 spec。
- 现有 helper 没有舱/作业播种；`main_session_id` 要在 init 之后才存在。
  可用 `createCabin` / `dispatchCabinJob` / `initCabin`（`lib/cabin-api.ts`）。
- 工作流/任务类 job 需要真 task 才有运行/变更/验收内容；只用 REST 直建最小 task。

### Tasks
1. `e2e/helpers/cockpit-helpers.ts`：
   - `seedCabin()` → `createCabin`；`seedJob(cabinId, kind)` → `dispatchCabinJob`；
   - `seedAttention()` → 走现有 attention 来源（finding/裁决）或直接 SQLite 写一条 `cabin_job_events`
     （若只能 DB，脚本化并注明依赖 dev DB）；
   - `gotoCockpit(cabinId, ref?)`。
   - 必须有 `main_session_id == null` 的分支测试（草稿舱）。
2. `e2e/tests/cockpit-global.spec.ts`（**只跑这一条**）：
   - **classic 行点击仍开详情窗（断言 URL 不进全域）**；`⛶ 全域` 进入；`?job` / `?task` / `?attn` 深链各一条；
   - 五页签逐一打开，断言真实内容非空（事件时间线、变更文件、验收清单、运行节点或明确空态）；
   - 聊天：底栏输入 → 流式 → 停止；关窗后底栏仍可输入；附件/斜杠入口存在；
   - 浮窗：拖到左栏、缩、mini、pin、透明度、换页签不关、聚焦输入框自动开；
   - 到达：简报 0 个按钮 + 10s 消失 + edgefx 出现；
   - 换色：`--ck-a` 变化；
   - 1440/1280/1024/900：无横向溢出；关闭按钮 DOM 顺序。
3. 性能：星野 RAF 在隐藏/卸载停止、DPR ≤2、1000 行编队开启虚拟化或分页（按需）、
   reduced-motion 全覆盖；一次 tick 请求数 ≤ 舱数 × 2 + 12。
4. a11y：`role=tablist/tab`、`aria-selected`、焦点环、`aria-label`；axe 0 serious。
5. 视觉：1440 截图与 v12 并排比对（间距/字号/层级/灯组位置），差异清单必须为空或逐条记录原因。
6. 文档：
   - `design/11-global-mode.md` 增「实现状态 / 文件映射 / 数据来源」；
   - `README.md` 全局模式段标「已落地」；
   - 新增 `design/12-cockpit-implementation.md`：与 v12 的差异（关闭在左、无自然语言切场景、
     简报无按钮、模型是全局设置、跨舱只读、token 回合粒度、无 SSE 依赖）。
7. 清理：`?preview=1` 门禁（若 S1 加了）与 demo 触发器收口到 DEV；删临时脚本/截图。

### Exit criteria（总验收）
- `pnpm --filter @octopus/web-app typecheck && test && lint` 全绿；
- **新增 spec 全绿**（并在文档中写明「整套 e2e 有历史遗留红」这一事实）；
- 0 console/page error；无假数据；无永久 `--`；
- 五页签、聊天（含队列/停止/附件）、舰桥、立绘、到达、换色、入口/出口全部可用；
- 关闭按钮全部在左；1440/1280/1024/900 无横向溢出；旧舱回归全绿。

---

## 4. 子代理执行手册

每个 Step 派一个子代理：

```
你在 open-octopus 仓库实现全域座舱（plans/cabin-cockpit-v12.md）的 Step N。
先读本 Step 的 Context Brief / Tasks / Exit criteria，以及 §1 契约与 §2 架构。
视觉真源：docs/cabin-design/cockpit-v12.html（用浏览器打开逐块对照）。
只改 §2.2 里属于 Step N 的目录/文件；S1 已建好空壳，不要去改 S1 的文件。
状态只从 CockpitState / CockpitFleet context 读，不要在组件里另起轮询或本地真源。
不 mock 业务数据；字段缺失按 §1.5 派生或省略；不许出现假数字 / 永久 "--"。
关闭按钮必须是 header 第一个可聚焦元素（classic 灯组，在左），并加 DOM 顺序测试。
先补测试再实现；完成跑 typecheck + 目标测试 + lint。
汇报：改了哪些文件、测试命令与结果、与 v12 的视觉差异、未决问题。
```

- Wave 只按 §3 的顺序放；同一 Wave 内可一次性并行派发。
- 每个 Wave 结束由主代理跑 §7 集成闸门，**不通过不许开下一 Wave**。

---

## 5. 风险与对策

| 风险 | 对策 |
|---|---|
| composer portal 后布局/聚焦异常 | `composerVariant='cockpit'` 只做呈现裁剪；focus 由底栏容器统一管理；RTL 断言「能输入并 submit」 |
| ChatPane 常驻导致后台轮询 | 与今天舱内一致（本就常驻）；浮窗关闭只 `display:none`，不卸载 |
| 跨舱请求放大 | 一次 tick 每舱 2 个请求；task 富化上限 12 + 30s 缓存；可选 SSE 触发 |
| attention-only 行没有五页签 | 专用 `CockpitAttentionFace`，只给真实字段 + `deep_link` |
| 作业头字段不足 | §1.5 派生表 + 空值省略；绝不填空串/假值 |
| 桌面内进入会换兄弟壳 | origin 记录 + 返回原路径；`CabinModeProvider` 在壳之上，状态可恢复 |
| 旧作业详情窗失去入口 | **不发生**：classic 行点击保持原行为，全域走独立按钮 |
| Esc 与 Radix 双触发 | 唯一 capture 栈 + `onEscapeKeyDown` 让行 |
| CSS 并行冲突 | 一 Step 一个 css 文件，S1 一次写全 import |
| 星野性能 | DPR ≤2、隐藏暂停、reduced-motion 近静止、粒子数按原型 |
| 压缩上下文没有端点 | 走 `/compact` 真路径，不实现本地假压缩 |
| E2E 环境不可控 | 只跑新增 spec + 明确记录整套 e2e 的历史红 |

---

## 6. 待确认（不阻塞开工，按括号默认执行）

1. 全域座舱是**独立路由**（默认）还是同时也要能在桌面窗口内打开？（后续 Step）
2. ~~编队行点击完全取代旧作业详情窗，还是保留（默认保留）~~ → **已定（2026-11-14）：classic 行点击保持原行为（开作业详情窗）；全域只经 `⛶ 全域` 按钮进入**。
3. 跨舱作业选中时聊天是否跟到该舱主会话（默认：不跟；跨舱只读）。
4. 生产是否保留演示触发器（默认：仅 DEV / `?demo=1`）。
5. 聊天浮窗的位置/大小/透明度是否跨会话记住（默认：只记本次会话）。
6. 舰桥是否需要「按作业覆盖模型」（默认：不需要，模型只影响对话且是全局设置）。

---

## 7. 每个 Wave 的集成闸门

子代理各自绿 ≠ 拼起来能用。每个 Wave 结束后由主代理手工过一遍：

**Wave 1 后**
- `/cabin/<真 id>/cockpit` 打开有 HUD + 星野 + 安静层；`/cabin/<id>` 原样；
- 关掉/切走无 console error、无 RAF 泄漏（Performance 面板确认）。

**Wave 2 后**
- 编队行数据出现在 DOM（可通过临时 debug 面板或在 S3 前手工插桩验证一次）；
- 底栏能输入、流式、停止；关窗后仍能输入；舰桥 slot 拿到 telemetry（先用临时读数验证）。

**Wave 3 后**
- **点左栏任意一行，右边的面真的换**（跨舱也换）；`↑↓` 跟着换；
- 五页签都能打开且有内容；舰桥读数随聊天变化；点汐音能弹控制条且台词不进 chat；
- 模拟一条到达：简报出现、10s 消失、四边流光、编队行 pop。

**Wave 4 后**
- 从舱内点作业 → 全域落该条；返回回到舱内（桌面内进入回桌面）；
- 深链复制到新标签能还原同一屏；Esc 逐层顺序与 v12 一致；
- 所有 header 第一个可聚焦元素是关闭。

---

## 8. 对抗式评审处置（29 条）

| # | 结论 | 处置 |
|---|---|---|
| 1 状态无主 | critical | §2.1 `CockpitStateProvider` 为唯一可变状态，S1 先落死接口；编队轮询收进 S2 的单一 Provider |
| 2 路由不能过类型 | critical | §1.1 联合类型；S1 验收含 typecheck |
| 3 桌面内进入会被换壳 | critical | §1.4 origin 记录 + 返回原路径；S9 验收含「桌面内来回」 |
| 4 JobFace 绑入口舱 | critical | §3.4 全 props 化（`cabinId/cabinVersion/workspaceId/entryCabinId/onMutated`）；跨舱禁用对接投递 |
| 5 无 job_id 的 attention 被丢 | major | §1.5 / §3.2 三型行 + `CockpitAttentionFace`；计数按 attention 计 |
| 6 `taskPct` 归属冲突 + N+1 | major | 挪到 `components/cabin/job-progress.ts` 由 S2 拥有；S9 只改 import；富化上限 12 + 30s 缓存 |
| 7 `?job` 表达不了合成 task 行 | major | URL 扩 `?task / ?attn` |
| 8 旧作业详情窗失去入口 | major | **不发生**（2026-11-14 修正）：classic 行点击保持原行为；全域只走独立按钮 |
| 9 流式中 send 静默失败 | major | 不再另写 send：真 composer 搬到全域（§2.4） |
| 10 藏 composer 丢停止 | major | 同上，停止/Esc 停止原封不动 |
| 11 附件/斜杠/提及丢失 | major | 同上，全部保留 |
| 12 舰桥依赖可关闭的 ChatPane | major | ChatPane 全程挂载，浮窗只隐藏 transcript |
| 13 token 流式不变 | major | §2.4 明确回合粒度 + UI 文案 |
| 14 运行窗被夹在浮窗里 | major | `layerRoot` 指向 arena（S5）；保留 `open-run-window` 事件路径，不内嵌第二份 `RunWindow` |
| 15 头部字段不存在 | major | §1.5 派生表 + 空值省略 |
| 16 头部动作不是 API | major | 主操作改为「去处理 →」切页签；其余按 kind 用现有 API |
| 17 CSS 并行冲突 | major | §2.2 一 Step 一 css 文件，S1 写全 import |
| 18 占位槽逼后步改壳 | major | S1 建真实空壳并一次性 import |
| 19 E2E 不可执行 | major | §3.10 播种 helper + 只跑新增 spec + 明确整套历史红 |
| 20 无载入/404/草稿/无会话态 | major | S1 task 9 + S5 禁用态 |
| 21 数字写错 | minor | §0.1/§0.3 已按代码与原型更正（148px、≤1320、230 尘埃、10 个 mood） |
| 22 简报自相矛盾 | minor | 统一为「无任何按钮 + 10s + Esc」 |
| 23 Esc 顺序 | minor | §1.4 按 v12 顺序 + 唯一 capture 栈 |
| 24 S7/S8 依赖错 | minor | S7 只依赖 S1；S7↔S8 的台词联动放在 S8 task 4 用 `fx.say` 解耦 |
| 25 验证命令不实 | minor | 全部改成真实文件/命令（`CabinModulesP3` 等）；不要求覆盖率工具 |
| 26 模型是进程级 | minor | §2.4 文档化 + popover 标「全局」 |
| 27 HUD「分身」无来源 | minor | §1.5：取 `/api/agent/sessions/running`，拿不到就隐藏 |
| 28 重复几何工具 | minor | 复用 `lib/window-geometry.ts` 的 `Rect/Size` 与夹回语义；**最小尺寸不复用**（桌面窗 480×320，聊天浮窗要能缩到 320×240），在 `chat/geometry.ts` 里单独定 |
| 29 `?preview=1` 无实现 | minor | 改为「无导航入口 + 仅 S1 期间手工访问」，S10 清理 demo |

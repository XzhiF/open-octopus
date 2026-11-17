# 等你答 · 一题一窗 —— 实现计划（对齐 cockpit-v15 / classic-v5）

> 状态：**已实装（2026-11-16）** —— 实装记录见 §11
> 原型：`docs/cabin-design/cockpit-v15.html`、`docs/cabin-design/classic-v5.html`
> 关联：design 23（chat 闭环）、design 24（决策信封）、design 25（指挥台 / 决策票据）

---

## 0. 一句话

把「需要你回答的提问」从「先开作业面/任务对话，再找到那张卡」变成：
**左边（cockpit）或编队面板（classic）点一行 → 就地弹一扇属于这条提问的问答窗 → 窗里直接答 → 原地变回执、列表消项。**

窗是**固定落点**的（不按被点行的 y 定位、不随行缩高度），可多开、可拖、可手动关；关闭灯组在左。

---

## 1. 目标 / 非目标

### 目标

1. 全舱（cockpit）与 classic 两个模式，都能从「等你答」列表一键弹出对应提问的问答 chat。
2. 窗内完成「看上下文 → 选/填 → 提交」，不需要依赖主 chat 里那张卡。
3. 答案只提交一次：与主 chat 的作者提问卡共享同一套 `askId` 票据与决策账本。
4. 答完立即在 UI 上消项（乐观），服务端派生为事实源；窗口保留回执，不自动关。
5. 多开、拖动、层级、Esc、窄屏都定义清楚；与主 chat / 作业面 / 模块窗不互相打架。

### 非目标（v1 不做）

- 工作流 `pending_interaction` 执行类提问（`origin=workflow`）的作答 UI：它们没有 `askId` 决策票据，继续走现有执行交互入口。
- 在窗里直接和作者（doer）自由对话：窗是「回答这一题」，不是第二套 chat。
- 窗的位置/大小持久化（重启后不恢复），只保留本次会话内。
- 移动端专门布局（窄屏只做「收起编队/抽屉」兜底）。

---

## 2. 现状与已落地的服务端修复

### 2.1 提问的数据事实源

- 作者（任务作者 / 委派 doer）在会话里 `AskUserQuestion` 时，server 会把同一组问题镜像成一张
  `displayType:'event'` 的卡片到**舱主对话**：`activity.payload.authorAsk = true`，
  并带 `askMessageId`（作者线程原卡 id）与 `authorSessionId`。
- 服务端 `gatherAsks`（`packages/server/src/services/cabin/cabin-service.ts`）把未答提问派生为
  attention：`id = ask-<askId>`、`deep_link = ask:<askId>`、`stage = answer`、`awaiting = person`。
- 作答的唯一权威是决策账本 `cabin_job_events(kind='decision')` 的 `askId`；
  提交接口 `POST /api/cabins/:cabinId/decisions`，客户端 `submitCabinDecision`。

### 2.2 本次会话已修（前置依赖，已完成）

| # | 问题 | 修复 | 测试 |
|---|---|---|---|
| S1 | 同一个任务答过好几轮，提问仍在「需要你」里一轮轮累积 | `gatherAsks` 先收集「已答」：决策账本 + 镜像卡 `activity.decision` + 回执 `askReceiptFor`；再逐条投卡，`askId` 去重 | `cabin-p4.test.ts`（决策账本已答 → 作者线程原卡跨会话消项） |
| S2 | 在 cockpit 作答后，作者线程原卡不变、chat 里仍然挂着 | `submitDecision` 同步把 `activity.decision` 写回 `payload.askMessageId` 指向的作者线程原卡 | `cabin-decision.test.ts`（作答同步写回作者线程原卡） |
| S3 | 初始化门禁文案与实际不符 | 「准备 ORG 仓库」/「主线同步 / 项目登记」文案与复用/新克隆计数 | `cabin-init-service.test.ts` |

> 这三条是「一问只出现一次、答完两处都变回执」的地基。**实现本文的窗前必须已合并。**

---

## 3. 交互规格（两模式共用）

### 3.1 入口

| 模式 | 提问行在哪 | 显示 |
|---|---|---|
| 全舱 cockpit | 左侧 300px 编队栏顶部新增分组「等你答 N」 | `handle · 作业名`，第二行问题；右侧「回答」 |
| classic | 右侧编队面板（`.ck-fleet`）顶部新增分组「等你答 N」 | 同样一行一条；面板里排在「编队」作业行之前 |

- **一条提问一行**。同一任务的多轮提问不合并；答掉一轮，下一轮以新行出现。
- 列表只来自 `view.attention` 里 `stage === 'answer'` 且 `deep_link` 以 `ask:` 开头、且有决策票据
  （`ask.ask_id`）的项。工作流执行提问不出现在这个组（见 §2、§9）。
- 行点击：
  1. 打开/前置这个 `askId` 的问答窗（定位见 §3.3）；
  2. **不**切作业面、**不**切任务对话、**不**改主 chat 的选中会话；
  3. 不派发 `octopus:open-ask`（那条事件仍然留给 `AuthorAskInbox` 的「去对话里回答」）。

### 3.2 窗（chrome）

```
┌───────────────────────────────────────────────┐
│ ✕  Q1  接入支付宝渠道   等你定    feat-…      │  ← 46px 标题栏，整条可拖
├───────────────────────────────────────────────┤
│ 汐音 · 接入支付宝渠道 在等你定一件事 …         │  ← 上下文一行
│  汐音   [气泡：为什么来问]                     │
│  doer   [气泡：已知事实]                       │  ← 真实实现：信封 + 可选最近消息
│ ┌ 要定的事 ─────────────────────────────────┐ │
│ │ 问题                                       │ │
│ │ ○ 选项 A  ·  影响                          │ │
│ │ ○ 选项 B  ·  影响                          │ │
│ │ 建议：…                                    │ │
│ │ [其他 / 补充…]                  [发送答案] │ │
│ └───────────────────────────────────────────┘ │
│ [关闭]                                         │
└───────────────────────────────────────────────┘
```

- **关闭灯组在左**（和真实现 `.ck12-comms-lights` / classic 弹层一致）：`✕` 是标题栏第一个可点元素，hover 变红。
- 标题：`handle` 徽章 + 作业名 + 状态胶囊（`等你定` / `已答`）+ 右侧上下文字符串（仓库/工作树/阶段）。
- 底部左侧一个「关闭」；**不放「去作业面看过程」按钮**（用户明确不要）。
- 窗可拖（标题栏），不可缩放（v1）。拖过之后不自动回位。
- 已答：标题胶囊变绿「已答」，问题卡隐藏，追加「你 → 选择」气泡与回执条；
  回执文案：`✓ 已答 · <choice> —— 已从编队消项，窗口可手动关闭`。窗**不自动关**。

### 3.3 位置与尺寸（固定落点，关键）

> 用户口径：**不需要和点击行的 y 对齐；固定位置即可。否则后面的窗会越来越小。**
> 因此取消「窗顶 = 行顶」「按剩余高度缩窗」两种逻辑。

**全舱 cockpit**

| 项 | 值 |
|---|---|
| 宽度 | `min(560px, calc(100vw - 24px))`；视口 ≤1480 时 460px |
| 高度 | `min(76vh, 680px)`，固定，永不按行缩 |
| x | `编队栏右边缘 + 10 + 32 × 已开窗数`，夹在 `[8, innerWidth - 宽 - 8]` |
| y | 固定 `74px` |

**classic**

| 项 | 值 |
|---|---|
| 宽度 | 520px（`max-width: calc(100vw - 24px)`） |
| 高度 | 内容高，`max-height: min(72vh, 640px)` |
| x | `编队面板左边缘 − 窗宽 − 10 − 32 × 已开窗数`（**开在编队左侧**），夹在 `[8, innerWidth - 宽 - 8]` |
| y | 固定 `56px` |

- 多开只做 **x 方向错开 32px**，y 不变；3 扇以上自然叠放（用户可拖开）。
- 编队面板在 <1321px 隐藏（classic）：此时窗口贴右：`x = innerWidth − 窗宽 − 24`，y 仍 56。
- cockpit 编队 ≤1120 变抽屉：抽屉打开时按抽屉右缘算 x；关闭时 x 取 10。
- resize 只夹 x，不改 y、不改高。

### 3.4 多窗 / 层级

- 每个 `askId` 至多一扇窗；再点同一行 = 把这扇窗置顶并闪一下边框（不新建）。
- **共享 z 栈**：主 chat、问答窗、模块窗共用一个递增计数器（见 §5.3）。
  - 最后点击/打开的在前；点窗内任意处置顶；
  - 主 chat 从任一入口（点立绘 / 点气泡 / 点输入区 / ⌘K / `octopus:open-task` / `octopus:cabin-main-chat`）
    打开时都要置顶，保证「点助理一定看得见 chat」。
- 深链：cockpit `?attn=ask:<askId>` 直接开该提问窗（若已答则开回执态；若不存在 toast 后忽略）。

### 3.5 作答

1. 选项点击 = 选中（单选；`其他/其它/自定义` 输入型选项按 `AskUserQuestionCard` 规则处理）。
2. 「发送答案」：
   - `choice` = 选中项或自由文本；
   - 选项命中时 `source:'card'`，否则 `source:'composer'`；
   - 请求体：`{ askId, choice, note?, source, focusAtSubmit: askId, taskId? }`；
   - `taskId` 只在 `subject.kind === 'task'` 时带（与现有卡一致）。
3. 成功：
   - 窗即刻置灰 → 回执；按钮禁用；事件 `octopus:author-ask-answered`（兼容 `AuthorAskInbox` 本地消项）；
   - **乐观消项**：Provider 记录 `answeredAskIds`，编队行立刻消失，即使下一次 attention 刷新还没到；
   - toast：`已记下，汐音正在转达` / 幂等命中时 `已经答过（…）`。
4. 失败：
   - `400`（选项不匹配）：窗内红字提示，不消项；
   - `409`（已答/归属冲突）：按「已经答过」处理，显示回执并消项；
   - `404/503`（旧服务端/不可达）：窗内显示「去任务线程回答 →」（复用现有卡的回退语义），不偷偷转发；
   - 网络错误：可重试，保持选中。
5. 主 chat 里的同一张卡：服务端写回原卡（§2.2 S2），SSE 刷新后变只读回执；
   `octopus:author-ask-answered` 让 `AuthorAskInbox` 立即移除该条。

### 3.6 与主 chat 的关系（模式切换后要改的原有交互）

| 原行为 | 新行为 |
|---|---|
| 点编队里 attention 行 → 选中该 attention / 切作业面 / 再点任务对话才能答 | 点「等你答」行 → **直接开问答窗**；作业面不切 |
| 主 chat 的 `AuthorAskInbox`「去对话里回答」→ `octopus:open-ask` → 开主 chat 并滚到卡 | **保留**：这是「在 chat 里答」的入口；与窗并存，同一票据、同一账本 |
| cockpit 底部 ticker（汐音一行回执，点击开主 chat） | **整条移除**（原型 v15）；主 chat 入口改为：点立绘 / 点气泡 / 点底栏输入区 / ⌘K。HUD / 舰桥等读数不动 |
| 点汐音立绘 = 台词 + 星屑 + 点击环 + `feedbackFx(lite)` + 四边流光 + 开主 chat | **不变**（2026-11-16 原型一度删过特效，现按用户要求恢复）；只保留一处不可见优化：面板入场动画不再做 `filter: blur(4px)` |
| classic 概览「需要你」里 `stage=answer` 的行 → `octopus:open-task` | 该行改为开问答窗（`ask:` deep link）；其它 stage（验收/审批/finding/blocked）行为不变 |
| classic 编队作业行点击 → 作业详情 | **不变**；仅新增的「等你答」行开窗 |
| `↑↓` 在编队行间移动、Enter 打开 | 保持；Enter 落在「等你答」行时开窗（cockpit） |

### 3.7 键盘 / 可访问性

- 窗：`role="dialog" aria-modal="false"`，`aria-labelledby` 指向标题；打开时焦点进窗（问题卡的首个选项或窗容器）。
- `Esc` 关最上面一扇问答窗（cockpit 注册到现有 layer stack，优先级高于编队抽屉 70、低于浮层/模态；
  classic 用捕获阶段的 keydown，尊重 `event.defaultPrevented`）。
- 选项键盘 `1/2/3` + `↵` 提交：复用 `AskUserQuestionCard` 的 `hotkeyId`（Phase 3，先留接口）。
- 关闭后焦点回到触发它的行。

### 3.8 状态同步与边界

- attention 每 30s 轮询 + SSE；窗列表是 **attention 的派生 + 本地已开集合**：
  - 别处答掉 → attention 项消失；已开窗保留，显示「已在别处答过」回执；
  - 作者结束/任务归档 → 窗保持回执，不再可答；
  - 新提问边答边来 → 新行出现，已开窗不受影响；
  - 切换舱（`cabinId` 变化）→ 关闭全部窗，清空乐观集合。
- 断线/刷新：窗不持久化；重新点行即可重开；已答的因 attention 已消失不会重开。

---

## 4. 数据与 API

### 4.1 attention 增加可选信封（服务端 → 前端一次带回）

```ts
// packages/shared/src/types/cabin.ts —— CabinAttentionItemSchema 追加可选字段
ask?: {
  ask_id: string                 // 决策票据（= payload.askMessageId）
  message_id?: string            // 舱主会话镜像卡的 message.id（回执锚点）
  author_session_id?: string     // 作者线程
  origin?: 'session' | 'delegation' | 'workflow'
  decision?: string              // 信封：要定的事
  intent?: string
  options?: { label: string; impact?: string; description?: string }[]  // 最多 12 条
  recommendation?: { label?: string; reason?: string }
  blocking?: boolean
  phase?: { index?: number; round?: number } | null
  questions?: unknown            // AskUserQuestion 原对象（直接喂现有卡组件）
}
```

- 提取位置：`cabin-service.gatherAsks` 在扫描消息时顺手解出（优先镜像卡 `activity.payload`，
  次选作者线程原卡 `displayType:'ask_user_question'` 的 `questions`，最后执行 `interaction_messages`）。
- 约束：不带整段 transcript；字符串截断（标题 ≤ 120、decision ≤ 200、选项 label ≤ 80）；
  `origin='workflow'` 的项**不带 `ask_id`**，不进「等你答」组。
- 兼容：字段可选，旧客户端忽略；新客户端遇到没有 `ask` 的 `answer` 项走旧路径（`octopus:open-task`）。
- 体量：一次 attention 通常 < 10 条，每条 < 1.5KB；不需要单独请求。

### 4.2 兜底接口（Phase 2，可延后）

`GET /api/cabins/:cabinId/asks/:askId` → `{ ask: AskEnvelope }`：
- 用于深链 `?attn=ask:<askId>`、老数据 attention 无信封、或多端版本不一致；
- 404 = 提问不存在/已删。

### 4.3 提交（沿用现有，不改协议）

```
POST /api/cabins/:cabinId/decisions
{ askId, choice, note?, source: 'card'|'composer', focusAtSubmit: askId, taskId? }
→ { record, receipt, already }
```

- 服务端：账本幂等 → 镜像卡只读 → 写回作者线程原卡 → 汐音转达（20s watchdog 兜底）。
- 前端：`submitCabinDecision`（`lib/cabin-api.ts`）已实现；本文只做 **复用** 与状态展示。

---

## 5. 前端实现设计

### 5.1 目录与模块

新增（两模式共享）：

```
packages/web-app/components/cabin/asks/
  ask-window-model.ts      // 纯函数：从 attention 取提问、去重、排序、落点计算
  ask-windows-provider.tsx // 窗集合状态（open/close/focus/answered 乐观集合）
  ask-window.tsx           // 单扇窗（chrome + 内容 + 交互）
  ask-window-layer.tsx     // portal 到 body、拖拽、resize 夹取、Esc
  ask-submit.ts            // 从 AuthorAskCard 抽出的提交 hook（含回退/幂等/回执）
  ask-window.css           // 仅动画与少量阴影；其余走 Tailwind / 现有 token
```

复用：

- `AskUserQuestionCard`（问题/选项/其他/多选/键盘 hotkey）——窗内用它，保证和 chat 里完全同语义。
- `submitCabinDecision` + `CabinDecisionError`。
- `CabinAttentionItem` 的新 `ask` 信封。

### 5.2 核心数据流

```
CabinProvider.view.attention
  └─ pendingAsks(attention, answeredIds)          // 过滤 stage=answer + ask 信封
       ├─ CockpitFleetRail「等你答」组 / CabinFleet「等你答」组
       └─ AskWindowsProvider.open(askId)
             └─ AskWindow（快照 + 实时状态）
                   └─ ask-submit → decisions API → 账本 → SSE 刷新
```

- 窗打开时**快照**该信封（防止 attention 刷新时输入被清空）；回执/错误是窗本地状态。
- `answeredIds` 是 Provider 内的乐观集合；收到新 attention 时与服务端事实合并（服务端已答的永不复活）。

### 5.3 z 序

新增 `packages/web-app/components/cabin/z-order.ts`：

```ts
let z = 100
export const nextZ = () => ++z
```

- 主 chat 打开/聚焦：`element.style.zIndex = nextZ()`；
- 问答窗打开/pointerdown：同样；
- 模块窗沿用现有层级（原型里 60/65），不参与这条栈（避免全站层级重构）；
- 这样「点立绘看 chat」永远压得住问答窗，反过来点问答窗也能盖住 chat（与原型一致）。

> 原型 v15 的实测：`chatZ=123 > askZ=122`（点立绘后 chat 在上）；点窗后窗在上。

### 5.4 落点计算（纯函数，可测）

```ts
export const COCKPIT_WIN = { w: 560, wNarrow: 460, narrowAt: 1480, top: 74, stagger: 32 }
export const CLASSIC_WIN = { w: 520, top: 56, stagger: 32, fleetHiddenAt: 1321 }

export function askRect(mode: 'cockpit' | 'classic', env: {
  railRight?: number; fleetLeft?: number; openCount: number; viewport: { w: number; h: number }
}): { left: number; top: number; width: number }
```

- cockpit：`left = railRight + 10 + stagger*n`；
- classic：`left = fleetLeft - w - 10 - stagger*n`；fleet 隐藏时 `left = viewport.w - w - 24`；
- **不含任何行 y**，也不返回 height（高度由 CSS 决定）。

### 5.5 组件职责

| 组件 | 职责 |
|---|---|
| `AskWindowsProvider` | 打开集合、z、answered 乐观集合、`open(askId, opts)` / `close` / `closeAll` / `bump`；随 `cabinId` 重挂 |
| `AskWindowLayer` | 读集合渲染多扇窗；标题栏拖拽；resize 夹 x；Esc 关闭最上层 |
| `AskWindow` | 标题栏（左 ✕）、上下文、问题卡（`AskUserQuestionCard`）、发送、回执、错误与重试 |
| `useAskSubmit` | 提交决策（含 409 幂等、400 展示、404/503 回退提示）、事件与 toast |
| rail/fleet 组 | 只负责渲染行和 `open(askId)`，不持答案状态 |

### 5.6 与现有入口的接线

- `CockpitFleetRail`：
  - `pendingAsks` 行插在列表最前，组标题「等你答」；
  - `activate()` 对 ask 行改为 `askWindows.open(...)`；
  - 从 `need` 分桶渲染中排除 ask 行，避免同一条出现两次；
  - 行样式 `.ck12-rail-row` + `data-stage="answer"`，右侧「回答」胶囊；
  - `↑↓` 包含新行（保持现有遍历），Enter 打开窗。
- `CabinFleet`（classic）：
  - 顶部渲染「等你答」组（行样式 `ck-frow` + `data-tone="wait"`）；
  - `rows.length === 0` 但有提问时仍然渲染面板；
  - 作业行点击逻辑不变。
- `CabinOverview`：`deep_link.startsWith('ask:')` → 开窗；其余保持。
- `CockpitTicker`：从 `CockpitShell`/`CockpitChatHost` 移除；清理相关 CSS 与 `showTick` 状态；
  主 chat 入口保持（立绘 / 气泡 / 输入区 / ⌘K）。
- `AuthorAskInbox` / `AuthorAskCard`：保留；把提交逻辑抽到 `ask-submit.ts`，两处共用。
- `cockpit-url.ts`：`?attn=ask:<askId>` 解析 → 打开对应窗（可选，Phase 2）。

---

## 6. 原型的修改逐项对齐（验收清单）

> 每一条都是「原型里这样 → 真实现必须这样」。括号内是原型的实测值/脚本。

### 6.1 cockpit-v15

| # | 原型行为 | 真实现落点 |
|---|---|---|
| C1 | 编队顶部「等你答 N」，一条提问一行，不合并多轮 | `CockpitFleetRail` 新增组（§5.6） |
| C2 | 点行直接弹问答窗；**不**切面、不切会话 | `activate()` 分支；不调 `select()` |
| C3 | 窗口贴编队右侧：`x=编队右缘+10`，`y=74` 固定 | `askRect('cockpit')`；实测 `baseX=330, winTop=74` |
| C4 | 多开只向右错开 32px，y 不变 | `openCount*32`；实测第二扇 `left=362, top=74` |
| C5 | 关闭灯组在左（✕），hover 变红 | `AskWindow` header 首位 |
| C6 | 无「去作业面」按钮 | 不渲染 |
| C7 | 答完原地变回执、编队行立即消失、计数减一 | 乐观 `answeredIds` + 服务端账本 |
| C8 | 窗可拖、可手动关、答完不自动关 | `AskWindowLayer` |
| C9 | 主 chat 从立绘/气泡/输入区打开时压在问答窗之上 | 共享 `nextZ()`；实测 `chat 123 > ask 122` |
| C10 | 底部回执行整条移除 | 删除 `CockpitTicker` 及引用 |
| C11 | 点立绘：星屑 + 点击环 + 台词 + 跃迁反馈 + 四边流光 + 开 chat | 保持现状（2026-11-16 已恢复） |
| C12 | 无大面积 backdrop-filter / 星云 blur / 30fps 星流 | 已落到 `app/cockpit/*.css` 与 `CockpitStarfield.tsx`（本次会话前序） |

### 6.2 classic-v5

| # | 原型行为 | 真实现落点 |
|---|---|---|
| K1 | 「等你答」组在**右侧编队面板**顶部，不在左侧栏 | `CabinFleet` |
| K2 | 点行在**编队左侧**开窗：`x=编队左缘−窗宽−10`，`y=56` 固定 | `askRect('classic')`；实测 `fleetLeft=1510, winRight=1500, top=56` |
| K3 | 多开只向**左**错开 32px | `openCount*32`；实测第二扇 `left=948` |
| K4 | 作业行点击仍开作业详情 | 不改 `openJobDetail` 分支 |
| K5 | 窗内作答 → 回执 + 编队消项（3→2） | 同 C7 |
| K6 | 关闭灯组在左 + 底部「关闭」 | 同 C5 |
| K7 | 验收：开窗/多开/关闭重开/作答消项 | 见 §8 测试 |

> 原型的演示数据 `q-channel` 与「需要你」里的 `a2` 是同一件事，所以原型把 a2 从 attention 里删了。
> **真实现不要删**：attention 是唯一事实源，编队「等你答」组只是它的过滤视图；
> 概览「需要你」里的同一行点开也是同一扇窗（或 Phase 2 统一入口），计数保持一致。

---

## 7. 文件级改动清单

### 7.1 服务端

| 文件 | 改动 |
|---|---|
| `packages/shared/src/types/cabin.ts` | `CabinAttentionItemSchema` 增加可选 `ask` 信封（§4.1） |
| `packages/server/src/services/cabin/derive-cabin-view.ts` | `DeriveAskInput` 增加 `ask` 信封字段；`push` attention 时透传 |
| `packages/server/src/services/cabin/cabin-service.ts` | `gatherAsks` 提取信封：镜像卡 payload → 原卡 questions → interaction_messages；截断；`origin=workflow` 不带票据 |
| `packages/server/src/services/cabin/__tests__/cabin-p4.test.ts` | 断言 attention 带 `ask.options/recommendation/author_session_id` |
| `packages/server/src/services/cabin/__tests__/derive-cabin-view.test.ts` | `ask` 透传 / workflow 无票据 |
| （已做）`cabin-decision-service.ts` | 决策写回作者线程原卡（S2） |
| （已做）`cabin-service.ts` | `answeredAskIds` + 跨会话 askId 去重（S1） |

### 7.2 前端

| 文件 | 改动 |
|---|---|
| `components/cabin/asks/ask-window-model.ts` | 新增：过滤/去重/排序/落点纯函数 |
| `components/cabin/asks/ask-windows-provider.tsx` | 新增：窗集合、z、乐观已答、随舱重挂 |
| `components/cabin/asks/ask-window.tsx` | 新增：窗 chrome + `AskUserQuestionCard` + 回执 |
| `components/cabin/asks/ask-window-layer.tsx` | 新增：portal、拖拽、Esc、resize |
| `components/cabin/asks/ask-submit.ts` | 新增：从 `AuthorAskCard` 抽出的提交 hook |
| `components/cabin/asks/ask-window.css` | 新增：入场动画、阴影（不使用 backdrop-filter） |
| `components/cabin/z-order.ts` | 新增：共享 z 计数 |
| `components/cockpit/rail/CockpitFleetRail.tsx` | 「等你答」组 + ask 行分支 + 排除重复 |
| `components/cockpit/rail/rail.css`（或 `app/cockpit/rail.css`） | 组/行/徽标样式 |
| `components/cockpit/shell/CockpitShell.tsx` | 挂 `AskWindowsProvider` + `AskWindowLayer` |
| `components/cabin/CabinChatHost.tsx` | classic 挂 Provider/Layer（与 cockpit 共用） |
| `components/cabin/CabinFleet.tsx` | 「等你答」组；只有提问时也渲染 |
| `components/cabin/CabinOverview.tsx` | `ask:` deep link → 开窗 |
| `components/cockpit/shell/CockpitTicker.tsx` + 引用 | 删除整条回执行；清理 `showTick`/CSS/事件 |
| `components/cockpit/chat/CockpitChatWindow.tsx` | 打开/聚焦时 `nextZ()` |
| `components/cockpit/chat/CockpitChatHost.tsx` | 主 chat 打开入口统一 bump |
| `components/agent/chat/author-ask-card.tsx` | 提交逻辑改为 `useAskSubmit`（行为不变） |
| `lib/cabin-api.ts` | （可选）`getCabinAsk`；现有 `submitCabinDecision` 不改 |
| `components/cockpit/entry/cockpit-url.ts` | （可选）`?attn=ask:` 开窗 |

### 7.3 测试

| 文件 | 覆盖 |
|---|---|
| `components/cabin/asks/__tests__/ask-window-model.test.ts` | 过滤（stage/ask_id/origin）、去重、落点公式（cockpit/classic/窄屏）、错开 32 |
| `components/cabin/asks/__tests__/ask-windows-provider.test.tsx` | 打开/关闭/置顶、换舱清空、乐观已答合并 |
| `components/cockpit/rail/__tests__/CockpitFleetRail.test.tsx` | 「等你答」组渲染、点击开窗、不进 need 重复、Enter |
| `components/cabin/__tests__/CabinV3.test.tsx` | classic 编队组、只有提问时渲染、作业行不受影响 |
| `components/cabin/__tests__/CabinOverview.test.tsx` | `ask:` 行开窗；其它 stage 不变 |
| `components/cockpit/shell/__tests__/cockpit-ticker.test.tsx` | 删除后不再挂载 / 无残留订阅 |

---

## 8. 测试与验收

### 8.1 自动化

1. **服务端**：`pnpm --filter @octopus/server test` —— 既有 S1/S2/S3 用例 + 新信封用例。
2. **web-app**：`pnpm test`（Vitest + RTL）—— §7.3 全部；`pnpm lint` 过 CI 闸。
3. **原型回归脚本**（已有的，作为交互基线）：
   - `tmp/v15-cdp.mjs`：cockpit 开窗/多开/关闭重开/作答消项/主 chat 层级；
   - `tmp/classic-v5-cdp.mjs`：classic 左侧落点/多开/作答消项/关闭重开。
   真实现用 RTL 复刻同样的断言，不跑浏览器脚本入 CI。

### 8.2 手工验收（两模式各一遍）

- [ ] 点「等你答」行 1 次 → 窗出现在固定位置；不动面、不切会话。
- [ ] 连开 3 扇 → 每次只错开 32px，y 不变，高度不变小。
- [ ] 关一扇再从行重开 → 仍在固定位置。
- [ ] 窗内选选项 → 发送 → 回执；编队行立即消失；主 chat 同卡变只读。
- [ ] 主 chat 里答掉 → 窗若开着显示已答回执；行消失。
- [ ] 点立绘 / 点输入区 → 主 chat 压在问答窗之上；再点问答窗 → 窗置顶。
- [ ] 拖动窗 → 位置保留；缩放浏览器 → x 被夹回视口。
- [ ] classic：编队隐藏（窄屏）时窗口贴右不越界。
- [ ] Esc 关最上层问答窗；不影响其它层。
- [ ] 答完的提问刷新后不再出现（同一任务多轮提问逐条出现、逐条消）。

---

## 9. 风险与决策记录

1. **工作流执行提问（pending_interaction）**：没有 `askId` 决策票据，提交会 404。
   v1 明确不为它开问答窗；`stage=answer` 但没有 `ask.ask_id` 的项继续走旧入口（开执行/任务）。
   后续若要统一，需要给执行提问补一条决策票据（单独设计）。
2. **attention 体量**：把 options/questions 带进 attention 会让 SSE 帧变大。约束见 §4.1；
   若后续发现过大，退回 §4.2 的按需接口（窗打开时 fetch 一次）。
3. **乐观消项**：服务端拒绝（400）时必须回滚行；Provider 中 `answeredIds` 只在成功/409 时写入。
4. **层级**：不改全站 z-index 体系，只给「主 chat + 问答窗」引入共享计数器；
   模块窗（60/65）保持在问答窗之下（窗 100+），符合「点开的问答窗浮在最上面」。
5. **ticker 移除**：需要同步清理 `CockpitTicker` 的订阅与样式；HUD 的统计与状态不动。
6. **原型 vs 真实现的去重**：原型删了 attention 里的重复项，真实现不删，只做视图过滤；
   避免计数与事实源分叉（见 §6.2 备注）。

---

## 10. 分阶段落地

| 阶段 | 内容 | 出口条件 |
|---|---|---|
| P0 | 服务端信封 + 类型 + 测试（S1/S2 已在） | server 测试全绿；attention 带 `ask` |
| P1 | `ask-window-model` + Provider + Layer + 提交 hook | 纯函数/RTL 测试绿；空壳窗可开合 |
| P2 | cockpit 接入：rail 组、开窗、z、移除 ticker | 手工验收 cockpit 一遍 |
| P3 | classic 接入：fleet 组、左侧落点、overview 路由 | 手工验收 classic 一遍 |
| P4 | 深链 / 键盘 hotkey / 文案与样式打磨 | lint + 全部测试；两原型行为对齐 |

回滚：P2/P3 各自独立开关（`askWindowsEnabled` 常量）；关掉即恢复旧的行 → 面/会话行为，
服务端信封为可选字段，不回滚也不影响旧客户端。

---

## 11. 实装记录（2026-11-16）

P0–P4 全部落地；与原计划的差异只列真正改变行为的部分。

| 阶段 | 落地 |
|---|---|
| P0 | `CabinAskEnvelopeSchema` + `CabinAttentionItem.ask`；`derive-cabin-view` 透传；`gatherAsks` 先收集信封（镜像卡 payload 优先、原卡 questions 兜底）再投 attention；`origin='workflow'` 不产信封。测试：`cabin-p4.test.ts`（信封字段 / 镜像卡优先 / 工作流无票据）、`derive-cabin-view.test.ts`（透传）。 |
| P1 | `components/cabin/asks/{ask-window-model,ask-windows-provider,ask-window,ask-window-layer,ask-submit}.ts(x)` + `ask-window.css`；`components/cabin/z-order.ts`。测试：`ask-window-model.test.ts`（落点公式 / 过滤 / 去重）、`ask-windows-provider.test.tsx`（乐观已答 / 别处答过 / 事件消项）、`ask-window.test.tsx`（chrome / 作答回执 / 404 回退 / 关闭）。 |
| P2 | `CockpitFleetRail` 顶部「等你答」组（点击开窗、不切面；`↑↓` 覆盖提问行、Enter 开窗；同一条不在 need 重复）；`CockpitShell` 挂 Provider + Layer（Esc priority 75）；主 chat 与问答窗共享 `nextZ()`（`octopus:chat-focus` 事件）；`CockpitTicker` 整条删除（组件 / CSS / 测试引用）。 |
| P3 | `CabinFleet` 顶部「等你答」组（编队为空也渲染）；`CabinChatHost` 挂 Provider + Layer（classic Esc 捕获、尊重 `defaultPrevented`）；`CabinOverview` 的 `ask:` 行改为开窗。测试：`CabinV3.test.tsx`、`CabinOverview.test.tsx`。 |
| P4 | 深链 `?attn=ask:<askId>` 在 attention 到齐后开窗（`CockpitAskDeepLink`）；窗内 `1/2/3` 选项 + `↵` 提交（复用 `octopus:ask-key`）；`AuthorAskCard` 的提交逻辑抽到 `useAskSubmit`（行为不变）。 |

实现口径（与原型的一致性）：

- cockpit `x = 编队右缘 + 10 + 32n`、`y = 74`、宽 560（≤1480 → 460）；classic `x = 编队左缘 − 宽 − 10 − 32n`、`y = 56`、宽 520；resize 只夹 x。
- 打开时快照信封；attention 刷新不清空窗内输入；提交成功行立即消项、窗保留回执。
- 别处答掉：窗标记 external 显示「已在别处答过」；`octopus:author-ask-answered` 让编队行即时消项。
- 工作流执行提问没有票据 → 服务端不产信封；前端不进入「等你答」组，继续走旧入口。

已知边界（与 §1 非目标一致）：窗位置不持久化；窄屏不做专门布局（classic 编队隐藏时窗贴右，cockpit 抽屉收起时 x 取 10）；窗不提供「去作业面」。

### 11.1 实机验证（2026-11-16，临时实例：web 3200 / server 3101 / DB 副本）

- cockpit：编队顶部「等你答 2」；第一扇 `left=330, top=74, width=560`（编队右缘 320 + 10）；
  第二扇 `left=362, top=74`（+32）；关闭一扇 2→1、从行重开 1→2。
- classic：右侧编队「等你答 2」；窗 `left=820, top=56, width=520`，右缘 1340 与编队左缘 1350 相距 10。
- 共享 z 栈：问答窗 102；点立绘 → 主 chat 105 在上；再点问答窗 → 106 在上。
- 作答闭环（DB 副本）：窗内选第一项 → 回执「✓ 已记下：… · 汐音正在转达…」，窗口保留、
  标题胶囊变「已答」；编队行 2→1、组标题变「等你答 1」；无错误。
- 关闭 / 重开 / Esc / 多开 / 别处答过 / 404 回退：RTL 覆盖（`asks/__tests__` 28 例）。
- 深链 `?attn=ask:<askId>`：进场即开对应窗（实测 openedId 命中）；`ask:` 不参与
  selection（attention 行 id 是 `ask-<askId>`），随后 url-sync 会按默认选中把地址
  归一成 `?job=…` —— 窗已开，不影响使用；再次分享请重新带 `?attn=ask:`。

### 11.2 改版（2026-11-16 当天）：主对话队列合并 + 窗内点击不闪

用户反馈两处体验问题，当天修：

1. **问答窗点击闪动**。根因：窗内每次 `pointerdown` 都调 `focus()`，而 `focus()` 同时递增
   `flashById`，0.7s 闪烁动画结束移除类名时又把基础入场动画 `ckAskIn` 重放一遍。
   现口径：`focus()` 只抬 z；`flash` 只属于「重复点编队行」。闪烁改为 `.ck-askwin::after`
   覆盖层动效（inset 光圈），不再改 section 的 `animation-name`，入场动画不会重播。
   回归：`ask-windows-provider.test.tsx`「窗内点击 focus 只置顶，不重播闪烁」。
2. **主对话顶部两条堆叠**（琥珀队列条 + 青色焦点条，内容重复、缝隙漏字、92px 高）。
   原型 `tmp/inbox-redesign.html` 方案 A（用户选定）：合并成一块实面板 —— 左侧 3px 琥珀脊线、
   `待你定 N` 计数胶囊、常驻行（handle / 作业 / 要定的事 / `◉ 回答中` / `1/2/3 · ↵`）；
   2 条以上才在下方挂列表，激活行内高亮（`inset 2px` 琥珀脊线），3 条以上仍折成
   「+N 条待处理」。移除 `decision-focus-bar`（焦点由常驻行 + 激活行表达）。

实机（dev 3000/3001）：单条时 dock 高度 92px → **37px**，无列表行、无旧焦点条、边框中性
`rgb(50,50,59)`；窗内连点 6 次 `is-flash` 始终 false、z 102 → 114；重复点编队行仍闪
（true → 900ms 后 false）。测试：`author-ask-inbox.test.tsx` 8 例、asks 套件 30 例全绿；
web-app `tsc` 在改动文件上无新增错误，eslint 干净。

### 11.3 补：答完之后「作者在推进」（2026-11-16）

问题：人答完决策后，答案经汐音 / watchdog 转达给任务的**主线程会话**，作者 agent
立刻开始干活；但编队行的 `status` 派生自任务生命周期（`deriveTaskView`），任务还是
`ready`（待执行），界面上看不出有人在跑。

口径：**生命周期与 chat 流分开表达**，不把 chat 回合冒充成任务开始执行（K3）。

- 服务端 `CabinService.listJobsView` 增加派生态 `agent_running`：
  `cabin_jobs.session_id`（= 任务主线程）是否在 `isStreamActive()` 里。不落库；
  `CabinInfra.isSessionStreaming` 可注入（测试 / 别的宿主）。
- classic 编队：`agent_running` 行排到最前（`data-tone=run`、绿点常亮），
  文案「作者在推进」，执行尚未开始时**不画 0% 进度条**。
- cockpit 编队：`groupOf` 把它归入「运行中」（attention / 终态仍优先），
  `statusLabel` 同样给「作者在推进」，`rowPct` 返回 null。
- 时序：`octopus:author-ask-answered` 事件后 1.2s 两个编队各补一拍刷新，
  不必干等 10s 轮询。

验证：临时 server（3101，DB 副本）`GET /jobs` 返回 `agent_running:false` 字段；
页面内对 `/jobs` 响应注入 `agent_running:true` 后，classic 行 `text=作者在推进 /
tone=run / 无进度条`，cockpit 行落在「运行中」组、`status=作者在推进 / pct=null`。
测试：`cabin-p4`（agent_running 派生 + 生命周期不变）、`fleet-model`（分组/文案）、
`CabinV3`（classic 行序/文案/无 0%）、cockpit rail / use-fleet-query 套件全绿。

### 11.4 修：旧提问永远挂着（2026-11-16）

现象：`汐音 · undefined · 舱主对话 在等你定一件事` 这类旧卡一直留在「等你答」，
既不能恢复也不能取消。

三个根因与改法：

1. **旧卡判据**：原生 `AskUserQuestion` 是 assistant 行；舱初始化那张卡被用户用
   自由文本回复后，助理继续推进，但这行既没走决策账本，也不含
   「用户回答了以下问题」标记，于是被永远派生为待答。
   现口径：同一会话里 **该 assistant 提问行之后又出现 assistant 消息** → 视为
   旧账，不再进 attention。mirror 卡是 user 行，不受这条影响（真正的待答仍会列出）。
2. **标题兜底**：v5 建舱时舱名还没起，主会话标题落成 `undefined · 舱主对话`。
   - 建舱落标题改用已归一的 `name`（未填名 → `未命名舱`）；
   - 展示层 `sessionLabel` 去掉 `undefined ·` 占位前缀；
   - 初始化起名后同步主会话标题（只改 `undefined/未命名舱` 开头的占位标题，
     不覆盖用户自己改过的会话名）。
3. **忽略出口**：新增 `POST /api/cabins/:id/asks/:askId/dismiss` →
   `CabinService.dismissAsk` 把 `activity.decision = { id:'dismissed' }` 写回该
   askId 的所有消息行（主会话 mirror + 作者线程原卡），派生 attention 与决策队列
   随即消项。**不转达、不写决策账本**（忽略没有答案）。工作流
   `pending_interaction` 没有会话消息行 → 返回 `dismissed: 0`，窗内提示去工作流侧处理。
   问答窗底部新增「忽略这条」（答完后隐藏）；成功 → 行消项 + 关窗。

验证（dev DB 副本 + 临时 server 3101）：修复后 attention 只剩任务线程那张真待答
（b617ebea），旧的 `undefined · 舱主对话` 自动消失；`POST .../asks/b617ebea.../dismiss`
返回 `{"dismissed":2}`（mirror + 原卡），再读 attention 为空。
测试：`cabin-p4` 21 例（旧卡判据 / dismiss / 标题兜底）、`ask-window` 8 例
（忽略成功 / dismissed:0）、inbox / CabinV3 / asks 套件全绿；tsc、eslint 干净。

### 11.5 再改：待你定 dock 移到输入区（方案 B，2026-11-16）

用户反馈 11.2 的合并 dock 仍然突兀（classic / 全舱都是）。原型
`tmp/ask-dock-redesign-v2.html` 对比了 A 静音行 / B 输入框挂件 / C 右上药丸 /
D 窗头徽章，用户选 **B**。

实现：

- `ChatArea` 新增 `composerDock` 槽：TUI dock 里渲染在 composer 之上（非 TUI
  composer 同样位置）；cockpit 的 composerSlot portal 把整块带到 54px 底栏，
  挂件随之进入 `.ck12-cmd-slot`。旧的 `transcriptHeader` 槽删除（无其它调用方）。
- `AuthorAskInbox` 从「顶部粘性面板」改为「贴 composer 的一行」：
  `● 待你定 N · #handle · 任务 · 要定的事 · 1/2/3 ↵ · 回答 →`；
  多条时右侧出现 `N 条 ⌃`，列表**向上展开**（最多 3 条，其余 +N 条待处理），
  激活行内高亮；键盘 1/2/3 + ↵ 语义不变。
- cockpit CSS 覆盖 `.ck12-cmd-slot [data-testid="author-ask-inbox"]`：去边框 /
  背景 / 圆角，只留一行；底栏高度自然从 54 → 61px。

实测（dev 3000，HMR）：classic 挂件 32px，`gap = -1`（与 composer 上沿贴合）；
cockpit 挂件在 `ck12-cmd-slot` 内、29px，边框 0 / 背景透明，底栏 61px。
测试：chat + cockpit-chat 52 文件 248 例全绿，tsc / eslint 干净。

**对齐修正（同日）：** 初次实装把挂件放在 `max-w-4xl` 外层，classic 舱的 composer
列被 `cabin-cockpit.css` 收窄到 `min(756px, 100% - 144px)`（实测 712px），右边多出
144px。现把 `composerDock` 渲染进 `[data-tui-composer]` 内部，宽度自动继承列宽：
classic 挂件 712px（x=488，与 composer / 输入块逐像素对齐）；cockpit 挂件 1374px
（x=37，与 composer 同宽同起止）。`ChatArea` 两处（TUI / 非 TUI）同口径。

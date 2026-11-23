// 全域座舱状态契约（S1 落死，S2–S9 只读）。
//
// 唯一可变状态在 CockpitStateProvider；这里只放类型与纯派生。
// 设计约束（plans/cabin-cockpit-v12.md §2.1）：
//   · chat 未接上时恒为 null —— 舰桥/ticker 显示「未就绪」，绝不写 `--`；
//   · 浮窗几何/收起/锁定/透明度在 state，不在组件内部（ChatPane 全程挂载）；
//   · 特效只走 nonce 信号量，组件之间不互相 import；
//   · Esc 只有一个 capture 阶段监听（CockpitLayerStack），layer 栈按 priority + 注册序。

import type { LlmUsageAggregates } from '@octopus/shared'
import type { ContextUsageData } from '@/lib/agent/types'
import type { ComposerContext, ComposerEffort } from '@/lib/agent/composer-settings'
import type { MoodKey } from '@/components/cabin/cockpit'

/** 面上要显示哪一条：job / task / attention / project 四型。
 *  全域只含入口舱（2026-11-15），cabinId 恒 = 入口舱；保留字段是为了 ref 形状稳定。
 *  project 的 id = 项目 key（org:<org>/<name> | local:<path>），舱籍面用 __roster__。 */
export type CockpitRef =
  | { kind: 'job'; cabinId: string; id: string }
  | { kind: 'task'; cabinId: string; id: string }
  | { kind: 'attention'; cabinId: string; id: string }
  | { kind: 'project'; cabinId: string; id: string }

export type CockpitRefKind = CockpitRef['kind']

/** 座舱页签。v22 #5（2026-11-23 用户）：详情不再承载 chat —— 编队对话是独立
 *  chat 窗，详情首签改为「运行」。`dialog` / `overview` 仍留在类型里给旧深链
 *  兜底：它们不在 COCKPIT_TABS / isCockpitTab 里，`?tab=dialog` 会自然落回默认。 */
export type CockpitTab = 'dialog' | 'overview' | 'relay' | 'run' | 'changes' | 'accept' | 'files' | 'debug' | 'project'

/** 面来源（v22.3）：inbox = 从「要我处理」打开 → 详情让到浮层左侧；
 *  fleet / url / acceptance = 从编队 / 深链 / 验收流转打开 → 居中。 */
export type CockpitSelectSource = 'fleet' | 'inbox' | 'url' | 'acceptance'

/** 页签顺序 = 原型 .dtabs（v22 #5：首签「运行」，对话页签已删除）。 */
export const COCKPIT_TABS: readonly CockpitTab[] = ['relay', 'run', 'changes', 'accept', 'files', 'debug', 'project']

/** 详情默认页签：URL 里省略它，保持链接干净。 */
export const COCKPIT_DEFAULT_TAB: CockpitTab = 'run'

export const COCKPIT_TAB_LABELS: Record<CockpitTab, string> = {
  dialog: '对话',
  overview: '概览',
  relay: '对接',
  run: '运行',
  changes: '变更',
  accept: '验收',
  files: '文件',
  debug: '调试',
  project: '项目',
}

export function isCockpitTab(value: string | null | undefined): value is CockpitTab {
  return value != null && (COCKPIT_TABS as readonly string[]).includes(value)
}

export function cockpitRefKey(ref: CockpitRef): string {
  return `${ref.kind}:${ref.cabinId}:${ref.id}`
}

export function sameCockpitRef(a: CockpitRef | null, b: CockpitRef | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return a.kind === b.kind && a.cabinId === b.cabinId && a.id === b.id
}

/** S5 通过 ChatPane.onTelemetry 写进来的只读对话能力。 */
export interface CockpitChatApi {
  model: string
  effort: ComposerEffort
  contextWindow: ComposerContext
  streaming: boolean
  queueDepth: number
  /** 无主会话 → false（输入框禁用、发送无效）。 */
  canSend: boolean
  contextUsage: ContextUsageData | null
  usage: LlmUsageAggregates | null
  /** 走真正的 composer 管线（含队列 / steer / 流式保护）。 */
  submit(text: string): void
  stop(): void
  setModel(id: string): void
  setEffort(effort: ComposerEffort): void
  setContext(window: ComposerContext): void
}

export interface CockpitRect {
  x: number
  y: number
  w: number
  h: number
}

export interface CockpitChatWindowState {
  open: boolean
  mini: boolean
  pinned: boolean
  /** 0–1，写进浮窗的 --oa。 */
  alpha: number
  /** null = 还没量过，由 S5 按 arena 计算默认几何。 */
  rect: CockpitRect | null
  /** v20（design 29 §5）：整台收起成停靠 pill（比 mini 更彻底：DOM 隐藏）。 */
  docked: boolean
}

export type CockpitChatWindowPatch = Partial<CockpitChatWindowState>

export interface CockpitChatWindow extends CockpitChatWindowState {
  set(patch: CockpitChatWindowPatch): void
  /** 点输入框 / ⌘K：开窗并取消 mini。 */
  openWithFocus(): void
}

export interface CockpitSaid {
  nonce: number
  line: string
  mood?: MoodKey
}

/** 反馈背景特效强度（v13）：full = 背景层 + 内容之上层；lite = 只光晕 + 环；off = 只边缘。 */
export type CockpitFxLevel = 'full' | 'lite' | 'off'

/** 特效信号量：谁都能触发，S1 星野 / S8 光效各自订阅。 */
export interface CockpitFx {
  pulseNonce: number
  pulseColor: string
  edgeNonce: number
  edgeColor: string
  jumpNonce: number
  /** v13 反馈特效：背景扫描/网格 + 内容之上的光晕/环，绝不遮挡、不接收点击。 */
  feedbackNonce: number
  feedbackColor: string
  feedbackLevel: CockpitFxLevel
  pulse(color?: string): void
  edge(color?: string): void
  jump(): void
  feedback(color?: string, level?: CockpitFxLevel): void
  say(line: string, mood?: MoodKey): void
  lastSaid: CockpitSaid | null
}

export interface CockpitLayerApi {
  /** 返回注销函数；同一 id 重复注册以最后一次为准。 */
  register(id: string, priority: number, close: () => void): () => void
  /** 关掉栈顶（priority 大者优先，同 priority 后注册者优先）；栈空返回 false。 */
  closeTop(): boolean
}

// ── v20（design 29）：多作战线程 / 弹出窗 / 面板 / 回传 flash ─────────────

/** 模态面板六 kind（编队/详情沿用左栏与作业面，不另起模态）。 */
export type CockpitPanelKind = 'ops' | 'ledger' | 'ws' | 'poses' | 'debug' | 'log'

/** 用户自开的作战弹出窗（design 29 §4）：上限 5，最小化进 WINDOWS 条。 */
export interface CockpitPopWin {
  id: string
  threadKey: string
  rect: CockpitRect
  min: boolean
}

/** 本地回执（双模式同步的 sys 行）：只进 overlay，不写服务端转录。 */
export interface CockpitReceipt {
  id: number
  text: string
  at: number
}

/** 回传入场动画锚点：渲染侧按 Date.now()-at < 1400 命中行/卡。 */
export interface CockpitFlash {
  key: string | null
  at: number
  nonce: number
}

export interface CockpitThreadsApi {
  unread: Record<string, number>
  receipts: Record<string, CockpitReceipt[]>
  /** 只消未读（v22 #5：打开 / 聚焦编队 chat 窗时用）。 */
  clearUnread(key: string): void
  bumpUnread(key: string, n?: number): void
  pushReceipt(key: string, text: string): void
}

export interface CockpitWindowsApi {
  windows: CockpitPopWin[]
  /** 已存在同线程窗 → 聚焦不新建；超上限返回 false（调用方 toast）。 */
  openWindow(threadKey: string, rect: CockpitRect): boolean
  closeWindow(id: string): void
  setWindowMin(id: string, min: boolean): void
  patchWindowRect(id: string, rect: CockpitRect): void
}

export const COCKPIT_WIN_LIMIT = 5

export interface CockpitState {
  entryCabinId: string

  selection: CockpitRef | null
  tab: CockpitTab
  /** 面来源：决定详情落位（inbox 左侧 aside / 其余居中）。 */
  detailSource: CockpitSelectSource
  select(ref: CockpitRef | null, tab?: CockpitTab, source?: CockpitSelectSource): void
  setTab(tab: CockpitTab): void

  /** 左栏「只看这个项目」：只筛编队，不换面。null = 不筛。 */
  projectFilter: string | null
  setProjectFilter(next: string | null): void

  chat: CockpitChatApi | null
  reportChat(api: CockpitChatApi | null): void

  chatWindow: CockpitChatWindow

  railOpen: boolean
  setRailOpen(open: boolean): void

  /** v20：多作战线程 tab / 未读 / 本地同步回执。 */
  threads: CockpitThreadsApi

  /** v20：用户自开的弹出窗集合 + WINDOWS 条数据源。 */
  wins: CockpitWindowsApi

  /** v20：模态面板（ops / ledger / ws / poses / debug），null = 无。 */
  panel: CockpitPanelKind | null
  /** 面板入参（ws = 项目 name；其余 null）。 */
  panelArg: string | null
  openPanel(kind: CockpitPanelKind, arg?: string | null): void
  closePanel(): void

  /** v20：回传入场 flash（编队行 / 决断卡 arrived 动画锚点）。 */
  flash: CockpitFlash
  markArrival(key: string): void

  /** v21（design 31 §3.2）：右栏「要我处理」浮层状态。 */
  inboxOpen: boolean
  /** 回复卡当前那条 attention item id；null = 只看列表。 */
  inboxSel: string | null
  /** 打开浮层；带 id 时直接进那条的回复卡（banner / 回传点击）。 */
  openInbox(attentionId?: string | null): void
  closeInbox(): void
  selectInbox(attentionId: string | null): void

  /** v22 十四轮：右栏「活动」浮层（汐音主会话的子代理 + 后台作业，只读）。
   *  与 inbox 互斥；没有运行中的活动时按钮不出现。 */
  activityOpen: boolean
  /** 详情窗当前那条活动 id（`subagent:<id>` / `background:<id>`）；null = 只看列表。 */
  activitySel: string | null
  openActivity(): void
  closeActivity(): void
  selectActivity(activityId: string | null): void

  /** v20：汐音当前姿态（图鉴金边 / 验收锚点），由 CockpitCrew 上报。
   *  v22：clip = 当前视频片段下标（13 支；同一 pose 可能有多支）。 */
  pose: string
  clip: number
  reportPose(pose: string, clip?: number): void

  /** v20（design 29 §7.4）：随机跃迁开关（15–45s），默认开。 */
  autoWarp: boolean
  setAutoWarp(on: boolean): void

  /** v21（design 31 §3.4.7）：舱景（SCENES 12 幕）。sceneIndex = 当前幕下标。 */
  sceneIndex: number
  /** 直接点名某一幕（场景点）。 */
  setScene(index: number): void
  /** 跃迁：切下一幕 + 星流/闪光（⌥W、右栏「跃迁」、HUD 场景名共用）。 */
  travel(): void
  /** 自动轮换（v21 八轮）：切到**随机另一幕** + 星流/闪光（15–45s 随机计时）。 */
  travelRandom(): void

  fx: CockpitFx

  layer: CockpitLayerApi
}

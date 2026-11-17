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

export type CockpitTab = 'overview' | 'relay' | 'run' | 'changes' | 'accept' | 'files' | 'debug'

export const COCKPIT_TABS: readonly CockpitTab[] = ['overview', 'relay', 'run', 'changes', 'accept', 'files', 'debug']

export const COCKPIT_TAB_LABELS: Record<CockpitTab, string> = {
  overview: '概览',
  relay: '对接',
  run: '运行',
  changes: '变更',
  accept: '验收',
  files: '文件',
  debug: '调试',
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

/** 模态面板四 kind（编队/详情沿用左栏与作业面，不另起模态）。 */
export type CockpitPanelKind = 'ops' | 'ledger' | 'ws' | 'poses'

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
  activeThread: string
  closedTabs: string[]
  unread: Record<string, number>
  receipts: Record<string, CockpitReceipt[]>
  /** 切线程 + 消未读（tab 点击 / 回传立即激活 / 会话被别处切换）。 */
  activateThread(key: string): void
  closeTab(key: string): void
  reopenTab(key: string): void
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
  select(ref: CockpitRef | null, tab?: CockpitTab): void
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

  /** v20：模态面板（ops / ledger / ws / poses），null = 无。 */
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

  /** v20：汐音当前姿态（图鉴金边 / 验收锚点），由 CockpitCrew 上报。 */
  pose: string
  reportPose(pose: string): void

  /** v20（design 29 §7.4）：随机跃迁开关（45–105s），默认开。 */
  autoWarp: boolean
  setAutoWarp(on: boolean): void

  fx: CockpitFx

  layer: CockpitLayerApi
}

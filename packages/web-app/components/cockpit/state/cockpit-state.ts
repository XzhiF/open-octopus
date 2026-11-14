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

/** 面上要显示哪一条：job / task / attention 三型，cabinId 可 ≠ 入口舱（跨舱只读）。 */
export type CockpitRef =
  | { kind: 'job'; cabinId: string; id: string }
  | { kind: 'task'; cabinId: string; id: string }
  | { kind: 'attention'; cabinId: string; id: string }

export type CockpitRefKind = CockpitRef['kind']

export type CockpitTab = 'overview' | 'relay' | 'run' | 'changes' | 'accept'

export const COCKPIT_TABS: readonly CockpitTab[] = ['overview', 'relay', 'run', 'changes', 'accept']

export const COCKPIT_TAB_LABELS: Record<CockpitTab, string> = {
  overview: '概览',
  relay: '对接',
  run: '运行',
  changes: '变更',
  accept: '验收',
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

/** 特效信号量：谁都能触发，S1 星野 / S8 光效各自订阅。 */
export interface CockpitFx {
  pulseNonce: number
  pulseColor: string
  edgeNonce: number
  edgeColor: string
  jumpNonce: number
  pulse(color?: string): void
  edge(color?: string): void
  jump(): void
  say(line: string, mood?: MoodKey): void
  lastSaid: CockpitSaid | null
}

export interface CockpitLayerApi {
  /** 返回注销函数；同一 id 重复注册以最后一次为准。 */
  register(id: string, priority: number, close: () => void): () => void
  /** 关掉栈顶（priority 大者优先，同 priority 后注册者优先）；栈空返回 false。 */
  closeTop(): boolean
}

export interface CockpitState {
  entryCabinId: string

  selection: CockpitRef | null
  tab: CockpitTab
  select(ref: CockpitRef | null, tab?: CockpitTab): void
  setTab(tab: CockpitTab): void

  chat: CockpitChatApi | null
  reportChat(api: CockpitChatApi | null): void

  chatWindow: CockpitChatWindow

  railOpen: boolean
  setRailOpen(open: boolean): void

  fx: CockpitFx

  layer: CockpitLayerApi
}

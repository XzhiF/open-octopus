'use client'

// 对话分屏（2026-11-08）：只支持左右两栏，只叠一层。
//
// 分屏开关住在模块级 store 里（useSyncExternalStore），因为开关按钮在桌面顶栏
// （DesktopHeader），而对话本身在桌面层（ChatTab）——两者是兄弟节点，没法用
// React context 串起来。ratio / 焦点栏 / 两栏会话写进同一个 localStorage 记录，
// 刷新后分屏与焦点栏都还在。

import { useSyncExternalStore } from 'react'

export type ChatPaneId = 'left' | 'right'

export interface ChatSplitPrefs {
  /** 左栏宽度占比（0..1）。 */
  ratio: number
  /** 焦点栏：点击侧栏会话时优先进这一栏。 */
  focused: ChatPaneId
  left: string | null
  right: string | null
  /** 每栏打开的任务（会话之外还要恢复任务 chrome：作业坞、验收…）。 */
  leftTask: string | null
  rightTask: string | null
}

interface StoredChatSplit extends ChatSplitPrefs {
  enabled: boolean
}

export const CHAT_SPLIT_STORAGE_KEY = 'octopus.chat.split.v1'
/** 中间分隔条宽度（px）——布局与拖拽计算共用。 */
export const CHAT_SPLIT_DIVIDER_WIDTH = 8
/** 每栏最小宽度（px）。窄到这个程度就读不下转录了。 */
export const CHAT_SPLIT_MIN_PANE_WIDTH = 380
/** 分屏只在宽屏（≥1024）可用；更窄时自动退出并保留焦点栏。 */
export const CHAT_SPLIT_MIN_VIEWPORT = 1024
export const CHAT_SPLIT_DEFAULT_RATIO = 0.5

const DEFAULT_STORED: StoredChatSplit = {
  enabled: false,
  ratio: CHAT_SPLIT_DEFAULT_RATIO,
  focused: 'left',
  left: null,
  right: null,
  leftTask: null,
  rightTask: null,
}

function clampRatio(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return CHAT_SPLIT_DEFAULT_RATIO
  return Math.min(0.8, Math.max(0.2, value))
}

function parseStored(raw: string | null): StoredChatSplit {
  if (!raw) return { ...DEFAULT_STORED }
  try {
    const parsed = JSON.parse(raw) as Partial<StoredChatSplit> | null
    if (!parsed || typeof parsed !== 'object') return { ...DEFAULT_STORED }
    return {
      enabled: parsed.enabled === true,
      ratio: clampRatio(parsed.ratio),
      focused: parsed.focused === 'right' ? 'right' : 'left',
      left: typeof parsed.left === 'string' && parsed.left ? parsed.left : null,
      right: typeof parsed.right === 'string' && parsed.right ? parsed.right : null,
      leftTask: typeof parsed.leftTask === 'string' && parsed.leftTask ? parsed.leftTask : null,
      rightTask: typeof parsed.rightTask === 'string' && parsed.rightTask ? parsed.rightTask : null,
    }
  } catch {
    return { ...DEFAULT_STORED }
  }
}

function readStorage(): StoredChatSplit {
  if (typeof window === 'undefined') return { ...DEFAULT_STORED }
  try {
    return parseStored(window.localStorage.getItem(CHAT_SPLIT_STORAGE_KEY))
  } catch {
    return { ...DEFAULT_STORED }
  }
}

const listeners = new Set<() => void>()
let stored: StoredChatSplit | null = null
let enabledSnapshot = false

function ensure(): StoredChatSplit {
  if (stored) return stored
  stored = readStorage()
  enabledSnapshot = stored.enabled
  return stored
}

function persist() {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(CHAT_SPLIT_STORAGE_KEY, JSON.stringify(ensure()))
  } catch {
    /* storage unavailable — split is a convenience, not correctness */
  }
}

function emit() {
  for (const listener of listeners) listener()
}

/** 当前分屏开关（模块级快照；供 useSyncExternalStore 读取）。 */
export function getChatSplitEnabled(): boolean {
  ensure()
  return enabledSnapshot
}

export function setChatSplitEnabled(next: boolean): void {
  ensure()
  if (enabledSnapshot === next) return
  enabledSnapshot = next
  const record = ensure()
  record.enabled = next
  persist()
  emit()
}

function subscribeChatSplit(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useChatSplitEnabled(): boolean {
  return useSyncExternalStore(subscribeChatSplit, getChatSplitEnabled, () => false)
}

/** 布局偏好（比例 / 焦点栏 / 两栏会话）。分屏关闭时也会读，供下次进入恢复。 */
export function readChatSplitPrefs(): ChatSplitPrefs {
  const record = ensure()
  return {
    ratio: record.ratio,
    focused: record.focused,
    left: record.left,
    right: record.right,
    leftTask: record.leftTask,
    rightTask: record.rightTask,
  }
}

export function writeChatSplitPrefs(patch: Partial<ChatSplitPrefs>): void {
  const record = ensure()
  let changed = false
  if (patch.ratio !== undefined) {
    const ratio = clampRatio(patch.ratio)
    if (record.ratio !== ratio) { record.ratio = ratio; changed = true }
  }
  if (patch.focused !== undefined && record.focused !== patch.focused) {
    record.focused = patch.focused
    changed = true
  }
  if (patch.left !== undefined && record.left !== patch.left) {
    record.left = patch.left
    changed = true
  }
  if (patch.right !== undefined && record.right !== patch.right) {
    record.right = patch.right
    changed = true
  }
  if (patch.leftTask !== undefined && record.leftTask !== patch.leftTask) {
    record.leftTask = patch.leftTask
    changed = true
  }
  if (patch.rightTask !== undefined && record.rightTask !== patch.rightTask) {
    record.rightTask = patch.rightTask
    changed = true
  }
  if (changed) persist()
}

/** 仅测试用：丢掉模块级缓存，下一次读取重新走 localStorage。 */
export function resetChatSplitForTests(): void {
  stored = null
  enabledSnapshot = false
  listeners.clear()
}

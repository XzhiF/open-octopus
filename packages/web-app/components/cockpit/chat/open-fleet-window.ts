// v22 #5（2026-11-23 用户）：编队 chat 窗的统一入口。
//
//   行体 / 💬 / 详情里的「💬 对话」都走这里 —— 已开过就聚焦（共享 z 栈置顶），
//   否则开一扇新窗：默认几何量主通讯台，和它一样大、直接盖上去；多扇逐扇
//   错开 18px。上限仍为 5，超出 toast 拒绝（不静默吞掉）。

import { toast } from 'sonner'
import type { CockpitRect, CockpitThreadsApi, CockpitWindowsApi } from '../state/cockpit-state'
import { CHAT_MINI_HEIGHT, cascadeFromConsole, cockpitConsoleRect } from './geometry'

const CONSOLE_SELECTOR = '[data-testid="cockpit-chat-window"]'

export interface ConsoleView {
  /** 主通讯台在 CockpitState 里的几何（null = 首帧还没量到）。 */
  rect: CockpitRect | null
  open: boolean
  mini: boolean
  docked: boolean
}

/** 主通讯台当前几何；收起 / 停靠 / 最小化 / 首帧未量到 → null（走默认几何）。 */
function readConsoleRect(): CockpitRect | null {
  if (typeof document === 'undefined') return null
  const el = document.querySelector<HTMLElement>(CONSOLE_SELECTOR)
  if (!el) return null
  if (el.dataset.open !== 'true' || el.dataset.mini === 'true' || el.dataset.docked === 'true') return null
  const rect = el.getBoundingClientRect()
  if (rect.width < 2 || rect.height < 2) return null
  return { x: Math.round(rect.left), y: Math.round(rect.top), w: Math.round(rect.width), h: Math.round(rect.height) }
}

/** 优先用状态里的几何：state.rect 量到之前恒为 null，DOM 此时还只是 CSS
 *  min-size（320×47）—— 首帧点开会开出 320×260 的小窗（实测）。 */
function consoleRectOf(view: ConsoleView | null | undefined): CockpitRect | null {
  if (!view) return readConsoleRect()
  if (!view.open || view.mini || view.docked) return null
  if (!view.rect || view.rect.h <= CHAT_MINI_HEIGHT + 4) return null
  return view.rect
}

/** 通讯台量不到时（首帧 / 收起 / 停靠）也不能退成小窗：直接按通讯台自己的
 *  默认几何算一份（与 CockpitChatWindow 的 computeDefaultRect 同口径）。 */
function defaultConsoleRect(): CockpitRect | null {
  if (typeof window === 'undefined') return null
  return cockpitConsoleRect({
    viewport: { width: window.innerWidth, height: window.innerHeight },
    footerTop: null,
    composerTop: null,
  })
}

export function openFleetChat(
  wins: CockpitWindowsApi,
  threads: Pick<CockpitThreadsApi, 'clearUnread'>,
  threadKey: string,
  consoleView?: ConsoleView | null,
): boolean {
  const hit = wins.windows.find((win) => win.threadKey === threadKey)
  const rect = hit
    ? hit.rect
    : cascadeFromConsole(consoleRectOf(consoleView) ?? defaultConsoleRect(), wins.windows.length, {
      width: window.innerWidth,
      height: window.innerHeight,
    })
  const ok = wins.openWindow(threadKey, rect)
  if (!ok) toast.error('独立窗口最多 5 个 —— 先关一扇再开')
  else threads.clearUnread(threadKey)
  return ok
}

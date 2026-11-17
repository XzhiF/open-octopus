'use client'

// v20（design 29 §5）：通讯台停靠 pill —— 整台收起后留在舱壁下沿，
// 带当前线程短名 + 总未读；新消息 ping；点击 / ⌥C / WINDOWS 主 chip 展开。
// 有弹出窗时让位到右下（与 WINDOWS 条垂直/水平分离，design 29 §1.3）。

import { useCockpitState } from '../state/CockpitStateProvider'
import { useCockpitThreads } from './use-cockpit-threads'

export function CockpitDock() {
  const { chatWindow, threads: api, wins } = useCockpitState()
  const { active } = useCockpitThreads()
  if (!chatWindow.docked) return null

  const total = Object.values(api.unread).reduce((sum, n) => sum + n, 0)

  return (
    <button
      type="button"
      className={`ck12-condock${total > 0 ? ' has-unread' : ''}${wins.windows.length ? ' is-right' : ''}`}
      data-testid="cockpit-con-dock"
      title="通讯停靠 · 点击展开（⌥C）"
      onClick={() => chatWindow.openWithFocus()}
    >
      <span className="ck12-condock-ico" aria-hidden="true">💬</span>
      <span className="ck12-condock-name">{active.short}</span>
      {total > 0 && <i className="ck12-condock-unread">{total > 9 ? '9+' : total}</i>}
      <span className="ck12-condock-hint">通讯停靠 · 点击展开</span>
    </button>
  )
}

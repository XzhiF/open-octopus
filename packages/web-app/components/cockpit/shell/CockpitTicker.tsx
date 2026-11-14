'use client'

// 指令条上方的一行回执（v12 .ticker，30px）。
// 读 fx.lastSaid 与 chat.streaming；都没有就显示「等她开口」。
// 点击 = 展开对话（chatWindow.openWithFocus，v12 行为）。

import { moodPortrait } from '@/components/cabin/cockpit'
import { useCockpitState } from '../state/CockpitStateProvider'

export function CockpitTicker() {
  const { chat, chatWindow, fx } = useCockpitState()
  const said = fx.lastSaid
  const streaming = chat?.streaming ?? false

  const text = said?.line ?? (streaming ? '汐音正在回复…' : '等她开口')

  return (
    <button
      type="button"
      className={`ck12-ticker${said ? ' ck12-ticker-unread' : ''}`}
      onClick={() => chatWindow.openWithFocus()}
      title="展开对话"
      data-testid="cockpit-ticker"
    >
      <span className="ck12-ticker-av">
        <img src={moodPortrait(said?.mood ?? 'idle')} alt="" />
      </span>
      <span className="ck12-ticker-who">汐音</span>
      <span className="ck12-ticker-tx">{text}</span>
      <span className="ck12-ticker-go">展开对话 ⌄</span>
    </button>
  )
}

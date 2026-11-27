'use client'

// v20（design 29 §4）：WINDOWS 后台式切换条 —— 有弹出窗才出现（左下）。
// 主通讯 chip + 每窗 chip（状态表情 + 短名 + 未读点 + 最小化虚线态）。
// 点 chip = 恢复 + 聚焦；点主 chip = 展开主通讯台。无窗自动隐藏。

import { useCockpitState } from '../state/CockpitStateProvider'
import { THREAD_EMO } from '../fleet/threads-model'
import { accentOfAnchor } from '../fleet/project-accent'
import { useCockpitThreads } from './use-cockpit-threads'
import { openFleetChat } from './open-fleet-window'

export function CockpitWinBar() {
  const { wins, chatWindow, threads: api } = useCockpitState()
  const { byKey } = useCockpitThreads()
  if (!wins.windows.length) return null

  const mainUnread = api.unread.main ?? 0

  return (
    <div className="ck12-winbar" data-testid="cockpit-winbar" role="toolbar" aria-label="WINDOWS 切换条">
      <span className="ck12-winbar-label">WINDOWS</span>
      <button
        type="button"
        className="ck12-wbchip is-main"
        data-testid="cockpit-winbar-main"
        title="展开主通讯台"
        onClick={() => chatWindow.openWithFocus()}
      >
        <span aria-hidden="true">💬</span>
        <span className="ck12-wbchip-name">主通讯</span>
        {mainUnread > 0 && <i className="ck12-wbchip-unread">{mainUnread > 9 ? '9+' : mainUnread}</i>}
      </button>
      {wins.windows.map((win) => {
        // v23：新会话窗（草稿 / 自建会话）没有编队线程，chip 自己取标题与项目色。
        if (!win.threadKey) {
          const draft = !win.sessionId
          const accent = win.sessionId ? accentOfAnchor(`session:${win.sessionId}`) : 'var(--ck12-sky)'
          return (
            <button
              key={win.id}
              type="button"
              className={`ck12-wbchip is-wacc${win.min ? ' is-min' : ''}`}
              style={{ ['--waccent' as string]: accent }}
              data-testid={`cockpit-winbar-chip-${win.id}`}
              title={draft
                ? '新会话 · 发第一条消息才创建'
                : (win.min ? `恢复 ${win.title}` : `聚焦 ${win.title}`)}
              onClick={() => wins.setWindowMin(win.id, false)}
            >
              <span aria-hidden="true">{draft ? '✚' : '💬'}</span>
              <span className="ck12-wbchip-name">{draft ? '新会话' : win.title}</span>
            </button>
          )
        }
        const threadKey = win.threadKey
        const thread = byKey.get(threadKey)
        if (!thread) return null
        const unread = api.unread[threadKey] ?? 0
        return (
          <button
            key={win.id}
            type="button"
            className={`ck12-wbchip is-wacc${win.min ? ' is-min' : ''}`}
            style={{ ['--waccent' as string]: thread.accent }}
            data-testid={`cockpit-winbar-chip-${win.id}`}
            title={win.min ? `恢复 ${thread.title}` : `聚焦 ${thread.title}`}
            onClick={() => openFleetChat(wins, api, threadKey, chatWindow)}
          >
            <span aria-hidden="true">{THREAD_EMO[thread.state]}</span>
            <span className="ck12-wbchip-name">{thread.short}</span>
            {unread > 0 && <i className="ck12-wbchip-unread">{unread > 9 ? '9+' : unread}</i>}
          </button>
        )
      })}
    </div>
  )
}

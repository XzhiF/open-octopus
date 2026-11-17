'use client'

// v20（design 29 §3.2）：多作战 tab 条 —— 状态表情 + 短名 + 未读红点 + 悬停 ✕。
// 关闭只是隐藏（历史/未读保留），回传会自动重开；主对话不可关。

import { THREAD_EMO, THREAD_STATE_LABEL } from '../fleet/threads-model'
import { useCockpitState } from '../state/CockpitStateProvider'
import { useCockpitThreads } from './use-cockpit-threads'

export function CockpitThreadTabs() {
  const { visible, active } = useCockpitThreads()
  const { threads: api } = useCockpitState()

  return (
    <div className="ck12-comms-tabstrip" role="tablist" aria-label="作战线程" data-testid="cockpit-thread-tabs">
      {visible.map((thread) => {
        const unread = api.unread[thread.key] ?? 0
        const on = thread.key === active.key
        return (
          <div
            key={thread.key}
            role="tab"
            tabIndex={0}
            aria-selected={on}
            className={`ck12-tab${on ? ' is-on' : ''}${unread > 0 ? ' has-unread' : ''}`}
            data-thread={thread.key}
            data-testid={`cockpit-tab-${thread.key}`}
            title={`${thread.title} · ${thread.kind === 'main' ? '舱主对话' : THREAD_STATE_LABEL[thread.state]}`}
            onClick={() => api.activateThread(thread.key)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                api.activateThread(thread.key)
              }
            }}
          >
            <span className="ck12-tab-emo" aria-hidden="true">
              {thread.kind === 'main' ? '✦' : THREAD_EMO[thread.state]}
            </span>
            <span className="ck12-tab-name">{thread.short}</span>
            {unread > 0 && (
              <i className="ck12-tab-unread" data-testid={`cockpit-tab-unread-${thread.key}`}>
                {unread > 9 ? '9+' : unread}
              </i>
            )}
            {thread.key !== 'main' && (
              <button
                type="button"
                className="ck12-tab-x"
                aria-label={`关闭页签 ${thread.short}`}
                title="关闭页签（历史保留）"
                onClick={(event) => {
                  event.stopPropagation()
                  api.closeTab(thread.key)
                }}
              >
                ✕
              </button>
            )}
          </div>
        )
      })}
    </div>
  )
}

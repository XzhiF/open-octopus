'use client'

// v20（design 29 §3.2）+ v21（design 31 §3.2）· 多作战 tab 条。
//
// v21 修正：通讯台 tab 曾复用 `.ck12-tab`，与作业面页签（face.css 的
// `.ck12-tab { flex-direction: column }`）撞名，名称被压成 0 高。这里改用
// 独立命名空间 `ck12-ctab*`，并按原型 `.ctab` 的顺序排：✕ → 状态表情 → 名称 → 未读。
// 名称占满剩余宽度、ellipsis 裁切；✕ 常态低透明，悬停/激活才亮（位移不变）。
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
            className={`ck12-ctab${on ? ' is-on' : ''}${unread > 0 ? ' has-unread' : ''}`}
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
            {thread.key !== 'main' && (
              <button
                type="button"
                className="ck12-ctab-x"
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
            <span className="ck12-ctab-emo" aria-hidden="true">
              {thread.kind === 'main' ? '✦' : THREAD_EMO[thread.state]}
            </span>
            <span className="ck12-ctab-name">{thread.short}</span>
            {unread > 0 && (
              <i className="ck12-ctab-unread" data-testid={`cockpit-tab-unread-${thread.key}`}>
                {unread > 9 ? '9+' : unread}
              </i>
            )}
          </div>
        )
      })}
    </div>
  )
}

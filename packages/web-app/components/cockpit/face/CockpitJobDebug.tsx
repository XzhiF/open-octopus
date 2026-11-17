'use client'

// v20（design 29 §6 detail 调试页签）：作业坞同款 debug inspect 嵌进作业面。
// 复用 DebugInspectorWindow 的 inline 档（统计 + 过滤单行），数据走真实
// /api/agent/debug/sessions/:id/turns —— 不另造 mock 轮次。

import { DebugInspectorWindow } from '@/components/chat-workbench/debug-inspector-window'

export function CockpitJobDebug({ sessionId }: { sessionId: string | null }) {
  if (!sessionId) {
    return <div className="ck12-files-empty">这条作业还没有会话 · 没有调试记录</div>
  }
  return (
    <div className="ck12-dbg" data-testid="cockpit-job-debug-inspector">
      <DebugInspectorWindow sessionId={sessionId} inline />
    </div>
  )
}

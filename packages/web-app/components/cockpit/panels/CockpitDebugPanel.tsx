'use client'

// v21 四轮：右栏「调试」= **本舱主会话**的 per-turn SDK inspector（跟汐音的主 chat）。
//
// 与作业面「调试」页签（CockpitJobDebug）分工：
//   · 右栏常驻按钮 / ⌥D → 本舱 main_session_id 的调试记录；
//   · 某条作业的调试 → 编队行开详情、切「调试」页签（不看本舱主会话）。
// 数据仍走真实 /api/agent/debug/sessions/:id/turns（DebugInspectorWindow inline）。

import { useCabinOptional } from '@/components/cabin/cabin-provider'
import { DebugInspectorWindow } from '@/components/chat-workbench/debug-inspector-window'
import { CockpitPanelShell } from './CockpitPanelShell'

export function CockpitDebugPanel() {
  const cabin = useCabinOptional()?.cabin ?? null
  const sessionId = cabin?.main_session_id ?? null

  return (
    <CockpitPanelShell kind="debug" title="本舱调试" en="MAIN SESSION · XIYIN">
      <div className="ck12-ledger-note" data-testid="cockpit-debug-note">
        本舱调试 = 你和汐音的主对话（本舱主会话）；某条作业的调试在它的详情「调试」页签。
      </div>
      {sessionId ? (
        <div className="ck12-dbg" data-testid="cockpit-main-debug-inspector">
          <DebugInspectorWindow sessionId={sessionId} inline />
        </div>
      ) : (
        <div className="ck12-files-empty" data-testid="cockpit-main-debug-empty">
          该舱还没有主会话 · 没有调试记录
        </div>
      )}
    </CockpitPanelShell>
  )
}

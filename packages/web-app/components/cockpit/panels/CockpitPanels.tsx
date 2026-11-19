'use client'

// v20（design 29 §6）：模态面板路由 —— state.panel 决定开哪一扇。
// 编队 / 详情不在此（左栏 + 作业面就是它们的全集）。
// 作业面标题行的 ◈/⧉ hex 走 octopus:cockpit-action 事件进来（job-face 在
// classic 也渲染，不能直接 import 全域 state）。

import { useEffect } from 'react'
import { useCockpitState } from '../state/CockpitStateProvider'
import { CockpitOpsPanel } from './CockpitOpsPanel'
import { CockpitLedgerPanel } from './CockpitLedgerPanel'
import { CockpitWsPanel } from './CockpitWsPanel'
import { CockpitPosesPanel } from './CockpitPosesPanel'
import { CockpitDebugPanel } from './CockpitDebugPanel'

export function CockpitPanels() {
  const { panel, openPanel, select, entryCabinId } = useCockpitState()

  useEffect(() => {
    const onAction = (event: Event) => {
      const detail = (event as CustomEvent<{ action?: string; key?: string }>).detail
      if (detail?.action === 'ops') openPanel('ops')
      if (detail?.action === 'ws') openPanel('ws', detail.key ?? null)
      if (detail?.action === 'project' && detail.key) {
        select({ kind: 'project', cabinId: entryCabinId, id: detail.key })
      }
    }
    window.addEventListener('octopus:cockpit-action', onAction)
    return () => window.removeEventListener('octopus:cockpit-action', onAction)
  }, [openPanel, select, entryCabinId])

  if (panel === 'ops') return <CockpitOpsPanel />
  if (panel === 'ledger') return <CockpitLedgerPanel />
  if (panel === 'ws') return <CockpitWsPanel />
  if (panel === 'poses') return <CockpitPosesPanel />
  if (panel === 'debug') return <CockpitDebugPanel />
  return null
}

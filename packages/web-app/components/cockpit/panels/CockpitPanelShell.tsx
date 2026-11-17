'use client'

// v20（design 29 §6）：模态面板壳 —— 居中玻璃 overlay + scrim，Esc 走唯一层栈。
// 编队 / 详情沿用左栏与作业面（不另起模态）；ops / ledger / ws / poses 四面板
// 共用这一壳。priority 85：压住任务模块窗(80)/问答窗(75)/通讯台(60)，
// 低于立绘控制条(90)与 popover(100)。

import { useEffect, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { useCockpitState } from '../state/CockpitStateProvider'
import type { CockpitPanelKind } from '../state/cockpit-state'

const PANEL_LAYER_PRIORITY = 85

export function CockpitPanelShell({
  kind,
  title,
  en,
  children,
  wide,
}: {
  kind: CockpitPanelKind
  title: string
  en: string
  children: ReactNode
  wide?: boolean
}) {
  const { closePanel, layer } = useCockpitState()

  useEffect(() => layer.register(`cockpit-panel-${kind}`, PANEL_LAYER_PRIORITY, closePanel), [kind, layer, closePanel])

  return (
    <div className="ck12-pscrim" data-testid={`cockpit-panel-scrim-${kind}`} onClick={closePanel}>
      <section
        className={`ck12-panel${wide ? ' is-wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        data-testid={`cockpit-panel-${kind}`}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="ck12-panel-h">
          <b>{title}</b>
          <span className="ck12-panel-en">{en}</span>
          <span className="ck12-panel-ln" aria-hidden="true" />
          <button
            type="button"
            className="ck12-panel-x"
            aria-label={`关闭${title}`}
            title="关闭（Esc）"
            onClick={closePanel}
          >
            <X className="size-3.5" aria-hidden="true" />
          </button>
        </header>
        <div className="ck12-panel-b">{children}</div>
      </section>
    </div>
  )
}

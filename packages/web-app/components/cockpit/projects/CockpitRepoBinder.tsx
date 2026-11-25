'use client'

// 舱内绑定面板的模态壳（v22 原型 · 2026-11-24 用户 #2）：
// 头（✕ 左置 + 标题/副行）由这里出；页签 / 目录浏览 / 已选 / 差集保存都在
// CockpitBindPanel。Esc 走 CockpitLayerStack（比面低一层：先关面板，再收面）。

import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import type { CabinRepoEntry } from '@/lib/cabin-api'
import { useCockpitState } from '../state/CockpitStateProvider'
import { CockpitBindPanel } from './CockpitBindPanel'

export interface CockpitRepoBinderProps {
  open: boolean
  cabinId: string
  cabinName: string
  cabinPath: string | null
  projects: CabinRepoEntry[]
  onClose: () => void
  onSaved: () => void
}

const MODAL_PRIORITY = 60

export function CockpitRepoBinder({
  open, cabinId, cabinName, cabinPath, projects, onClose, onSaved,
}: CockpitRepoBinderProps) {
  const { layer } = useCockpitState()

  useEffect(() => {
    if (!open) return
    return layer.register('cockpit-repo-binder', MODAL_PRIORITY, onClose)
  }, [open, layer, onClose])

  if (!open) return null

  return createPortal((
    <div
      className="ck12-bindmodal"
      role="dialog"
      aria-modal="true"
      aria-label="绑定项目"
      data-testid="cockpit-repo-binder"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="ck12-bindcard">
        <div className="ck12-bindcard-h">
          <button type="button" className="ck12-bind-x" aria-label="关闭" onClick={onClose}>✕</button>
          <span className="ck12-bind-tt">
            <b>绑定项目</b>
            <span className="ck12-bind-sub">
              {cabinName} · {projects.length} 已绑 · 项目是关联关系，不搬代码
            </span>
          </span>
        </div>
        <CockpitBindPanel
          cabinId={cabinId}
          cabinName={cabinName}
          cabinPath={cabinPath}
          projects={projects}
          onClose={onClose}
          onSaved={onSaved}
        />
      </div>
    </div>
  ), document.body)
}

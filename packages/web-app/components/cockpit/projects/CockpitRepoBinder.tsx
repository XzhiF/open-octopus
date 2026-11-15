'use client'

// 舱内绑定面板：复用建舱的 CabinProjectBinder 数据层（ORG manifest + 本地扫描），
// 保存 = 与现有条目求差集 → addRepo / removeRepo（不动磁盘）。
// Esc 走 CockpitLayerStack（比面低一层：先关面板，再收面）。

import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { toast } from 'sonner'
import { addCabinRepo, removeCabinRepo, type CabinRepoEntry } from '@/lib/cabin-api'
import type { CabinProjectRef } from '@/lib/cabin-draft'
import { CabinProjectBinder } from '@/components/cabin/CabinProjectBinder'
import { useCockpitState } from '../state/CockpitStateProvider'
import { invalidateCabinProjects } from './use-cabin-projects'

export interface CockpitRepoBinderProps {
  open: boolean
  cabinId: string
  cabinPath: string | null
  projects: CabinRepoEntry[]
  onClose: () => void
  onSaved: () => void
}

const MODAL_PRIORITY = 60

function refOfEntry(entry: CabinRepoEntry): CabinProjectRef {
  if (entry.source === 'local') {
    return {
      source: 'local',
      repo: entry.name,
      ...(entry.external ? { absolutePath: entry.main_path ?? undefined, external: true } : { localPath: entry.local_path ?? undefined }),
    }
  }
  return { source: 'org', org: entry.org ?? undefined, repo: entry.name }
}

function keyOfRef(ref: CabinProjectRef): string {
  if (ref.source === 'local') return `local:${ref.localPath ?? ref.absolutePath ?? ref.repo}`
  return `org:${ref.org ?? ''}/${ref.repo}`
}

export function CockpitRepoBinder({
  open, cabinId, cabinPath, projects, onClose, onSaved,
}: CockpitRepoBinderProps) {
  const { layer } = useCockpitState()
  const [selected, setSelected] = useState<CabinProjectRef[]>(() => projects.map(refOfEntry))
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (open) setSelected(projects.map(refOfEntry))
  }, [open, projects])

  useEffect(() => {
    if (!open) return
    return layer.register('cockpit-repo-binder', MODAL_PRIORITY, onClose)
  }, [open, layer, onClose])

  if (!open) return null

  const save = async () => {
    setSaving(true)
    try {
      const current = new Map(projects.map((p) => [p.key, p]))
      const next = new Set(selected.map(keyOfRef))
      const added = selected.filter((ref) => !current.has(keyOfRef(ref)))
      const removed = projects.filter((p) => !next.has(p.key))
      for (const ref of added) {
        await addCabinRepo(cabinId, {
          source: ref.source === 'local' ? 'local' : 'org',
          name: ref.repo,
          ...(ref.source === 'local'
            ? { localPath: ref.localPath, absolutePath: ref.absolutePath, external: ref.external }
            : { org: ref.org }),
        })
      }
      for (const entry of removed) {
        await removeCabinRepo(cabinId, entry.name)
      }
      invalidateCabinProjects(cabinId)
      toast.success(`已保存 · +${added.length} / −${removed.length}`)
      onSaved()
      onClose()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

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
          <b>绑定项目</b>
          <span>{cabinPath ?? '（舱目录不可用 · 只列 ORG 项目）'}</span>
          <span className="ck12-ln" aria-hidden="true" />
          <button type="button" className="ck12-bind-x" aria-label="关闭" onClick={onClose}>✕</button>
        </div>
        <div className="ck12-bindcard-body">
          <CabinProjectBinder
            selected={selected}
            onChange={setSelected}
            dirPath={cabinPath}
            autoSelectLocal={false}
          />
        </div>
        <div className="ck12-bindcard-foot">
          <button type="button" className="ck12-pj-act" onClick={onClose}>取消</button>
          <button
            type="button"
            className="ck12-pj-act is-primary"
            disabled={saving}
            onClick={save}
          >
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  ), document.body)
}
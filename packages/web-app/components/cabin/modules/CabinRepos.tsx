'use client'

// S5 仓库窗（原型 wbRepos）：repo 卡（主线分支/remote/HEAD commit）+ 拉取 +
// clone 新仓。数据 = GET /:id/repos（config.json.repos[] 契约 + git 富化）。

import { useCallback, useEffect, useState } from 'react'
import { Folder, Plus, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { fetchManifestRepos } from '@/lib/api-client'
import { addCabinRepo, listCabinRepos, pullCabinRepo, type CabinRepoEntry } from '@/lib/cabin-api'
import { useCabinContext } from '../cabin-provider'
import { Empty, SBadge, WBtn, WbH, WbNote } from './ui'

export function CabinRepos() {
  const { cabinId, cabin } = useCabinContext()
  const [repos, setRepos] = useState<CabinRepoEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [cloneOpen, setCloneOpen] = useState(false)
  const [cloneName, setCloneName] = useState('')
  const [options, setOptions] = useState<string[]>([])
  const [busy, setBusy] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      setRepos(await listCabinRepos(cabinId))
    } catch {
      setRepos([])
    } finally {
      setLoading(false)
    }
  }, [cabinId])

  useEffect(() => { void refresh() }, [refresh])

  useEffect(() => {
    if (!cloneOpen || !cabin?.org) return
    let alive = true
    void (async () => {
      try {
        const data = await fetchManifestRepos(cabin.org!) as {
          groups?: Record<string, Array<{ name: string }>>
        }
        if (!alive) return
        const names: string[] = []
        for (const items of Object.values(data.groups ?? {})) {
          for (const item of items ?? []) names.push(item.name)
        }
        setOptions(names)
      } catch {
        if (alive) setOptions([])
      }
    })()
    return () => { alive = false }
  }, [cloneOpen, cabin?.org])

  const doPull = async (name: string) => {
    setBusy(name)
    try {
      const res = await pullCabinRepo(cabinId, name)
      toast.success(`已拉取 ${name} 主线 · ${res.branch} @ ${res.commit.slice(0, 8)}`)
      await refresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '拉取失败')
    } finally {
      setBusy(null)
    }
  }

  const doClone = async () => {
    const name = cloneName.trim()
    if (!name) return
    setBusy('clone')
    try {
      await addCabinRepo(cabinId, name)
      toast.success(`已 clone ${name} 进舱（projects/${name}）`)
      setCloneOpen(false)
      setCloneName('')
      await refresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'clone 失败')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div data-testid="cabin-repos-body">
      <WbH icon={Folder} title="仓库" cap="多仓 clone · 主线分支">
        <WBtn pri testId="cabin-repos-clone" onClick={() => setCloneOpen((v) => !v)}>
          <Plus className="size-3" />clone 新仓
        </WBtn>
      </WbH>
      <WbNote className="mb-3">
        舱目录即长期 workspace：<code className="text-pop-cyan">{cabin?.path}/projects/&lt;repo&gt;</code> 各仓工作树（主线开发），
        关系写入 <code className="text-pop-cyan">config.json.repos[]</code>；并行任务从主线切出，互不污染舱主空间。
      </WbNote>

      {cloneOpen && (
        <div className="mb-3 flex items-center gap-2 rounded-lg border-[1.5px] border-pop-bd bg-pop-idle p-2.5" data-testid="cabin-repos-clone-dialog">
          <input
            value={cloneName}
            onChange={(e) => setCloneName(e.target.value)}
            list="cabin-repo-options"
            placeholder="仓库名（org 注册表）"
            data-testid="cabin-repos-clone-input"
            className="h-7 flex-1 rounded-md border border-pop-bd bg-pop-bg px-2 text-[12px] text-pop-ink outline-none focus:border-pop-pink/60"
          />
          <datalist id="cabin-repo-options">
            {options.map((n) => <option key={n} value={n} />)}
          </datalist>
          <WBtn pri onClick={() => { void doClone() }} disabled={busy === 'clone' || !cloneName.trim()} testId="cabin-repos-clone-confirm">
            {busy === 'clone' ? 'clone 中…' : 'clone'}
          </WBtn>
        </div>
      )}

      {loading ? (
        <Empty>读取仓库…</Empty>
      ) : repos.length === 0 ? (
        <Empty>暂无仓库 · 点「clone 新仓」或在主对话吩咐调度者</Empty>
      ) : repos.map((r) => (
        <div key={r.name} className="mb-3 overflow-hidden rounded-xl border-[1.5px] border-pop-bd bg-pop-idle" data-repo-card={r.name}>
          <div className="flex items-center gap-3 px-3.5 py-3">
            <div className="grid size-[30px] shrink-0 place-items-center rounded-lg bg-pop-navy/15 text-pop-navy">
              <Folder className="size-[15px]" />
            </div>
            <div className="min-w-0 flex-1">
              <b className="text-[13px] text-pop-ink">{r.name}</b>
              <div className="mt-0.5 flex flex-wrap gap-2.5 text-[10.5px] text-pop-dim">
                <span className="text-pop-pink">⎇ {r.git?.branch ?? r.branch ?? '—'}</span>
                {r.git?.remote && <span className="truncate">{r.git.remote}</span>}
                {r.git && <span>{r.git.commit}{r.git.msg ? ` · ${r.git.msg}` : ''}</span>}
              </div>
            </div>
            <SBadge color="dim">{r.git ? '1 工作树' : '未切树'}</SBadge>
            <WBtn onClick={() => { void doPull(r.name) }} disabled={busy === r.name} testId={`cabin-repos-pull-${r.name}`}>
              <RefreshCw className="size-3" />拉取
            </WBtn>
          </div>
        </div>
      ))}
    </div>
  )
}

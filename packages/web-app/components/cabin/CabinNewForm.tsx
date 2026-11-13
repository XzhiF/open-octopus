'use client'

// 新建工作舱表单（原型 index.html pendingCabin 的表单本体）：
// 名称 + 目录（browseDirectories）+ org/仓库（注册表多选）+ 需求备注 →
// POST /api/cabins → init → onCreated(cabinId)。
// 目录已有舱时服务端 create 冲突 → 自动走 attach 复用（原型 askReuse 语义）。
//
// 2026-11-13：从 CabinNewHero 抽出，页面（/cabin/new 深链兜底）与桌面内联
// 新建 hero（CabinDraftPane）共用同一份表单，两条入口不再各写一遍。

import { useCallback, useEffect, useState } from 'react'
import { ArrowUp, Folder, FolderOpen, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { browseDirectories, fetchManifestRepos, type BrowseResult } from '@/lib/api-client'
import { attachCabin, createCabin, initCabin } from '@/lib/cabin-api'
import { useOrgs } from '@/hooks/useOrgs'
import { cn } from '@/lib/utils'

interface RepoOption {
  name: string
  group: string
}

export interface CabinNewFormProps {
  /** 创建并拉起 init 后回调（id 已落库）。 */
  onCreated: (cabinId: string) => void
  /** 取消 → 回到调用方上下文（桌面内联 = 返回对话；页面 = 返回桌面）。 */
  onCancel: () => void
  cancelLabel?: string
  submitLabel?: string
}

export function CabinNewForm({
  onCreated,
  onCancel,
  cancelLabel = '返回桌面',
  submitLabel = '开始初始化',
}: CabinNewFormProps) {
  const { orgs } = useOrgs()

  const [name, setName] = useState('')
  const [dir, setDir] = useState<string | null>(null)
  const [org, setOrg] = useState('')
  const [repoOptions, setRepoOptions] = useState<RepoOption[]>([])
  const [repos, setRepos] = useState<string[]>([])
  const [requirements, setRequirements] = useState('')
  const [busy, setBusy] = useState(false)

  const [dirOpen, setDirOpen] = useState(false)
  const [browse, setBrowse] = useState<BrowseResult | null>(null)
  const [browseLoading, setBrowseLoading] = useState(false)
  const [browseError, setBrowseError] = useState<string | null>(null)

  const goto = useCallback(async (target: string) => {
    setBrowseLoading(true)
    setBrowseError(null)
    try {
      setBrowse(await browseDirectories(target || undefined))
    } catch (err) {
      setBrowseError(err instanceof Error ? err.message : '浏览失败')
    } finally {
      setBrowseLoading(false)
    }
  }, [])

  useEffect(() => {
    if (dirOpen && !browse) void goto('')
  }, [dirOpen, browse, goto])

  // org 切换 → 拉注册表仓库；选择清零（不同 org 的仓库不混选，C12 单 org/舱）。
  useEffect(() => {
    if (!org) {
      setRepoOptions([])
      setRepos([])
      return
    }
    let alive = true
    void (async () => {
      try {
        const data = await fetchManifestRepos(org) as {
          groups?: Record<string, Array<{ name: string; group?: string }>>
        }
        if (!alive) return
        const entries: RepoOption[] = []
        for (const [group, items] of Object.entries(data.groups ?? {})) {
          for (const item of items ?? []) entries.push({ name: item.name, group })
        }
        setRepoOptions(entries)
        setRepos([])
      } catch {
        if (alive) setRepoOptions([])
      }
    })()
    return () => { alive = false }
  }, [org])

  const toggleRepo = (repoName: string) => {
    setRepos((prev) => prev.includes(repoName) ? prev.filter((r) => r !== repoName) : [...prev, repoName])
  }

  const submit = async () => {
    const trimmed = name.trim()
    if (!trimmed) { toast.error('给舱起个名字'); return }
    if (!dir) { toast.error('选择舱目录'); return }
    setBusy(true)
    try {
      let cabin
      try {
        cabin = await createCabin({
          name: trimmed,
          path: dir,
          requirements: requirements.trim() || undefined,
          org: org || null,
          repos: repos.length > 0 ? repos : undefined,
        })
      } catch {
        // 目录已有舱 → 附着复用（保留历史/身份），而不是报错让人走投无路。
        cabin = await attachCabin(dir, trimmed)
      }
      if (cabin.status === 'draft') await initCabin(cabin.id)
      onCreated(cabin.id)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '创建失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="space-y-4 rounded-xl border-[1.5px] border-pop-bd bg-pop-paper p-4">
        <label className="block">
          <span className="mb-1 block text-[11px] font-bold text-pop-dim">舱名称（可中文）</span>
          <Input
            data-testid="cabin-name-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="例如：Aurora 结算平台"
            className="h-9"
          />
        </label>

        <div>
          <span className="mb-1 block text-[11px] font-bold text-pop-dim">舱目录（cwd = 长期 workspace）</span>
          <button
            type="button"
            data-testid="cabin-dir-chip"
            onClick={() => setDirOpen(true)}
            className={cn(
              'flex w-full items-center gap-2 rounded-lg border-[1.5px] border-dashed px-3 py-2 text-left text-[12.5px] transition-colors',
              dir ? 'border-pop-bd bg-white/[0.03] text-pop-ink' : 'border-pop-bd text-pop-dim hover:bg-accent',
            )}
          >
            {dir ? <FolderOpen className="size-4 shrink-0 text-pop-yellow" /> : <Folder className="size-4 shrink-0" />}
            <span className="min-w-0 flex-1 truncate font-mono">{dir ?? '选择目录…'}</span>
          </button>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="mb-1 block text-[11px] font-bold text-pop-dim">仓库注册表（org）</span>
            <select
              data-testid="cabin-org-select"
              value={org}
              onChange={(e) => setOrg(e.target.value)}
              className="h-9 w-full rounded-md border border-pop-bd bg-pop-bg px-2 text-[12.5px] text-pop-ink"
            >
              <option value="">不绑仓库</option>
              {orgs.map((o) => <option key={o.name} value={o.name}>{o.name}</option>)}
            </select>
          </label>
          <div className="flex items-end pb-1 text-[10.5px] text-pop-dim/70">
            克隆到 org 镜像，舱内切 worktree（projects/&lt;repo&gt;）
          </div>
        </div>

        {org && (
          <div>
            <span className="mb-1 block text-[11px] font-bold text-pop-dim">
              选择仓库（{repos.length}/{repoOptions.length}）
            </span>
            <div className="flex max-h-36 flex-wrap gap-1.5 overflow-y-auto" data-testid="cabin-repo-picker">
              {repoOptions.map((repo) => {
                const picked = repos.includes(repo.name)
                return (
                  <button
                    key={`${repo.group}/${repo.name}`}
                    type="button"
                    data-repo-name={repo.name}
                    onClick={() => toggleRepo(repo.name)}
                    className={cn(
                      'rounded-full border px-2.5 py-1 text-[11px] font-bold transition-colors',
                      picked
                        ? 'border-pop-yellow bg-pop-yellow text-pop-bg'
                        : 'border-pop-bd text-pop-dim hover:bg-accent hover:text-pop-ink',
                    )}
                  >
                    {repo.name}
                  </button>
                )
              })}
              {repoOptions.length === 0 && (
                <span className="text-[11px] text-pop-dim/70">该 org 注册表为空</span>
              )}
            </div>
          </div>
        )}

        <label className="block">
          <span className="mb-1 block text-[11px] font-bold text-pop-dim">需求备注（落盘 .cabin/requirements.md）</span>
          <textarea
            data-testid="cabin-requirements-input"
            value={requirements}
            onChange={(e) => setRequirements(e.target.value)}
            placeholder="这个舱要做什么？长期目标、约束、偏好…"
            rows={3}
            className="w-full rounded-md border border-pop-bd bg-pop-bg px-3 py-2 text-[12.5px] text-pop-ink placeholder:text-pop-dim/50"
          />
        </label>

        <div className="flex items-center justify-between pt-1">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="text-[12px] font-bold text-pop-dim transition-colors hover:text-pop-ink disabled:opacity-40"
          >
            {cancelLabel}
          </button>
          <Button data-testid="cabin-submit" onClick={() => void submit()} disabled={busy}>
            {busy && <Loader2 className="size-4 animate-spin" />}
            {submitLabel}
          </Button>
        </div>
      </div>

      <Dialog open={dirOpen} onOpenChange={setDirOpen}>
        <DialogContent className="max-w-lg">
          <DialogTitle>选择舱目录</DialogTitle>
          <div className="space-y-2">
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                aria-label="上级目录"
                disabled={!browse?.parent || browseLoading}
                onClick={() => browse?.parent && void goto(browse.parent)}
                className="grid size-7 shrink-0 place-items-center rounded-md border border-pop-bd text-pop-dim transition-colors hover:bg-accent disabled:opacity-40"
              >
                <ArrowUp className="size-3.5" />
              </button>
              <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-pop-dim" data-testid="cabin-browse-path">
                {browse?.path ?? '…'}
              </span>
              {browseLoading && <Loader2 className="size-3.5 shrink-0 animate-spin text-pop-dim" />}
            </div>
            {browse && browse.roots.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {browse.roots.map((root) => (
                  <button
                    key={root.path}
                    type="button"
                    onClick={() => void goto(root.path)}
                    className="rounded-full border border-pop-bd px-2 py-0.5 text-[10.5px] text-pop-dim transition-colors hover:bg-accent"
                  >
                    {root.name}
                  </button>
                ))}
              </div>
            )}
            {browseError && <div className="text-[11.5px] text-pop-red">{browseError}</div>}
            <div className="max-h-64 overflow-y-auto rounded-md border border-pop-bd" data-testid="cabin-browse-list">
              {(browse?.dirs ?? []).map((entry) => (
                <button
                  key={entry.path}
                  type="button"
                  onClick={() => void goto(entry.path)}
                  className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[12px] text-pop-ink transition-colors hover:bg-accent"
                >
                  <Folder className="size-3.5 shrink-0 text-pop-dim" />
                  <span className="truncate">{entry.name}</span>
                </button>
              ))}
              {browse && browse.dirs.length === 0 && !browseLoading && (
                <div className="px-2.5 py-2 text-[11.5px] text-pop-dim/70">无子目录</div>
              )}
            </div>
            <div className="flex justify-end">
              <Button
                data-testid="cabin-browse-select"
                disabled={!browse?.canSelect || browseLoading}
                onClick={() => {
                  if (!browse) return
                  setDir(browse.path)
                  setDirOpen(false)
                }}
              >
                选择当前目录
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}

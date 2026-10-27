'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowUp, Check, ChevronDown, Folder, FolderOpen, Loader2, Plus } from 'lucide-react'
import { toast } from 'sonner'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import {
  attachWorkspaceDirectory,
  browseDirectories,
  listWorkspaces,
  type BrowseResult,
} from '@/lib/api-client'
import type { Workspace } from '@/lib/types'
import { cn } from '@/lib/utils'

export type CwdChoice = {
  kind: 'default' | 'workspace' | 'directory'
  workspaceId?: string
  path?: string
  label: string
}

interface CwdPickerProps {
  mode: 'main' | 'task'
  org: string
  value: CwdChoice
  onChange: (choice: CwdChoice) => void
  disabled?: boolean
  /** 空会话第二行的展示形态（2026-10-27 原型 v2）：虚线大 chip，
   *  未选时文案是「选择工作区」而不是默认工作区名。 */
  hero?: boolean
}

const DEFAULT_LABEL = {
  main: 'Main Agent 工作区',
  task: '新建工作空间',
}

/** cwd chip: main agent defaults to its own cwd; tasks default to a new workspace. */
export function CwdPicker({ mode, org, value, onChange, disabled, hero }: CwdPickerProps) {
  const [open, setOpen] = useState(false)
  const [dirOpen, setDirOpen] = useState(false)
  const [browse, setBrowse] = useState<BrowseResult | null>(null)
  const [browseLoading, setBrowseLoading] = useState(false)
  const [browseError, setBrowseError] = useState<string | null>(null)
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [busy, setBusy] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  const browsePath = browse?.path

  // 切换目录后回到列表顶部，避免沿用上一个目录的滚动位置。
  useEffect(() => {
    if (browsePath && listRef.current) listRef.current.scrollTop = 0
  }, [browsePath])

  useEffect(() => {
    if (!open) return
    let alive = true
    listWorkspaces(org)
      .then((rows: Workspace[]) => { if (alive) setWorkspaces(Array.isArray(rows) ? rows : []) })
      .catch(() => { if (alive) setWorkspaces([]) })
    return () => { alive = false }
  }, [open, org])

  const options = useMemo(
    () => workspaces.filter((ws) => ws.name !== 'main-agent'),
    [workspaces],
  )

  const chooseDefault = () => {
    onChange({ kind: 'default', label: DEFAULT_LABEL[mode] })
    setOpen(false)
  }

  const chooseWorkspace = (ws: Workspace) => {
    onChange({
      kind: 'workspace',
      workspaceId: ws.id,
      path: ws.path,
      label: ws.name,
    })
    setOpen(false)
  }

  const loadDir = async (target?: string) => {
    setBrowseLoading(true)
    setBrowseError(null)
    try {
      const next = await browseDirectories(target)
      setBrowse(next)
    } catch (err: unknown) {
      setBrowseError(err instanceof Error ? err.message : '目录读取失败')
    } finally {
      setBrowseLoading(false)
    }
  }

  const openBrowser = () => {
    setOpen(false)
    setDirOpen(true)
    // 上次选过目录就从那里开始，否则从 home 开始。
    const start = value.kind === 'directory' && value.path ? value.path : undefined
    void loadDir(start)
  }

  const attachDirectory = async () => {
    if (!browse || !browse.canSelect || busy) return
    setBusy(true)
    try {
      const ws = await attachWorkspaceDirectory({ org, path: browse.path }) as Workspace
      const base = browse.path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || browse.path
      onChange({
        kind: 'directory',
        workspaceId: ws.id,
        path: ws.path,
        label: base,
      })
      setDirOpen(false)
      setOpen(false)
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : '目录注册失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            data-testid="cwd-chip"
            disabled={disabled}
            title={value.path ? `cwd: ${value.path}` : value.label}
            className={cn(
              'flex shrink-0 items-center gap-1 border transition-colors disabled:opacity-50',
              hero
                ? cn(
                    'h-[27px] rounded-[8px] px-2.5 text-[11.5px]',
                    value.kind === 'default'
                      ? 'border-dashed border-pop-bd text-pop-dim hover:border-pop-dim hover:text-pop-ink'
                      : 'border-solid border-pop-bd bg-white/[0.03] text-pop-ink',
                  )
                : 'h-[22px] rounded-[7px] border-transparent px-1.5 text-[10.5px] text-pop-dim hover:bg-pop-paper hover:text-pop-ink',
            )}
          >
            <Folder className="size-3" />
            <span className="max-w-[220px] truncate">
              {hero && value.kind === 'default' ? '选择工作区' : value.label}
            </span>
            <ChevronDown className="size-2.5 opacity-60" />
          </button>
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="start"
          sideOffset={8}
          className="w-[360px] max-w-[calc(100vw_-_24px)] overflow-hidden rounded-[14px] border-[1.5px] border-pop-bd bg-pop-paper p-0 shadow-pop"
        >
          <div className="border-b border-pop-bd/60 px-3 py-2.5">
            <div className="text-[12px] font-bold text-pop-ink">工作目录 / 工作空间</div>
            <p className="mt-0.5 text-[10px] text-pop-dim">
              {mode === 'main' ? '默认使用 Main Agent 当前 cwd；也可选择工作空间或目录。' : '默认新建工作空间；也可选择已有工作空间或目录。'}
            </p>
          </div>
          <div className="max-h-[320px] overflow-y-auto p-1.5">
            <button
              type="button"
              onClick={chooseDefault}
              className={cn(
                'flex w-full items-center gap-2 rounded-[9px] px-2 py-1.5 text-left transition-colors hover:bg-pop-bd/20',
                value.kind === 'default' && 'bg-pop-cyan-soft/40',
              )}
            >
              <span className={cn(
                'grid size-4 shrink-0 place-items-center rounded-[5px] border-[1.5px]',
                value.kind === 'default' ? 'border-pop-cyan bg-pop-cyan text-pop-bg' : 'border-pop-bd text-transparent',
              )}>
                {value.kind === 'default' && <Check className="size-2.5" />}
              </span>
              <FolderOpen className="size-3.5 shrink-0 text-pop-cyan" />
              <span className="min-w-0 flex-1">
                <span className="block text-[12px] text-pop-ink">{DEFAULT_LABEL[mode]}</span>
                <span className="block text-[10px] text-pop-dim">
                  {mode === 'main' ? '当前主 Agent cwd' : '第一次发送时创建'}
                </span>
              </span>
            </button>
            <button
              type="button"
              onClick={openBrowser}
              data-testid="cwd-browse-open"
              className="flex w-full items-center gap-2 rounded-[9px] px-2 py-1.5 text-left transition-colors hover:bg-pop-bd/20"
            >
              <span className="grid size-4 shrink-0 place-items-center rounded-[5px] border-[1.5px] border-pop-bd text-transparent" />
              <Plus className="size-3.5 shrink-0 text-pop-purple" />
              <span className="min-w-0 flex-1">
                <span className="block text-[12px] text-pop-ink">选择目录…</span>
                <span className="block text-[10px] text-pop-dim">注册为工作空间后作为 cwd</span>
              </span>
            </button>
            {options.length > 0 && (
              <div className="mt-1.5 border-t border-pop-bd/50 pt-1.5">
                <div className="px-2 pb-1 text-[10px] text-pop-dim">工作空间</div>
                {options.map((ws) => {
                  const on = value.workspaceId === ws.id
                  return (
                    <button
                      key={ws.id}
                      type="button"
                      onClick={() => chooseWorkspace(ws)}
                      className={cn(
                        'flex w-full items-center gap-2 rounded-[9px] px-2 py-1.5 text-left transition-colors hover:bg-pop-bd/20',
                        on && 'bg-pop-cyan-soft/40',
                      )}
                    >
                      <span className={cn(
                        'grid size-4 shrink-0 place-items-center rounded-[5px] border-[1.5px]',
                        on ? 'border-pop-cyan bg-pop-cyan text-pop-bg' : 'border-pop-bd text-transparent',
                      )}>
                        {on && <Check className="size-2.5" />}
                      </span>
                      <Folder className="size-3.5 shrink-0 text-pop-dim" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[12px] text-pop-ink">{ws.name}</span>
                        <span className="block truncate font-mono text-[9.5px] text-pop-dim">{ws.path}</span>
                      </span>
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        </PopoverContent>
      </Popover>

      <Dialog open={dirOpen} onOpenChange={setDirOpen}>
        <DialogContent
          showCloseButton={false}
          aria-describedby={undefined}
          className="ui-font w-[560px] max-w-[calc(100vw_-_32px)] rounded-2xl border border-white/[0.10] bg-pop-bg p-4"
        >
          <DialogTitle className="text-[14px] font-semibold text-pop-ink">选择工作目录</DialogTitle>
          <p className="mt-1 text-[11px] text-pop-dim">
            浏览并选择目录，系统敏感目录不可选；选中后会注册为一个工作空间。
          </p>

          {/* 导航条：上一级 + 当前路径 + 盘符切换（Windows） */}
          <div className="mt-3 flex items-center gap-1.5 rounded-[9px] border border-pop-bd bg-pop-paper px-2 py-1.5">
            <button
              type="button"
              aria-label="上一级"
              title="上一级"
              data-testid="cwd-browse-up"
              disabled={!browse?.parent || browseLoading}
              onClick={() => browse?.parent && void loadDir(browse.parent)}
              className="grid size-6 shrink-0 place-items-center rounded-[6px] text-pop-dim transition-colors hover:bg-white/[0.06] hover:text-pop-ink disabled:opacity-35"
            >
              <ArrowUp className="size-3.5" />
            </button>
            <span
              data-testid="cwd-browse-path"
              title={browse?.path}
              className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-pop-ink"
            >
              {browse?.path ?? '读取中…'}
            </span>
            {browse && browse.roots.length > 1 && (
              <select
                aria-label="切换磁盘"
                value=""
                onChange={(event) => {
                  if (event.target.value) void loadDir(event.target.value)
                }}
                className="h-[22px] shrink-0 cursor-pointer appearance-none rounded-[6px] border border-pop-bd bg-pop-paper px-1.5 font-mono text-[10px] text-pop-dim outline-none hover:text-pop-ink [&>option]:bg-pop-paper [&>option]:text-pop-ink"
              >
                <option value="">磁盘</option>
                {browse.roots.map((root) => (
                  <option key={root.path} value={root.path}>{root.name}</option>
                ))}
              </select>
            )}
          </div>

          {/* 目录列表 */}
          <div ref={listRef} className="mt-2 h-[260px] overflow-y-auto rounded-[9px] border border-pop-bd/70 bg-pop-paper/40 p-1" data-testid="cwd-browse-list">
            {browseLoading && !browse ? (
              <div className="flex h-full items-center justify-center gap-2 text-[11px] text-pop-dim">
                <Loader2 className="size-3.5 animate-spin" /> 读取目录…
              </div>
            ) : browseError ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 text-[11px] text-pop-dim">
                <span className="max-w-[90%] text-center text-pop-red">{browseError}</span>
                <Button size="sm" variant="ghost" onClick={() => void loadDir(browse?.path)}>重试</Button>
              </div>
            ) : browse && browse.dirs.length === 0 ? (
              <div className="flex h-full items-center justify-center text-[11px] text-pop-dim">
                没有可进入的子目录
              </div>
            ) : (
              browse?.dirs.map((dir) => (
                <button
                  key={dir.path}
                  type="button"
                  data-browse-dir={dir.name}
                  onClick={() => void loadDir(dir.path)}
                  className="flex w-full items-center gap-2 rounded-[7px] px-2 py-1.5 text-left transition-colors hover:bg-white/[0.06]"
                >
                  <Folder className="size-3.5 shrink-0 text-pop-yellow" />
                  <span className="truncate text-[12px] text-pop-ink">{dir.name}</span>
                </button>
              ))
            )}
          </div>

          <div className="mt-3 flex items-center gap-2">
            <span className="text-[10px] text-pop-dim">
              {browse?.canSelect === false ? '当前目录不可选' : '将注册为工作空间'}
            </span>
            <div className="ml-auto flex gap-2">
              <Button size="sm" variant="ghost" onClick={() => setDirOpen(false)}>取消</Button>
              <Button
                size="sm"
                variant="pop"
                data-testid="cwd-browse-select"
                disabled={!browse?.canSelect || busy || browseLoading}
                onClick={() => void attachDirectory()}
              >
                {busy ? '注册中…' : '使用此目录'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}

'use client'

import { useEffect, useMemo, useState } from 'react'
import { Check, ChevronDown, Folder, FolderOpen, Plus } from 'lucide-react'
import { toast } from 'sonner'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { attachWorkspaceDirectory, listWorkspaces } from '@/lib/api-client'
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
}

const DEFAULT_LABEL = {
  main: 'Main Agent 工作区',
  task: '新建工作空间',
}

/** cwd chip: main agent defaults to its own cwd; tasks default to a new workspace. */
export function CwdPicker({ mode, org, value, onChange, disabled }: CwdPickerProps) {
  const [open, setOpen] = useState(false)
  const [dirOpen, setDirOpen] = useState(false)
  const [path, setPath] = useState('')
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [busy, setBusy] = useState(false)

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

  const attachDirectory = async () => {
    const raw = path.trim()
    if (!raw || busy) return
    setBusy(true)
    try {
      const ws = await attachWorkspaceDirectory({ org, path: raw }) as Workspace
      onChange({
        kind: 'directory',
        workspaceId: ws.id,
        path: ws.path,
        label: raw.replace(/\/+$/, '').split('/').pop() || raw,
      })
      setDirOpen(false)
      setOpen(false)
      setPath('')
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
            className="flex h-[22px] shrink-0 items-center gap-1 rounded-[7px] border border-transparent px-1.5 text-[10.5px] text-pop-dim transition-colors hover:bg-pop-paper hover:text-pop-ink disabled:opacity-50"
          >
            <Folder className="size-3" />
            <span className="max-w-[130px] truncate">{value.label}</span>
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
              onClick={() => setDirOpen(true)}
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
          className="ui-font w-[480px] max-w-[calc(100vw_-_32px)] rounded-2xl border border-white/[0.10] bg-pop-bg p-4"
        >
          <DialogTitle className="text-[14px] font-semibold text-pop-ink">选择工作目录</DialogTitle>
          <p className="mt-1 text-[11px] text-pop-dim">输入用户 home 下的绝对路径；该目录会注册为一个工作空间。</p>
          <Input
            autoFocus
            value={path}
            onChange={(event) => setPath(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void attachDirectory()
              if (event.key === 'Escape') setDirOpen(false)
            }}
            placeholder="/Users/you/projects/my-app"
            className="mt-3 font-mono text-[12px]"
          />
          <div className="mt-4 flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setDirOpen(false)}>取消</Button>
            <Button size="sm" variant="pop" disabled={!path.trim() || busy} onClick={() => void attachDirectory()}>
              {busy ? '注册中…' : '使用该目录'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}

'use client'

// 系统式目录选择窗（plan §6.2 / design 17 §3.1）：
// 跟新建任务里的 cwd 选择同构 —— 上级 / 当前路径 / 根 / 子目录 / 选择当前目录，
// 只是多了两条舱规则：
//   · lockedPaths 命中的目录打标「已是「X舱」」；
//   · 当前目录属于某个舱时，主按钮变成「打开「X舱」」—— 一目录一舱（I3）。

import { useCallback, useEffect, useState } from 'react'
import { ArrowUp, Folder, Loader2, X } from 'lucide-react'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { browseDirectories, type BrowseResult } from '@/lib/api-client'
import { cn } from '@/lib/utils'
import './CabinCreateHero.css'

export interface DirectoryBrowserDialogProps {
  open: boolean
  initialPath?: string | null
  /** path → 舱名；命中即“这个目录已经是 X 舱”。 */
  lockedPaths: Map<string, string>
  onPick: (path: string) => void
  onOpenCabin: (cabinName: string) => void
  onClose: () => void
}

export function DirectoryBrowserDialog({
  open,
  initialPath,
  lockedPaths,
  onPick,
  onOpenCabin,
  onClose,
}: DirectoryBrowserDialogProps) {
  const [browse, setBrowse] = useState<BrowseResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [listKey, setListKey] = useState(0)

  const goto = useCallback(async (target?: string) => {
    setLoading(true)
    setError(null)
    try {
      const next = await browseDirectories(target || undefined)
      setBrowse(next)
      setListKey((k) => k + 1)
    } catch (err) {
      setError(err instanceof Error ? err.message : '目录读取失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!open) return
    setBrowse(null)
    setError(null)
    void goto(initialPath ?? undefined)
  }, [open, initialPath, goto])

  const current = browse?.path ?? null
  const lockedName = current ? lockedPaths.get(current) : undefined

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose() }}>
      <DialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        className="ui-font w-[min(520px,100%)] max-w-[calc(100vw-32px)] border-0 bg-transparent p-0 shadow-none"
      >
        <div className="cc-dlg" data-testid="cabin-dir-dialog">
          <div className="cc-dlg-h">
            <DialogTitle className="text-[12.5px] font-bold text-pop-ink">选择目录</DialogTitle>
            <button type="button" className="cc-dlg-x" aria-label="关闭" onClick={onClose}>
              <X className="size-3.5" strokeWidth={2} />
            </button>
          </div>

          <div className="cc-dlg-path">
            <button
              type="button"
              className="cc-up"
              aria-label="上级目录"
              data-testid="cabin-dir-up"
              disabled={!browse?.parent || loading}
              onClick={() => browse?.parent && void goto(browse.parent)}
            >
              <ArrowUp className="size-3.5" />
            </button>
            <span className="cc-pth" title={browse?.path} data-testid="cabin-dir-path">
              {browse?.path ?? '读取中…'}
            </span>
          </div>

          {browse && browse.roots.length > 0 && (
            <div className="cc-dlg-roots" data-testid="cabin-dir-roots">
              {browse.roots.map((root) => {
                const atRoot = current === root.path
                const underRoot = root.path !== '/' && (current ?? '').startsWith(`${root.path}/`)
                const label = root.path === browse.home ? 'Home' : root.path === '/' ? '根目录' : root.name
                return (
                  <button
                    key={root.path}
                    type="button"
                    className="cc-rt"
                    data-on={atRoot || underRoot ? 'true' : 'false'}
                    onClick={() => void goto(root.path)}
                  >
                    {label}
                  </button>
                )
              })}
            </div>
          )}

          <div className="cc-dlg-list" data-testid="cabin-dir-list">
            {loading && !browse ? (
              <div className="cc-empty flex items-center gap-2">
                <Loader2 className="size-3.5 animate-spin" /> 读取目录…
              </div>
            ) : error ? (
              <div className="cc-empty">
                <span className="text-pop-red">{error}</span>
                <button
                  type="button"
                  className="ml-2 underline decoration-dotted"
                  onClick={() => void goto(browse?.path)}
                >
                  重试
                </button>
              </div>
            ) : browse && browse.dirs.length === 0 ? (
              <div className="cc-empty">没有子目录 —— 可以直接选这一个。</div>
            ) : (
              <div key={listKey}>
                {(browse?.dirs ?? []).map((entry) => {
                  const locked = lockedPaths.get(entry.path)
                  return (
                    <button
                      key={entry.path}
                      type="button"
                      className="cc-de"
                      data-browse-dir={entry.name}
                      data-locked={locked ? 'true' : undefined}
                      onClick={() => void goto(entry.path)}
                    >
                      <Folder className="size-3.5 shrink-0 text-pop-dim" />
                      <span className="cc-p">{entry.name}</span>
                      {locked && <span className="cc-tag">已是「{locked}」</span>}
                      <span className="cc-go">进入 ›</span>
                    </button>
                  )
                })}
              </div>
            )}
          </div>

          {lockedName && (
            <div className="cc-dlg-note" data-testid="cabin-dir-note">
              这个目录已经是「{lockedName}」了 —— 一个目录只能有一个舱，不能在这里再建一个。
            </div>
          )}

          <div className="cc-dlg-f">
            <button type="button" className="cc-ghost" onClick={onClose}>取消</button>
            {lockedName ? (
              <button
                type="button"
                className="cc-send"
                data-testid="cabin-dir-open-cabin"
                onClick={() => onOpenCabin(lockedName)}
              >
                打开「{lockedName}」
              </button>
            ) : (
              <button
                type="button"
                className={cn('cc-send')}
                data-testid="cabin-dir-pick"
                disabled={!browse?.canSelect || loading}
                onClick={() => {
                  if (!browse) return
                  onPick(browse.path)
                }}
              >
                选择当前目录
              </button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
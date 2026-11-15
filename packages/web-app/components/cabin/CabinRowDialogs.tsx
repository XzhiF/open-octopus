'use client'

// 左栏作战舱行的两个弹框（2026-11-15 用户要求）：
//   · 重命名 —— 跟任务行同一个手感：⋯ 菜单 → 重命名 → 小弹框 → 保存。
//   · 删除 —— 确认弹框，默认**不勾**「同时删除本地文件」；勾上才连舱目录一起删。
// 删除是**软删除**（跟任务一样）：行留在库里，计费 / Trace / 验收历史都还能追，
// 只是左栏与接口看不见它。文案要把这件事说清楚，别让人以为账也没了。
//
// 弹框只管 UI 与本地状态；写库（PATCH / DELETE）由宿主经 onRename / onDelete 决定。

import { useEffect, useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import type { CabinDetail } from '@/lib/cabin-api'
import { CABIN_NAME_MAX } from '@/lib/cabin-draft'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'

export interface CabinRenameDialogProps {
  /** null = 关着。 */
  cabin: CabinDetail | null
  busy?: boolean
  onClose: () => void
  onSubmit: (name: string) => void
}

export function CabinRenameDialog({ cabin, busy, onClose, onSubmit }: CabinRenameDialogProps) {
  const [value, setValue] = useState('')

  // 每次打开都从当前名字起笔。
  useEffect(() => {
    if (cabin) setValue(cabin.name)
  }, [cabin])

  const name = value.trim()
  return (
    <Dialog open={!!cabin} onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        data-testid="cabin-rename-dialog"
        className="ui-font w-[420px] max-w-[calc(100vw_-_32px)] rounded-2xl border border-white/[0.10] bg-pop-bg p-4"
      >
        <DialogTitle className="text-[14px] font-semibold text-pop-ink">重命名作战舱</DialogTitle>
        <Input
          autoFocus
          data-testid="cabin-rename-input"
          value={value}
          maxLength={CABIN_NAME_MAX}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && name && !busy) onSubmit(name)
            if (event.key === 'Escape') onClose()
          }}
          className="mt-3"
          placeholder="舱名"
          aria-label="舱名"
        />
        <div className="mt-4 flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={onClose}>取消</Button>
          <Button
            size="sm"
            variant="pop"
            data-testid="cabin-rename-save"
            disabled={!name || busy}
            onClick={() => onSubmit(name)}
          >
            {busy ? '保存中…' : '保存'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

export interface CabinDeleteDialogProps {
  /** null = 关着。 */
  cabin: CabinDetail | null
  busy?: boolean
  onClose: () => void
  onConfirm: (opts: { deleteFiles: boolean }) => void
}

export function CabinDeleteDialog({ cabin, busy, onClose, onConfirm }: CabinDeleteDialogProps) {
  // 默认不勾（用户口径）：删记录不动本地文件；勾了才连目录一起删。
  const [deleteFiles, setDeleteFiles] = useState(false)

  useEffect(() => {
    if (cabin) setDeleteFiles(false)
  }, [cabin])

  return (
    <AlertDialog open={!!cabin} onOpenChange={(open) => { if (!open) onClose() }}>
      <AlertDialogContent data-testid="cabin-delete-dialog" className="ui-font max-w-[460px]">
        <AlertDialogHeader>
          <AlertDialogTitle>删除作战舱？</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2 text-[12.5px] text-pop-dim">
              <p>
                <b className="text-pop-ink">「{cabin?.name ?? ''}」</b>
                将从左栏消失。平台计费，所以这是<b>软删除</b>：计费、Trace 与验收历史都保留，可追溯。
              </p>
              {cabin?.path && (
                <p className="break-all rounded-[6px] bg-white/[0.04] px-2 py-1 font-mono text-[11px] text-pop-dim/80">
                  {cabin.path}
                </p>
              )}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>

        <label className="mt-1 flex cursor-pointer items-start gap-2.5 rounded-[8px] border border-pop-red/25 bg-pop-red/[0.06] px-2.5 py-2">
          <Checkbox
            checked={deleteFiles}
            onCheckedChange={(checked) => setDeleteFiles(checked === true)}
            data-testid="cabin-delete-files"
            className="mt-0.5 border-pop-red/50 data-[state=checked]:bg-pop-red"
            aria-label="同时删除本地文件"
          />
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="text-[12.5px] font-medium text-pop-ink">同时删除本地文件</span>
            <span className="flex items-start gap-1 text-[11px] leading-[1.5] text-pop-dim">
              <AlertTriangle className="mt-[1px] size-3 shrink-0 text-pop-red" strokeWidth={2} />
              上面的目录会被整块删除，不可恢复。默认不勾。
            </span>
          </span>
        </label>

        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>取消</AlertDialogCancel>
          <Button
            data-testid="cabin-delete-confirm"
            disabled={busy}
            onClick={() => onConfirm({ deleteFiles })}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {busy ? '删除中…' : deleteFiles ? '删除舱和文件' : '删除'}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
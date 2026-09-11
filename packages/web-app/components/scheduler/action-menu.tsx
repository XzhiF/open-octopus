"use client"

import {
  MoreHorizontal,
  Pencil,
  Play,
  Trash2,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

interface ActionMenuProps {
  jobId: string
  jobName: string
  onEdit: () => void
  onDelete: () => void
  onTrigger: () => void
  /** 票05 (ADR-0021): 内置 code-job（id 前缀 builtin-，见 lib/scheduler-api isBuiltinJob）
   *  的删除入口不渲染 —— 删掉 系统 · 任务生命周期 会静默停掉全系统任务启动，且 seed
   *  不会复活软删行。行本身照常可暂停/可手动触发。默认 true = 普通作业。 */
  deletable?: boolean
  /** SchedulerForm 只能表达 workflow/agent 两类 config；对 job_type='job'（注册好的
   *  TS handler）开编辑 = 一张填不出内容的表单，提交还会把 config 覆盖成 agent 形状。
   *  编辑入口对 'job' 行不渲染（cron 可改，但改它的 UI 还没建 —— 见票05报告）。 */
  editable?: boolean
}

export function ActionMenu({
  jobId: _jobId,
  jobName: _jobName,
  onEdit,
  onDelete,
  onTrigger,
  deletable = true,
  editable = true,
}: ActionMenuProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="操作菜单"
        >
          <MoreHorizontal className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {editable && (
          <DropdownMenuItem onClick={onEdit}>
            <Pencil className="size-4" />
            编辑
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onClick={onTrigger}>
          <Play className="size-4" />
          手动触发
        </DropdownMenuItem>
        {deletable && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              onClick={onDelete}
            >
              <Trash2 className="size-4" />
              删除
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

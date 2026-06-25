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
}

export function ActionMenu({
  jobId: _jobId,
  jobName: _jobName,
  onEdit,
  onDelete,
  onTrigger,
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
        <DropdownMenuItem onClick={onEdit}>
          <Pencil className="size-4" />
          编辑
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onTrigger}>
          <Play className="size-4" />
          手动触发
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          onClick={onDelete}
        >
          <Trash2 className="size-4" />
          删除
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

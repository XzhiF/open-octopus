import Link from "next/link"
import { cn } from "@/lib/utils"
import { Card, CardContent, CardHeader } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import type { Workspace, WorkspaceStatus, ArchiveStatus } from "@/lib/types"
import {
  FolderKanban,
  GitBranch,
  Clock,
  MoreHorizontal,
  ExternalLink,
  Settings,
  Trash2,
  ArrowRight,
  Loader2,
  Check,
  X,
} from "lucide-react"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

interface WorkspaceCardProps {
  workspace: Workspace
  onDelete?: (id: string) => void
}

const statusConfig: Record<
  WorkspaceStatus,
  { label: string; variant: "default" | "secondary" | "destructive" | "outline" }
> = {
  active: { label: "活跃", variant: "default" },
  inactive: { label: "未激活", variant: "secondary" },
  error: { label: "异常", variant: "destructive" },
}

const archiveStatusConfig: Record<
  Exclude<ArchiveStatus, "none">,
  { label: string; icon: typeof Loader2; className: string }
> = {
  archiving: {
    label: "归档中...",
    icon: Loader2,
    className: "text-archive-archiving border-archive-archiving/40 bg-archive-archiving/10",
  },
  archived: {
    label: "已归档",
    icon: Check,
    className: "text-archive-archived border-archive-archived/40 bg-archive-archived/10",
  },
  archive_failed: {
    label: "归档失败",
    icon: X,
    className: "text-archive-failed border-archive-failed/40 bg-archive-failed/10",
  },
}

function formatRelativeTime(dateString: string | null | undefined): string {
  if (!dateString) return "未知"
  const date = new Date(dateString)
  if (isNaN(date.getTime())) return "未知"
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMins = Math.floor(diffMs / 60000)
  const diffHours = Math.floor(diffMins / 60)
  const diffDays = Math.floor(diffHours / 24)

  if (diffMins < 1) return "刚刚"
  if (diffMins < 60) return `${diffMins} 分钟前`
  if (diffHours < 24) return `${diffHours} 小时前`
  if (diffDays < 7) return `${diffDays} 天前`
  return date.toLocaleDateString("zh-CN")
}

export function WorkspaceCard({ workspace, onDelete }: WorkspaceCardProps) {
  const config = statusConfig[workspace.status]
  const archiveStatus = workspace.archive_status
  const archiveConfig =
    archiveStatus && archiveStatus !== "none"
      ? archiveStatusConfig[archiveStatus]
      : null

  return (
    <Card className="group relative transition-shadow hover:shadow-md">
      <CardHeader className="py-2 pb-0">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
              <FolderKanban className="h-5 w-5 text-primary" />
            </div>
            <div>
              <Link
                href={`/workspaces/${workspace.id}`}
                className="font-semibold hover:underline"
              >
                {workspace.name}
              </Link>
              <p className="text-sm text-muted-foreground line-clamp-1">
                {workspace.description}
              </p>
            </div>
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 opacity-0 transition-opacity group-hover:opacity-100"
              >
                <MoreHorizontal className="h-4 w-4" />
                <span className="sr-only">更多操作</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem asChild>
                <Link href={`/workspaces/${workspace.id}`}>
                  <ExternalLink className="mr-2 h-4 w-4" />
                  打开工作空间
                </Link>
              </DropdownMenuItem>
              <DropdownMenuItem>
                <Settings className="mr-2 h-4 w-4" />
                设置
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className={cn(
                  "text-destructive",
                  workspace.archive_status === "archiving" && "opacity-50 pointer-events-none",
                )}
                disabled={workspace.archive_status === "archiving"}
                onClick={() => onDelete?.(workspace.id)}
              >
                <Trash2 className="mr-2 h-4 w-4" />
                删除
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        {/* Stats */}
        <div className="flex items-center gap-4 text-sm text-muted-foreground">
          <div className="flex items-center gap-1.5">
            <FolderKanban className="h-3.5 w-3.5" />
            <span>{workspace.projectCount} 项目</span>
          </div>
          <div className="flex items-center gap-1.5">
            <GitBranch className="h-3.5 w-3.5" />
            <span>{workspace.workflowCount} 工作流</span>
          </div>
        </div>

        {/* Org & Path */}
        <div className="mt-2 flex items-center gap-4 text-xs text-muted-foreground">
          <span>org: {workspace.org}</span>
          <span>{workspace.path}</span>
        </div>

        {/* Footer */}
        <div className="mt-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Badge variant={config.variant}>{config.label}</Badge>
            {archiveConfig && (
              <Badge
                variant="outline"
                className={cn(
                  archiveConfig.className,
                  archiveStatus === "archiving" && "animate-pulse",
                )}
                title={
                  archiveStatus === "archive_failed" && workspace.archive_error
                    ? workspace.archive_error
                    : undefined
                }
              >
                <archiveConfig.icon
                  className={cn(
                    "h-3 w-3",
                    archiveStatus === "archiving" && "animate-spin",
                  )}
                />
                {archiveConfig.label}
              </Badge>
            )}
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <Clock className="h-3 w-3" />
              {formatRelativeTime(workspace.lastActivityAt ?? (workspace as unknown as Record<string, string>).created_at)}
            </span>
          </div>
          <Button variant="ghost" size="sm" asChild className="gap-1">
            <Link href={`/workspaces/${workspace.id}`}>
              进入
              <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

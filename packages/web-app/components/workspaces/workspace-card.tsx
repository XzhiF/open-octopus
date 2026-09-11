import Link from "next/link"
import { Card, CardContent, CardHeader } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import type { Workspace, WorkspaceStatus } from "@/lib/types"
import { formatRelativeTime } from "@/lib/format"
import {
  FolderKanban,
  GitBranch,
  Clock,
  MoreHorizontal,
  ExternalLink,
  Settings,
  Trash2,
  ArrowRight,
  Archive,
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
  onArchive?: (id: string) => void
  onViewArchive?: (id: string) => void
}

const statusConfig: Record<
  WorkspaceStatus,
  { label: string; variant: "default" | "secondary" | "destructive" | "outline" }
> = {
  active: { label: "活跃", variant: "default" },
  inactive: { label: "未激活", variant: "secondary" },
  error: { label: "异常", variant: "destructive" },
}

export function WorkspaceCard({ workspace, onDelete, onArchive, onViewArchive }: WorkspaceCardProps) {
  const config = statusConfig[workspace.status] ?? { label: workspace.status, variant: "outline" as const }
  const isArchived = (workspace as any).archive_status === "archived"
  const runningCount = workspace.running_count ?? 0
  const isRunning = runningCount > 0 && !isArchived
  const cardHref = isArchived
    ? `/workspaces/${workspace.id}/archive-detail`
    : `/workspaces/${workspace.id}`

  return (
    <Card className={`group relative transition-shadow hover:shadow-md ${isArchived ? "opacity-75" : ""} ${isRunning ? "marching-ants-border" : ""}`} data-testid="workspace-card">
      <CardHeader className="py-2 pb-0">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
              <FolderKanban className="h-5 w-5 text-primary" />
            </div>
            <div>
              <Link
                href={cardHref}
                className="font-semibold hover:underline"
              >
                {workspace.name}
              </Link>
              <p className="text-sm text-muted-foreground line-clamp-1">
                {workspace.description}
              </p>
            </div>
          </div>
          {!isArchived && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 opacity-0 transition-opacity group-hover:opacity-100"
                  data-testid="workspace-action-menu"
                >
                  <MoreHorizontal className="h-4 w-4" />
                  <span className="sr-only">更多操作</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem asChild>
                  <Link href={cardHref}>
                    <ExternalLink className="mr-2 h-4 w-4" />
                    打开工作空间
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem data-testid="workspace-action-settings">
                  <Settings className="mr-2 h-4 w-4" />
                  设置
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => onArchive?.(workspace.id)}>
                  <Archive className="mr-2 h-4 w-4" />
                  归档
                </DropdownMenuItem>
                <DropdownMenuItem className="text-destructive" onClick={() => onDelete?.(workspace.id)} data-testid="workspace-action-delete">
                  <Trash2 className="mr-2 h-4 w-4" />
                  删除
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
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
            <Badge variant={config.variant} data-testid="workspace-status-badge">{config.label}</Badge>
            {isRunning && (
              <Badge
                className="border-pop-amber/40 bg-pop-amber/10 text-pop-amber"
                data-testid="workspace-running-badge"
              >
                运行中 {runningCount}
              </Badge>
            )}
            {isArchived && (
              <Badge variant="secondary" className="text-xs">
                <Archive className="mr-1 h-3 w-3" />
                已归档
              </Badge>
            )}
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <Clock className="h-3 w-3" />
              {formatRelativeTime(workspace.lastActivityAt ?? (workspace as unknown as Record<string, string>).created_at)}
            </span>
          </div>
          {isArchived ? (
            <Button variant="ghost" size="sm" onClick={() => onViewArchive?.(workspace.id)} className="gap-1">
              查看
              <ArrowRight className="h-3.5 w-3.5" />
            </Button>
          ) : (
            <Button variant="ghost" size="sm" asChild className="gap-1" data-testid="workspace-action-enter">
              <Link href={cardHref}>
                进入
                <ArrowRight className="h-3.5 w-3.5" />
              </Link>
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

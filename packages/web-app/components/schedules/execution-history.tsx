"use client"

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Button } from "@/components/ui/button"
import { RefreshCw } from "lucide-react"
import type { ScheduleExecution } from "@/lib/types"
import { ExecutionStatusBadge } from "./execution-status-badge"
import { EmptyExecutionHistory } from "./empty-states"

interface Props {
  executions: ScheduleExecution[]
  total: number
  page: number
  pageSize: number
  loading: boolean
  onPageChange: (page: number) => void
  onRetry: (executionId: string) => Promise<unknown>
}

function formatDuration(ms: number | null): string {
  if (ms === null) return "-"
  if (ms < 1000) return `${ms}ms`
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remaining = seconds % 60
  return `${minutes}m ${remaining}s`
}

export function ExecutionHistory({
  executions,
  total,
  page,
  pageSize,
  loading,
  onPageChange,
  onRetry,
}: Props) {
  const totalPages = Math.ceil(total / pageSize)

  if (!loading && executions.length === 0) {
    return <EmptyExecutionHistory />
  }

  return (
    <div className="space-y-4">
      <Table aria-label="Execution history">
        <TableHeader>
          <TableRow>
            <TableHead>Triggered At</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>Duration</TableHead>
            <TableHead className="w-[80px]">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {executions.map((exec) => (
            <TableRow key={exec.id}>
              <TableCell className="text-sm">
                {new Date(exec.triggered_at).toLocaleString()}
              </TableCell>
              <TableCell>
                <ExecutionStatusBadge status={exec.status} />
              </TableCell>
              <TableCell className="text-sm capitalize text-muted-foreground">
                {exec.trigger_type}
              </TableCell>
              <TableCell className="text-sm text-muted-foreground">
                {formatDuration(exec.duration_ms)}
              </TableCell>
              <TableCell>
                {exec.status === "failed" && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => onRetry(exec.id)}
                    className="h-7"
                  >
                    <RefreshCw className="mr-1 h-3 w-3" />
                    Retry
                  </Button>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            Page {page} of {totalPages} ({total} total)
          </p>
          <div className="flex gap-1">
            <Button
              variant="outline"
              size="sm"
              disabled={page <= 1}
              onClick={() => onPageChange(page - 1)}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= totalPages}
              onClick={() => onPageChange(page + 1)}
            >
              Next
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

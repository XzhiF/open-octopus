"use client"

import { useState, useEffect, useCallback } from "react"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Button } from "@/components/ui/button"
import { Plus, Search, RefreshCw, History, Shield } from "lucide-react"
import { Input } from "@/components/ui/input"
import { useSchedules } from "@/hooks/use-schedules"
import { useSchedulePermissions } from "@/hooks/use-schedule-permissions"
import { listScheduleAuditLogs } from "@/lib/schedule-api"
import { fetchWorkflows } from "@/lib/api-client"
import type { Schedule, ScheduleAuditLog, CreateScheduleInput, WorkflowOption } from "@/lib/types"
import { ScheduleList } from "./schedule-list"
import { ScheduleForm } from "./schedule-form"
import { ScheduleDetail } from "./schedule-detail"
import { AuditLogTable } from "./audit-log-table"
import { EmergencyStopButton } from "./emergency-stop-button"
import { MissedAlertBanner } from "./missed-alert-banner"

interface Props {
  workspaceId: string
}

export function ScheduleTab({ workspaceId }: Props) {
  const { schedules, loading, refresh, create, update, remove, toggle, trigger } =
    useSchedules(workspaceId)
  const permissions = useSchedulePermissions(workspaceId)

  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<Schedule | null>(null)
  const [selected, setSelected] = useState<Schedule | null>(null)
  const [workflows, setWorkflows] = useState<WorkflowOption[]>([])
  const [search, setSearch] = useState("")

  // Audit log state
  const [auditLogs, setAuditLogs] = useState<ScheduleAuditLog[]>([])
  const [auditLoading, setAuditLoading] = useState(false)

  // Load workflows for the form
  useEffect(() => {
    fetchWorkflows(workspaceId).then((data: unknown[]) => {
      const mapped = (data as Array<{ ref?: string; id?: string; name?: string; path?: string; group?: string }>).map((wf) => ({
        value: wf.ref ?? wf.path ?? wf.id ?? "", label: wf.name ?? "", name: wf.name ?? "",
        group: (wf.group as "built-in" | "local") ?? "local",
      })).filter((wf) => wf.value !== "")
      setWorkflows(mapped)
    }).catch(() => setWorkflows([]))
  }, [workspaceId])

  // Load audit logs
  const loadAuditLogs = useCallback(async () => {
    setAuditLoading(true)
    try {
      const data = await listScheduleAuditLogs(workspaceId)
      setAuditLogs(data.items)
    } catch {
      setAuditLogs([])
    } finally {
      setAuditLoading(false)
    }
  }, [workspaceId])

  useEffect(() => {
    loadAuditLogs()
  }, [loadAuditLogs])

  // Missed schedules alert — only show for schedules that actually have missed executions
  // (B2 fix: previously every newly-created schedule with null missed_alert_dismissed_at showed the banner)
  const missedSchedules = schedules.filter(
    (s) => !s.missed_alert_dismissed_at && (s.missed_execution_count ?? 0) > 0
  )

  const handleCreate = async (data: CreateScheduleInput) => {
    await create(data)
    refresh()
    loadAuditLogs()
  }
  const handleEdit = async (data: CreateScheduleInput) => {
    if (!editing) return
    await update(editing.id, data)
    setEditing(null)
    refresh()
    loadAuditLogs()
  }
  const handleDelete = async (id: string) => {
    await remove(id)
    if (selected?.id === id) setSelected(null)
    refresh()
    loadAuditLogs()
  }

  const handleEditClick = (schedule: Schedule) => {
    setEditing(schedule)
    setFormOpen(true)
  }
  // Filter schedules by search
  const filtered = search
    ? schedules.filter(
        (s) =>
          s.name.toLowerCase().includes(search.toLowerCase()) ||
          s.workflow_ref.toLowerCase().includes(search.toLowerCase())
      )
    : schedules

  // Detail view
  if (selected) {
    return (
      <ScheduleDetail
        schedule={selected}
        wsId={workspaceId}
        onToggle={toggle}
        onTrigger={trigger}
        onEdit={handleEditClick}
        onDelete={handleDelete}
        onBack={() => {
          setSelected(null)
          refresh()
        }}
      />
    )
  }

  return (
    <div className="space-y-4">
      {/* Missed Alerts */}
      {missedSchedules.slice(0, 2).map((s) => (
        <MissedAlertBanner
          key={s.id}
          schedule={s}
          wsId={workspaceId}
          onDismissed={refresh}
        />
      ))}

      <Tabs defaultValue="schedules">
        <div className="flex items-center justify-between">
          <TabsList aria-label="Schedule management sections">
            <TabsTrigger value="schedules" className="gap-1.5">
              <History className="h-3.5 w-3.5" />
              Schedules
            </TabsTrigger>
            <TabsTrigger value="audit" className="gap-1.5">
              <Shield className="h-3.5 w-3.5" />
              Audit Log
            </TabsTrigger>
          </TabsList>

          <div className="flex items-center gap-2">
            <EmergencyStopButton wsId={workspaceId} onStopped={refresh} />
          </div>
        </div>

        <TabsContent value="schedules" className="mt-4 space-y-4">
          {/* Toolbar */}
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search schedules..."
                aria-label="Search schedules"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-8"
              />
            </div>
            <Button variant="outline" size="sm" onClick={refresh}>
              <RefreshCw className="mr-1 h-3.5 w-3.5" />
              Refresh
            </Button>
            {permissions.canCreate && (
              <Button size="sm" onClick={() => { setEditing(null); setFormOpen(true) }}>
                <Plus className="mr-1 h-3.5 w-3.5" />
                New Schedule
              </Button>
            )}
          </div>

          <ScheduleList
            schedules={filtered}
            loading={loading}
            onToggle={toggle}
            onTrigger={trigger}
            onEdit={handleEditClick}
            onDelete={handleDelete}
            onSelect={setSelected}
            onCreateClick={() => { setEditing(null); setFormOpen(true) }}
          />
        </TabsContent>

        <TabsContent value="audit" className="mt-4">
          <AuditLogTable logs={auditLogs} loading={auditLoading} />
        </TabsContent>
      </Tabs>

      {/* Create/Edit Form */}
      <ScheduleForm
        open={formOpen}
        onOpenChange={(open) => { setFormOpen(open); if (!open) setEditing(null) }}
        onSubmit={editing ? handleEdit : handleCreate}
        workflows={workflows}
        editing={editing}
      />
    </div>
  )
}

"use client"

import { useState } from "react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { CronInput } from "./cron-input"
import { NaturalLanguageInput } from "./natural-language-input"
import type { Schedule, CreateScheduleInput, WorkflowOption } from "@/lib/types"
import { ChevronDown, Loader2 } from "lucide-react"

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (data: CreateScheduleInput) => Promise<void>
  workflows: WorkflowOption[]
  editing?: Schedule | null
}

const TIMEZONES = ["Asia/Shanghai", "Asia/Tokyo", "America/New_York", "America/Los_Angeles", "Europe/London", "Europe/Berlin", "UTC"]

export function ScheduleForm({ open, onOpenChange, onSubmit, workflows, editing }: Props) {
  const [name, setName] = useState(editing?.name ?? "")
  const [workflowRef, setWorkflowRef] = useState(editing?.workflow_ref ?? "")
  const [cronExpression, setCronExpression] = useState(editing?.cron_expression ?? "")
  const [timezone, setTimezone] = useState(editing?.timezone ?? "Asia/Shanghai")
  const [cronMode, setCronMode] = useState<"manual" | "natural">("manual")
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [timeoutValue, setTimeoutValue] = useState(String(editing?.timeout_seconds ?? 300))
  const [notifyOnFailure, setNotifyOnFailure] = useState(editing?.notify_on_failure ?? true)
  const [notifyChannel, setNotifyChannel] = useState<string>(editing?.notify_channel ?? "")
  const [notifyTarget, setNotifyTarget] = useState<string>(editing?.notify_target ?? "")
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async () => {
    setError(null)

    // I8 fix: validate timeout range before submission
    const timeoutNum = Number(timeoutValue)
    if (!Number.isFinite(timeoutNum) || timeoutNum < 60 || timeoutNum > 86400) {
      setError("Timeout must be between 60 and 86400 seconds")
      return
    }

    // B3 fix: validate notify fields when notify_on_failure is enabled
    if (notifyOnFailure && (!notifyChannel || !notifyTarget)) {
      setError("Please select a notification channel and enter a target when notifications are enabled")
      return
    }

    setSubmitting(true)
    try {
      await onSubmit({
        name,
        workflow_ref: workflowRef,
        cron_expression: cronExpression,
        timezone,
        timeout_seconds: timeoutNum,
        notify_on_failure: notifyOnFailure,
        ...(notifyOnFailure ? { notify_channel: notifyChannel, notify_target: notifyTarget } : {}),
      })
      onOpenChange(false)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to save schedule")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit Schedule" : "Create Schedule"}</DialogTitle>
          <DialogDescription>
            {editing ? "Update the schedule configuration." : "Configure a new automated schedule for your workflow."}
          </DialogDescription>
        </DialogHeader>

        {error && (
          <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}

        <div className="space-y-4 py-2">
          {/* Name */}
          <div className="space-y-2">
            <Label htmlFor="schedule-name">Name</Label>
            <Input
              id="schedule-name"
              placeholder="My Schedule"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          {/* Workflow */}
          <div className="space-y-2">
            <Label>Workflow</Label>
            <Select value={workflowRef} onValueChange={setWorkflowRef}>
              <SelectTrigger>
                <SelectValue placeholder="Select a workflow" />
              </SelectTrigger>
              <SelectContent>
                {workflows.filter((wf) => wf.value).map((wf) => (
                  <SelectItem key={wf.value} value={wf.value}>
                    {wf.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Cron Mode Toggle */}
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant={cronMode === "manual" ? "default" : "outline"}
                size="sm"
                onClick={() => setCronMode("manual")}
              >
                Manual
              </Button>
              <Button
                type="button"
                variant={cronMode === "natural" ? "default" : "outline"}
                size="sm"
                onClick={() => setCronMode("natural")}
              >
                Natural Language
              </Button>
            </div>

            {cronMode === "manual" ? (
              <CronInput
                value={cronExpression}
                onChange={setCronExpression}
                timezone={timezone}
              />
            ) : (
              <NaturalLanguageInput onResult={setCronExpression} />
            )}
          </div>

          {/* Timezone */}
          <div className="space-y-2">
            <Label>Timezone</Label>
            <Select value={timezone} onValueChange={setTimezone}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TIMEZONES.map((tz) => (
                  <SelectItem key={tz} value={tz}>
                    {tz}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Advanced Settings */}
          <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
            <CollapsibleTrigger className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
              <ChevronDown className={`h-4 w-4 transition-transform ${advancedOpen ? "rotate-0" : "-rotate-90"}`} />
              Advanced Settings
            </CollapsibleTrigger>
            <CollapsibleContent className="mt-3 space-y-4 pl-1">
              <div className="space-y-2">
                <Label htmlFor="timeout">Timeout (seconds)</Label>
                <Input
                  id="timeout"
                  type="number"
                  min={60}
                  value={timeoutValue}
                  onChange={(e) => setTimeoutValue(e.target.value)}
                />
              </div>
              <div className="flex items-center justify-between">
                <Label htmlFor="notify">Notify on failure</Label>
                <Switch
                  id="notify"
                  checked={notifyOnFailure}
                  onCheckedChange={setNotifyOnFailure}
                />
              </div>
              {notifyOnFailure && (
                <>
                  <div className="space-y-2">
                    <Label>Notification Channel</Label>
                    <Select value={notifyChannel} onValueChange={setNotifyChannel}>
                      <SelectTrigger>
                        <SelectValue placeholder="Select channel" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="telegram">Telegram</SelectItem>
                        <SelectItem value="slack">Slack</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="notify-target">Notification Target</Label>
                    <Input
                      id="notify-target"
                      placeholder="Chat ID or Webhook URL"
                      value={notifyTarget}
                      onChange={(e) => setNotifyTarget(e.target.value)}
                    />
                  </div>
                </>
              )}
            </CollapsibleContent>
          </Collapsible>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={submitting || !name || !workflowRef || !cronExpression}
          >
            {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {editing ? "Save" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

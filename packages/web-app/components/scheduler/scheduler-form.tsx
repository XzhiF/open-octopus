"use client"

import { useState, useEffect, useCallback } from "react"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { z } from "zod"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type { SchedulerJob, JobType } from "@/lib/scheduler-api"
import type { WorkflowConfig, AgentConfig } from "@/lib/scheduler-api"
import { useSchedulerSubmit } from "@/hooks/use-scheduler-submit"
import { JobTypeTabs } from "./job-type-tabs"
import { CronInput } from "./cron-input"
import { CronPreview } from "./cron-preview"
import { WorkflowScheduleForm } from "./workflow-schedule-form"
import type { SelectedProject } from "./project-selector"
import type { ChainStep } from "./workflow-chain-dialog"
import { AgentFields } from "./agent-form-fields"
import { Loader2 } from "lucide-react"

interface SchedulerFormProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  editingJob?: SchedulerJob | null
  onSuccess: () => void
}

const workflowSchema = z.object({
  name: z.string().min(1, "名称不能为空").max(200, "名称最多 200 字符"),
  cron_expression: z.string().min(1, "Cron 表达式不能为空"),
  timezone: z.string().min(1, "请选择时区"),
  org: z.string().min(1, "请填写组织"),
  parallel_policy: z.enum(["allow", "wait", "skip"]),
  workflow_config_json: z.string().optional(),
  description: z.string().max(1000).optional(),
})

const agentSchema = z.object({
  name: z.string().min(1, "名称不能为空").max(200, "名称最多 200 字符"),
  cron_expression: z.string().min(1, "Cron 表达式不能为空"),
  timezone: z.string().min(1, "请选择时区"),
  prompt: z.string().min(1, "Prompt 不能为空").max(10000),
  model: z.string(),
  timeout: z.coerce.number().min(10).max(3600),
  retry_attempts: z.coerce.number().min(0).max(5),
  parallel_policy: z.enum(["allow", "wait", "skip"]),
  description: z.string().max(1000).optional(),
})

type FormValues = z.infer<typeof workflowSchema> & z.infer<typeof agentSchema>

const COMMON_TIMEZONES = [
  "Asia/Shanghai", "Asia/Hong_Kong", "Asia/Taipei", "Asia/Tokyo", "Asia/Seoul",
  "Asia/Singapore", "Asia/Kuala_Lumpur", "Asia/Bangkok", "Asia/Jakarta",
  "Asia/Kolkata", "Asia/Dubai", "Asia/Istanbul",
  "Europe/London", "Europe/Berlin", "Europe/Paris", "Europe/Amsterdam",
  "Europe/Moscow",
  "America/New_York", "America/Chicago", "America/Denver",
  "America/Los_Angeles", "America/Toronto", "America/Vancouver",
  "America/Sao_Paulo", "America/Argentina/Buenos_Aires",
  "Australia/Sydney", "Australia/Melbourne", "Pacific/Auckland",
  "UTC",
]

function getLocalTimezone(): string {
  if (typeof window !== "undefined") {
    return Intl.DateTimeFormat().resolvedOptions().timeZone
  }
  return "Asia/Shanghai"
}

const DEFAULT_VALUES: FormValues = {
  name: "", cron_expression: "", timezone: getLocalTimezone(),
  org: "", parallel_policy: "skip",
  workflow_config_json: "", description: "", prompt: "",
  model: "default", timeout: 300, retry_attempts: 0,
}

export function SchedulerForm({
  open, onOpenChange, editingJob, onSuccess,
}: SchedulerFormProps) {
  const [jobType, setJobType] = useState<JobType>("workflow")
  const [showDirtyConfirm, setShowDirtyConfirm] = useState(false)
  const isEdit = !!editingJob

  // Visual mode state for workflow type
  const [projects, setProjects] = useState<SelectedProject[]>([])
  const [chain, setChain] = useState<ChainStep[]>([])
  const [maxRetain, setMaxRetain] = useState(10)
  const [branchPrefix, setBranchPrefix] = useState("")
  const [jsonMode, setJsonMode] = useState(false)

  const handleClose = useCallback(() => {
    onOpenChange(false)
  }, [onOpenChange])

  const { submit, submitting, configError } = useSchedulerSubmit({
    jobType,
    isEdit,
    editingJob,
    onSuccess,
    onClose: handleClose,
  })

  const form = useForm<FormValues>({
    resolver: zodResolver(jobType === "workflow" ? workflowSchema : agentSchema),
    defaultValues: DEFAULT_VALUES,
  })

  const { formState, reset, watch } = form
  const isDirty = formState.isDirty

  useEffect(() => {
    if (editingJob) {
      setJobType(editingJob.job_type)
      const values: Partial<FormValues> = {
        name: editingJob.name,
        cron_expression: editingJob.cron_expression,
        timezone: editingJob.timezone,
        org: editingJob.org ?? "",
        parallel_policy: editingJob.parallel_policy,
        description: editingJob.description ?? "",
      }
      if (editingJob.job_type === "workflow") {
        values.workflow_config_json = JSON.stringify(editingJob.config, null, 2)
        // Populate visual state from config
        const config = editingJob.config as WorkflowConfig
        if (config.workspace_spec?.projects) {
          setProjects(
            config.workspace_spec.projects.map((p) => ({
              name: p.name,
              source_path: p.source_path ?? "",
              group: "",
            }))
          )
          setBranchPrefix(config.workspace_spec.branch_prefix ?? "")
        }
        if (config.workflow_chain) {
          setChain(
            config.workflow_chain.map((item) => ({
              workflow_ref: item.workflow_ref,
              input_values: item.input_values ?? {},
              _label: item.workflow_ref,
            }))
          )
        }
        setMaxRetain(config.max_retain ?? 10)
        setJsonMode(false)
      } else {
        const config = editingJob.config as AgentConfig
        values.prompt = config.prompt ?? ""
        values.model = config.model ?? "default"
        values.timeout = config.timeout_seconds ?? 300
        values.retry_attempts = config.retry_policy?.max_attempts ?? 0
      }
      reset(values as FormValues)
    } else {
      setJobType("workflow")
      reset(DEFAULT_VALUES)
    }
  }, [editingJob, reset])

  const handleDialogClose = useCallback(() => {
    if (isDirty) setShowDirtyConfirm(true)
    else onOpenChange(false)
  }, [isDirty, onOpenChange])

  // Build v2.0 config from visual state
  const buildWorkflowConfig = useCallback(() => {
    return {
      schema_version: "2.0",
      type: "workflow",
      workspace_spec: {
        org: form.watch("org") || "",
        branch_prefix: branchPrefix,
        projects: projects.map((p) => ({
          name: p.name,
          source_path: p.source_path,
        })),
      },
      workflow_chain: chain.map((step) => ({
        workflow_ref: step.workflow_ref,
        input_values: step.input_values,
      })),
      max_retain: maxRetain,
    }
  }, [form, projects, chain, maxRetain, branchPrefix])

  // Wrap submit to build config from visual state when not in JSON mode
  const handleFormSubmit = useCallback(
    (data: any) => {
      if (jobType === "workflow" && !jsonMode) {
        const config = buildWorkflowConfig()
        data.workflow_config_json = JSON.stringify(config)
      }
      return submit(data)
    },
    [jobType, jsonMode, buildWorkflowConfig, submit]
  )

  const handleJsonModeToggle = useCallback(() => {
    if (!jsonMode) {
      // Visual → JSON: serialize current visual state
      const config = buildWorkflowConfig()
      form.setValue("workflow_config_json", JSON.stringify(config, null, 2), {
        shouldDirty: true,
      })
    }
    setJsonMode(!jsonMode)
  }, [jsonMode, buildWorkflowConfig, form])

  const cronValue = watch("cron_expression")
  const tzValue = watch("timezone")
  const promptValue = watch("prompt")
  const configJsonValue = watch("workflow_config_json")
  const orgValue = watch("org")

  return (
    <>
      <Dialog open={open} onOpenChange={handleDialogClose}>
        <DialogContent
          className="max-h-[85vh] w-full max-w-[860px] sm:max-w-[860px] overflow-y-auto"
          onPointerDownOutside={(e) => {
            if (isDirty) { e.preventDefault(); setShowDirtyConfirm(true) }
          }}
        >
          <DialogHeader>
            <DialogTitle>{isEdit ? "编辑调度任务" : "创建调度任务"}</DialogTitle>
            <DialogDescription>
              {isEdit ? "修改调度配置并保存" : "配置新的定时调度任务"}
            </DialogDescription>
          </DialogHeader>

          <Form {...form}>
            <form onSubmit={form.handleSubmit(handleFormSubmit)} className="space-y-4">
              <JobTypeTabs
                value={jobType} onChange={setJobType}
                disabled={submitting || isEdit}
              />

              <FormField
                control={form.control} name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>名称</FormLabel>
                    <FormControl>
                      <Input {...field} placeholder="调度任务名称"
                        disabled={submitting} maxLength={200} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {jobType === "workflow" && (
                <WorkflowScheduleForm
                  control={form.control as any}
                  submitting={submitting}
                  projects={projects}
                  onProjectsChange={setProjects}
                  chain={chain}
                  onChainChange={setChain}
                  maxRetain={maxRetain}
                  onMaxRetainChange={setMaxRetain}
                  branchPrefix={branchPrefix}
                  onBranchPrefixChange={setBranchPrefix}
                  orgValue={orgValue}
                  jsonMode={jsonMode}
                  onJsonModeToggle={handleJsonModeToggle}
                  configValue={configJsonValue ?? ""}
                  onConfigChange={(v) =>
                    form.setValue("workflow_config_json", v, { shouldDirty: true })
                  }
                  configError={configError}
                />
              )}

              {jobType === "agent" && (
                <AgentFields
                  control={form.control as any} submitting={submitting}
                  promptValue={promptValue ?? ""}
                />
              )}

              <FormField
                control={form.control} name="cron_expression"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Cron 表达式</FormLabel>
                    <FormControl>
                      <CronInput value={field.value} onChange={field.onChange}
                        error={formState.errors.cron_expression?.message}
                        disabled={submitting} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <CronPreview expression={cronValue ?? ""} timezone={tzValue ?? ""} />

              <FormField
                control={form.control} name="timezone"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>时区</FormLabel>
                    <Select value={field.value} onValueChange={field.onChange}
                      disabled={submitting}>
                      <FormControl>
                        <SelectTrigger className="w-full">
                          <SelectValue placeholder="选择时区" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {COMMON_TIMEZONES.map((tz) => (
                          <SelectItem key={tz} value={tz}>{tz}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control} name="description"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>描述 (可选)</FormLabel>
                    <FormControl>
                      <Textarea {...field} placeholder="任务描述..."
                        disabled={submitting} maxLength={1000}
                        className="min-h-[60px]" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <div className="flex justify-end gap-2 pt-2">
                <Button type="button" variant="outline"
                  onClick={handleDialogClose} disabled={submitting}>
                  取消
                </Button>
                <Button type="submit" disabled={submitting}>
                  {submitting && <Loader2 className="size-4 animate-spin" />}
                  {submitting
                    ? isEdit ? "保存中..." : "创建中..."
                    : isEdit ? "保存" : "创建"}
                </Button>
              </div>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      <Dialog open={showDirtyConfirm} onOpenChange={setShowDirtyConfirm}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>未保存的更改</DialogTitle>
            <DialogDescription>
              你有未保存的更改，确定要放弃吗？
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button variant="outline"
              onClick={() => setShowDirtyConfirm(false)}>
              继续编辑
            </Button>
            <Button variant="destructive" onClick={() => {
              setShowDirtyConfirm(false)
              onOpenChange(false)
            }}>
              放弃更改
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}

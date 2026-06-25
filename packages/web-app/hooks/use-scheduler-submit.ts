"use client"

import { useState, useCallback } from "react"
import { useToast } from "@/hooks/use-toast"
import {
  createJob,
  updateJob,
  type SchedulerJob,
  type JobType,
  type ParallelPolicy,
  type WorkflowConfig,
  type AgentConfig,
  type JobConfig,
} from "@/lib/scheduler-api"

interface SubmitInput {
  name: string
  cron_expression: string
  timezone: string
  org?: string
  parallel_policy?: string
  workflow_config_json?: string
  description?: string
  max_retain?: number
  prompt?: string
  model?: string
  timeout?: number
  retry_attempts?: number
}

interface UseSchedulerSubmitOptions {
  jobType: JobType
  isEdit: boolean
  editingJob?: SchedulerJob | null
  onSuccess: () => void
  onClose: () => void
}

export function useSchedulerSubmit({
  jobType,
  isEdit,
  editingJob,
  onSuccess,
  onClose,
}: UseSchedulerSubmitOptions) {
  const { toast } = useToast()
  const [submitting, setSubmitting] = useState(false)
  const [configError, setConfigError] = useState<string | null>(null)

  const submit = useCallback(
    async (data: SubmitInput) => {
      setSubmitting(true)
      setConfigError(null)

      try {
        if (jobType === "workflow") {
          let config: WorkflowConfig
          if (data.workflow_config_json?.trim()) {
            try {
              config = JSON.parse(data.workflow_config_json) as WorkflowConfig
            } catch {
              setConfigError("无效的 JSON 格式")
              setSubmitting(false)
              return
            }
          } else if (editingJob?.config?.type === "workflow") {
            config = editingJob.config as WorkflowConfig
          } else {
            setConfigError("请配置工作流参数")
            setSubmitting(false)
            return
          }

          if (isEdit && editingJob) {
            await updateJob(
              editingJob.id,
              {
                name: data.name,
                cron_expression: data.cron_expression,
                timezone: data.timezone,
                config,
                parallel_policy: data.parallel_policy as ParallelPolicy | undefined,
                description: data.description || undefined,
              },
              editingJob.version
            )
            toast({ title: "调度任务已更新" })
          } else {
            await createJob({
              name: data.name,
              job_type: "workflow",
              cron_expression: data.cron_expression,
              timezone: data.timezone,
              org: data.org || config.workspace_spec?.org,
              config,
              parallel_policy: (data.parallel_policy ?? "skip") as ParallelPolicy,
              description: data.description || undefined,
            })
            toast({ title: "调度任务已创建" })
          }
        } else {
          const config: AgentConfig = {
            schema_version: "1.0",
            type: "agent",
            prompt: data.prompt ?? "",
            model: data.model,
            timeout_seconds: data.timeout,
            retry_policy:
              (data.retry_attempts ?? 0) > 0
                ? {
                    max_attempts: data.retry_attempts ?? 0,
                    backoff_type: "fixed",
                    base_delay_ms: 1000,
                    max_delay_ms: 5000,
                    jitter: true,
                  }
                : undefined,
          }

          if (isEdit && editingJob) {
            await updateJob(
              editingJob.id,
              {
                name: data.name,
                cron_expression: data.cron_expression,
                timezone: data.timezone,
                config,
                description: data.description || undefined,
              },
              editingJob.version
            )
            toast({ title: "调度任务已更新" })
          } else {
            await createJob({
              name: data.name,
              job_type: "agent",
              cron_expression: data.cron_expression,
              timezone: data.timezone,
              config,
              description: data.description || undefined,
            })
            toast({ title: "调度任务已创建" })
          }
        }

        onSuccess()
        onClose()
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "操作失败"
        toast({
          title: isEdit ? "更新失败" : "创建失败",
          description: msg,
          variant: "destructive",
        })
      } finally {
        setSubmitting(false)
      }
    },
    [jobType, isEdit, editingJob, onSuccess, onClose, toast]
  )

  return { submit, submitting, configError }
}

// packages/server/src/services/chat/cabin-tools.ts
//
// Cabin P3（C2/C3/C6）：舱主对话（cabin-orchestrator）的调度工具集。
// 只调度不执行：派发映射到真实 Octopus 任务（CabinCommService.dispatch），
// 监督读派生视图，note/resume 走通信协议。执行落在任务 doer/worktree。
// 晚绑 provider（仿 task-tools）：index.ts 组合根注入 service/comm。

import { z } from "zod"
import { createSdkMcpServer, tool } from "@octopus/providers"
import type { CabinService } from "../cabin/cabin-service"
import type { CabinCommService } from "../cabin/cabin-comm-service"

export interface CabinToolsService {
  service: CabinService
  comm: CabinCommService
}

let provider: (() => CabinToolsService | null) | null = null

export function setCabinToolsProvider(fn: (() => CabinToolsService | null) | null): void {
  provider = fn
}

export function getCabinToolsProvider(): CabinToolsService | null {
  return provider ? provider() : null
}

/** 每回合舱摘要（C2 agent 可知关联）：派生自 CabinView，不持久。 */
export function buildCabinSummaryReminder(service: CabinService, cabinId: string): string | null {
  try {
    const { cabin, view } = service.getView(cabinId)
    const jobs = service.listJobsView(cabinId)
    const lines = [
      `[工作舱] ${cabin.name} · ${cabin.status} · 目录 ${cabin.path}`,
      `需求备注：${cabin.requirements?.trim() || "（无）"}`,
      `健康：运行 ${view.health.running} · 排队 ${view.health.queued} · 执行器 ${view.health.workers}/${view.health.max}`,
      `需要你（person-first）：${view.attention.length} 项${view.attention.length ? " —— " + view.attention.slice(0, 5).map((a) => `[${a.stage}/${a.awaiting}] ${a.title}`).join("；") : ""}`,
      `迭代：${view.iterations.map((it) => `${it.code} ${it.name} ${it.progress}%`).join("；") || "（无）"}`,
      `作业：${jobs.length ? jobs.slice(0, 8).map((j) => `${j.title}(${j.kind}/${j.status}/P${j.priority})`).join("；") : "（无）"}`,
      "纪律：只调度不执行；explicit 自决派发、inferred 一次一问；派发用 cabin_dispatch_task，监督用 cabin_list_tasks/cabin_list_jobs/cabin_job_trace。",
    ]
    return lines.join("\n")
  } catch {
    return null
  }
}

export function createCabinToolServer(cabinId: string) {
  const must = (): CabinToolsService => {
    const svc = provider?.()
    if (!svc) throw new Error("cabin tools not wired")
    return svc
  }

  const tools = [
    tool(
      "cabin_list_tasks",
      "列出本舱全部任务（id/名称/派生状态/迭代/worktree 会话）。监督读，自由调用。",
      {},
      async () => {
        const { service } = must()
        const tasks = service.listTasksView(cabinId)
        return { content: [{ type: "text" as const, text: JSON.stringify(tasks, null, 2) }] }
      },
    ),
    tool(
      "cabin_dispatch_task",
      "派发一个真实 Octopus 任务进舱：建任务+作者主线程+首回合授权 wake，执行在独立 worktree。mandate_strength=explicit 表示用户已明确授权（自决派发，作者不再问人）；inferred 表示需人确认。prompt 转发需求原文，不改写成计划。",
      {
        title: z.string().min(1).describe("任务显示名"),
        prompt: z.string().min(1).describe("需求原文（转发原始 trigger）"),
        iteration_id: z.string().optional().describe("归属迭代 id（cabin_list_jobs/iterations 可读）"),
        priority: z.number().int().optional().describe("数字优先级，默认 0"),
        mandate_strength: z.enum(["explicit", "inferred"]).optional().describe("授权强度，默认 explicit"),
      },
      async (input) => {
        const { comm } = must()
        const job = comm.dispatch(cabinId, {
          kind: "task",
          title: input.title,
          prompt: input.prompt,
          iteration_id: input.iteration_id ?? null,
          priority: input.priority ?? 0,
          mandate: { strength: input.mandate_strength ?? "explicit", scope: "task", basis: "orchestrator-dispatch" },
        })
        return { content: [{ type: "text" as const, text: JSON.stringify({ job_id: job.id, task_id: job.ref_id, session_id: job.session_id, status: "dispatched" }) }] }
      },
    ),
    tool(
      "cabin_list_jobs",
      "统一作业账本（task/workflow/subagent）：派发事实+派生 status+优先级+聚焦。监督读。",
      {},
      async () => {
        const { service } = must()
        const jobs = service.listJobsView(cabinId)
        return { content: [{ type: "text" as const, text: JSON.stringify(jobs, null, 2) }] }
      },
    ),
    tool(
      "cabin_job_trace",
      "读某作业的审计时间线（dispatch/report/attention/handback/note/human_input/resume）。",
      { job_id: z.string().min(1) },
      async (input) => {
        const { service } = must()
        const job = service.getJob(input.job_id)
        if (!job || job.cabin_id !== cabinId) {
          return { content: [{ type: "text" as const, text: `job not found: ${input.job_id}` }] }
        }
        const events = service.listEvents(job.id)
        return { content: [{ type: "text" as const, text: JSON.stringify(events, null, 2) }] }
      },
    ),
    tool(
      "cabin_note_job",
      "给作业 doer 发备注（steer，不授权）。subagent 一次性无 mid-run input，只留痕。",
      { job_id: z.string().min(1), text: z.string().min(1) },
      async (input) => {
        const { comm } = must()
        const event = comm.note(cabinId, input.job_id, input.text)
        return { content: [{ type: "text" as const, text: JSON.stringify({ event_id: event.id, kind: "note" }) }] }
      },
    ),
    tool(
      "cabin_resume_job",
      "恢复作业：task ready→触发、paused→恢复；阻塞解除后自主推进。",
      { job_id: z.string().min(1) },
      async (input) => {
        const { comm } = must()
        const event = await comm.resume(cabinId, input.job_id)
        return { content: [{ type: "text" as const, text: JSON.stringify({ event_id: event.id, kind: "resume" }) }] }
      },
    ),
  ]

  return createSdkMcpServer({
    name: "octopus-cabin",
    version: "1.0.0",
    instructions:
      "舱调度者工具集：只调度不执行。派发=建真实任务（执行在 doer/worktree）；监督读派生视图；note 不授权；一次只问人一个结构化问题。",
    tools,
    alwaysLoad: true,
  })
}

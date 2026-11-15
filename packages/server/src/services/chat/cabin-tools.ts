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
    const autonomy = cabinAutonomy(cabin.cockpit_prefs)
    const autonomyRule = autonomy === "auto" ? "inferred 可自决" : autonomy === "observe" ? "inferred 先向人确认" : "inferred 不派发，只记录建议"
    const focused = cabin.focused_job_id ? jobs.find((j) => j.id === cabin.focused_job_id) : null
    const lines = [
      `[作战舱] ${cabin.name} · ${cabin.status} · 目录 ${cabin.path}`,
      `需求备注：${cabin.requirements?.trim() || "（无）"}`,
      `健康：运行 ${view.health.running} · 排队 ${view.health.queued} · 执行器 ${view.health.workers}/${view.health.max}`,
      `需要你（person-first）：${view.attention.length} 项${view.attention.length ? " —— " + view.attention.slice(0, 5).map((a) => `[${a.stage}/${a.awaiting}] ${a.title}`).join("；") : ""}`,
      `作业：${jobs.length ? jobs.slice(0, 8).map((j) => `${j.title}(${j.kind}/${j.status}/P${j.priority})`).join("；") : "（无）"}`,
      `自决模式：${autonomy} —— explicit 明确指令直接派发；${autonomyRule}`,
      ...(focused ? [`聚焦作业：${focused.title} —— 优先驱动它到完成，其余作业排队不打断；human-wake 可抢占`] : []),
      "纪律：只调度不执行；一次只问人一个结构化问题；派发用 cabin_dispatch_task，监督用 cabin_list_tasks/cabin_list_jobs/cabin_job_trace。",
      "派发≠免澄清：作者会先在任务线程里问规格问题；出 stage=answer 的「待回答」时把用户送去任务线程，不要代答。",
    ]
    return lines.join("\n")
  } catch {
    return null
  }
}

/** cockpit_prefs.autonomy（C5）：off/observe/auto，缺省 auto。 */
export function cabinAutonomy(prefsJson: string | null): "off" | "observe" | "auto" {
  try {
    const v = (JSON.parse(prefsJson ?? "{}") as { autonomy?: string }).autonomy
    return v === "off" || v === "observe" ? v : "auto"
  } catch {
    return "auto"
  }
}

/** C5 确定性 gate（纯函数，单测覆盖）：explicit 恒可派发（用户明确命令）；
 *  inferred 按模式 —— auto 自决 / observe 先确认 / off 只记录建议。 */
export function cabinDispatchDecision(
  autonomy: "off" | "observe" | "auto",
  strength: "explicit" | "inferred",
): "dispatch" | "needs_confirmation" | "blocked" {
  if (strength === "explicit") return "dispatch"
  if (autonomy === "off") return "blocked"
  if (autonomy === "observe") return "needs_confirmation"
  return "dispatch"
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
      "派发一个真实 Octopus 任务进舱：建任务+作者主线程+首回合授权 wake，执行在独立 worktree。mandate_strength=explicit 表示用户已明确授权（建任务/开工作树/消耗 token），**不表示跳过规格澄清** —— 作者默认会先问人；clarify=auto 只在用户原话是「你看着办/直接做」时传。inferred 表示需人确认。prompt 转发需求原文，不改写成计划。",
      {
        title: z.string().min(1).describe("任务显示名"),
        prompt: z.string().min(1).describe("需求原文（转发原始 trigger）"),
        priority: z.number().int().optional().describe("数字优先级，默认 0"),
        mandate_strength: z.enum(["explicit", "inferred"]).optional().describe("授权强度，默认 explicit"),
        clarify: z.enum(["ask", "auto"]).optional().describe("规格澄清：ask 默认先问人；auto = 用户明确说「看着办/直接做」"),
      },
      async (input) => {
        const { comm, service } = must()
        // C5 确定性 gate：explicit 恒可派发（用户明确命令）；inferred 按
        // autonomy 模式分支 —— auto 自决 / observe 先确认 / off 只记录建议。
        const strength = input.mandate_strength ?? "explicit"
        const clarify = input.clarify ?? "ask"
        const autonomy = cabinAutonomy(service.get(cabinId).cockpit_prefs)
        const decision = cabinDispatchDecision(autonomy, strength)
        if (decision === "blocked") {
          return { content: [{ type: "text" as const, text: JSON.stringify({
            status: "blocked", reason: "autonomy-off",
            message: "自决已关闭（off）：这条推断指令只记录为建议，不建任务。请把建议告诉用户，等用户明确说「派发」再以 explicit 执行。",
          }) }] }
        }
        if (decision === "needs_confirmation") {
          return { content: [{ type: "text" as const, text: JSON.stringify({
            status: "needs_confirmation", reason: "observe-mode",
            message: "观察模式（observe）：推断派发需人确认。请在主对话向用户提一个结构化确认问题（一次一问），用户确认后再以 mandate_strength=explicit 派发。",
          }) }] }
        }
        const job = comm.dispatch(cabinId, {
          kind: "task",
          title: input.title,
          prompt: input.prompt,
          priority: input.priority ?? 0,
          mandate: { strength, scope: "task", basis: "orchestrator-dispatch", policyVersion: 1, clarify },
        })
        return { content: [{ type: "text" as const, text: JSON.stringify({ job_id: job.id, task_id: job.ref_id, session_id: job.session_id, status: "dispatched", clarify }) }] }
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

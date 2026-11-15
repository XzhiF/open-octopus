// packages/server/src/services/chat/cabin-tools.ts
//
// Cabin P3（C2/C3/C6）+ design 25（指挥台）：舱主对话（汐音）的工具集。
// 只调度不执行：派发映射到真实 Octopus 任务，轻活映射到独立委派实体，
// 监督读派生视图，决策走票据转达。执行落在任务 doer / 委派 doer。
// 晚绑 provider（仿 task-tools）：index.ts 组合根注入 service/comm/decisions/delegations。

import { z } from "zod"
import { createSdkMcpServer, tool } from "@octopus/providers"
import type { CabinService } from "../cabin/cabin-service"
import type { CabinCommService } from "../cabin/cabin-comm-service"
import type { CabinDecisionService } from "../cabin/cabin-decision-service"
import type { CabinDelegationService } from "../cabin/cabin-delegation-service"
import type { CabinBriefInput } from "../cabin/cabin-brief"

export interface CabinToolsService {
  service: CabinService
  comm: CabinCommService
  decisions?: CabinDecisionService
  delegations?: CabinDelegationService
}

let provider: (() => CabinToolsService | null) | null = null

export function setCabinToolsProvider(fn: (() => CabinToolsService | null) | null): void {
  provider = fn
}

export function getCabinToolsProvider(): CabinToolsService | null {
  return provider ? provider() : null
}

/** 工作实体状态 → 人能扫一眼的短词（编队 / reminder 共用）。 */
function workStatusLabel(status: string): string {
  const map: Record<string, string> = {
    draft: "草稿", ready: "待触发", running: "执行中", paused: "已暂停",
    awaiting_review: "待验收", awaiting_archive: "待归档", archiving: "归档中",
    done: "已完成", aborted: "已中止", failed: "失败",
    queued: "排队", waiting_input: "在问你", cancelled: "已取消",
  }
  return map[status] ?? status
}

/**
 * 每回合编队摘要（design 25 §6.3）：派生自 CabinView + listWorkView，不持久。
 *
 * 这是汐音「统筹帷幄」的自我认知来源：谁在跑、卡在哪、我管着几条线、哪条是焦点、
 * 哪些决定还没转达。它随用户消息 transient 注入，不进系统提示（不污染缓存）。
 */
export function buildCabinSummaryReminder(
  service: CabinService,
  cabinId: string,
  decisions?: CabinDecisionService,
): string | null {
  try {
    const { cabin, view } = service.getView(cabinId)
    const works = service.listWorkView(cabinId)
    const autonomy = cabinAutonomy(cabin.cockpit_prefs)
    const autonomyRule = autonomy === "auto"
      ? "inferred 可自决"
      : autonomy === "observe" ? "inferred 先向人确认" : "inferred 不派发，只记录建议"
    const focusedJobId = cabin.focused_job_id
    const focused = focusedJobId ? works.find((w) => w.job_id === focusedJobId || w.id === focusedJobId) : null

    // attention 逐条列出（已有 handle / subject），最多 8 条。
    const attentionLines = view.attention.slice(0, 8).map((a) => {
      const head = a.handle ? `${a.handle} ` : ""
      return `${head}${a.title} [${a.stage}/${a.awaiting}]`
    })

    const fleetLines = works.slice(0, 10).map((w) => {
      const isFocus = focused && focused.id === w.id
      return `${w.handle} ${w.title}  ${workStatusLabel(w.status)}${isFocus ? "   ← 焦点" : ""}`
    })

    // 决策：待人答 vs 已答待转达（后者是汐音这回合必须处理的事）。
    const pendingDecisions = decisions?.pendingRelays(cabinId) ?? []
    const recentRelayed = (decisions?.listDecisions(cabinId) ?? [])
      .filter((d) => d.stage === "relayed" || d.stage === "fallback_relayed")
      .slice(-3)

    const pendingAsks = decisions?.listAskCards(cabinId) ?? []

    const lines = [
      `[编队] ${cabin.name} · ${cabin.status} · 运行 ${view.health.running} · 待你 ${view.attention.length}`,
      ...(fleetLines.length ? fleetLines : ["（本舱还没有工作实体）"]),
      ...(attentionLines.length ? ["需要你/我在处理：", ...attentionLines] : []),
      ...(pendingAsks.length
        ? ["待你拍板：", ...pendingAsks.slice(0, 6).map((a) => `${a.handle ?? ""}${a.title} · ask=${a.askId}`)]
        : []),
      ...(pendingDecisions.length
        ? [`待转达（已答未送达）：${pendingDecisions.map((d) => `${d.handle} ${d.choice} ask=${d.askId}`).join(" · ")}`]
        : []),
      ...(recentRelayed.length
        ? [`最近回执：${recentRelayed.map((d) => `${d.handle} 「${d.choice}」`).join("；")}`]
        : []),
      `自决模式：${autonomy} · 默认档位 checkpoint · ${autonomyRule}`,
      "纪律：一次只处理一条决策；出 stage=answer 时，在主对话把信封摊开给人；人答完你用 cabin_relay_decision 代述，不要让人切线程。",
      "用户原文逐字，你的补充另起一段；不改用户的选择，只补边界；不确定就问。",
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

const briefSchema = z.object({
  goal: z.string().min(1).describe("一句话目标（可执行）"),
  done_when: z.array(z.string()).optional().describe("完成判据（可验证）"),
  constraints: z.array(z.string()).optional().describe("约束 / 不能碰的东西"),
  non_goals: z.array(z.string()).optional().describe("明确不做"),
  refs: z.array(z.string()).optional().describe("相关文件 / 路径"),
  autonomy: z.enum(["approve", "checkpoint", "hands-off"]).optional(),
})

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
      "派发一个真实 Octopus 任务进舱：建任务+作者主线程+首回合授权 wake，执行在独立 worktree。brief 是**你编译后的可执行意图**（goal/done_when/constraints），系统会把用户原文逐字附后；不要用 brief 覆盖原文。mandate_strength=explicit 表示用户已明确授权（建任务/开工作树/消耗 token），**不表示跳过规格澄清**；clarify=auto 只在用户原话是「你看着办/直接做」时传。inferred 表示需人确认。",
      {
        title: z.string().min(1).describe("任务显示名"),
        prompt: z.string().min(1).describe("用户需求原文（逐字，权威）"),
        brief: briefSchema.optional().describe("汐音编译的可执行意图；原文另存，不可被覆盖"),
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
          brief: (input.brief ?? null) as CabinBriefInput | null,
          mandate: { strength, scope: "task", basis: "orchestrator-dispatch", policyVersion: 1, clarify },
        })
        return { content: [{ type: "text" as const, text: JSON.stringify({
          job_id: job.id, task_id: job.ref_id, session_id: job.session_id,
          status: "dispatched", clarify, brief_compiled: !!input.brief,
        }) }] }
      },
    ),
    tool(
      "cabin_delegate_task",
      "派发一次**轻量委派**（不是任务）：没有 phase / worktree / 验收 / 归档，一份 brief + 一个 doer 会话。适合「帮我把这三个方案对比一下」「跑个调研写结论」。用户原话逐字保存，brief 只负责把它说清楚。编队里显示为 D1/D2。",
      {
        title: z.string().min(1).describe("短标题"),
        intent: z.string().min(1).describe("用户原话（逐字，权威）"),
        brief: briefSchema.optional(),
        autonomy: z.enum(["approve", "checkpoint", "hands-off"]).optional(),
      },
      async (input) => {
        const { delegations } = must()
        if (!delegations) throw new Error("delegation service not wired")
        const row = delegations.delegate(cabinId, {
          title: input.title,
          intent: input.intent,
          brief: (input.brief ?? null) as CabinBriefInput | null,
          autonomy: input.autonomy,
        })
        return { content: [{ type: "text" as const, text: JSON.stringify({
          delegation_id: row.id, session_id: row.doer_session_id,
          state: row.state, autonomy: row.autonomy, handle: delegationHandle(cabinId, row.id),
        }) }] }
      },
    ),
    tool(
      "cabin_relay_decision",
      "把用户在**主对话**里做的决定代述给 doer（任务或委派）。verbatim 逐字来自用户点选的选项 —— 不要改写、不要换成同义词。framing 只允许补充边界 / 理由 / 影响，不允许改选择、不允许加新条件。同一 ask 重复调用是幂等的。",
      {
        askId: z.string().min(1).describe("卡片票据（= 作者线程那条 assistant 消息 id）"),
        choice: z.string().optional().describe("用户选择的 option label（逐字）；省略则按账本里的记录"),
        subject: z.object({
          kind: z.enum(["task", "delegation"]),
          id: z.string(),
        }).optional().describe("归属实体；与票据不一致会被拒绝"),
        framing: z.string().optional().describe("汐音补充的理由与边界（不改选择）"),
      },
      async (input) => {
        const { decisions } = must()
        if (!decisions) throw new Error("decision service not wired")
        try {
          const res = await decisions.relayDecision(cabinId, {
            askId: input.askId,
            ...(input.choice ? { choice: input.choice } : {}),
            ...(input.subject ? { subject: input.subject } : {}),
            ...(input.framing ? { framing: input.framing } : {}),
          })
          return { content: [{ type: "text" as const, text: JSON.stringify({
            status: res.delivered ? "relayed" : "delivery_failed",
            already: res.already,
            askId: res.record.askId,
            handle: res.record.handle,
            choice: res.record.choice,
            subject: res.record.subject,
            ...(res.delivered ? {} : {
              message: "doer 会话正忙或不可达：决定已记账，watchdog 会重试机械转发。不要丢，也不要改写。",
            }),
          }) }] }
        } catch (err) {
          return { content: [{ type: "text" as const, text: JSON.stringify({
            status: "rejected",
            error: err instanceof Error ? err.message : String(err),
            detail: (err as { detail?: unknown }).detail ?? null,
          }) }] }
        }
      },
    ),
    tool(
      "cabin_list_jobs",
      "统一作业账本（task/workflow/subagent）+ 独立委派：派发事实+派生 status+句柄+优先级+聚焦。监督读。",
      {},
      async () => {
        const { service } = must()
        const jobs = service.listJobsView(cabinId)
        const works = service.listWorkView(cabinId)
        return { content: [{ type: "text" as const, text: JSON.stringify({ jobs, works }, null, 2) }] }
      },
    ),
    tool(
      "cabin_job_trace",
      "读某作业的审计时间线（dispatch/brief/report/attention/handback/note/decision/human_input/resume）。",
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
    version: "1.1.0",
    instructions:
      "舱调度者工具集：只调度不执行。派发=建真实任务（执行在 doer/worktree）；轻活=独立委派（无 phase/验收）；决策用 cabin_relay_decision 代述，逐字不改。监督读派生视图；一次只问人一个结构化问题。",
    tools,
    alwaysLoad: true,
  })
}

function delegationHandle(cabinId: string, delegationId: string): string | null {
  const service = provider?.()?.service
  if (!service) return null
  return service.listWorkView(cabinId).find((w) => w.kind === "delegation" && w.id === delegationId)?.handle ?? null
}

/**
 * 委派 doer 的工具集（design 25 §4.2）：只允许交结论，不允许派任务 / 建任务。
 * 挂在「session 是某条委派的 doer」时，替代舱调度工具集。
 */
export function createCabinDelegationToolServer(delegationId: string) {
  return createSdkMcpServer({
    name: "octopus-cabin-doer",
    version: "1.0.0",
    instructions: "你正在执行一次轻量委派。完成后调用 cabin_delegation_done 交一句话结论；不要建任务、不要开工作树。",
    tools: [
      tool(
        "cabin_delegation_done",
        "交委派结论（一句话 + 产物引用）。ok=false 表示没做成，说明卡在哪。",
        {
          summary: z.string().min(1).describe("一句话结论，含产物路径 / 链接"),
          ok: z.boolean().optional().describe("是否完成，默认 true"),
        },
        async (input) => {
          const res = provider?.()?.delegations?.finish(delegationId, input.summary, input.ok ?? true)
          return { content: [{ type: "text" as const, text: JSON.stringify({
            status: "recorded", delegation_id: delegationId, state: res?.state ?? "done",
          }) }] }
        },
      ),
    ],
    alwaysLoad: true,
  })
}

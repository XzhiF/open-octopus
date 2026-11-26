// packages/server/src/services/chat/cabin-tools.ts
//
// Cabin P3（C2/C3/C6）+ design 25（指挥台）：舱主对话（汐音）的工具集。
// 调度面：派发映射到真实 Octopus 任务，轻活映射到独立委派实体，监督读派生视图，
// 决策走票据转达。她本人也能直接动手（通用 Read/Edit/Bash）—— 小改自己做，
// 这套工具只管「把活派出去 / 转达 / 监督」。晚绑 provider（仿 task-tools）：
// index.ts 组合根注入 service/comm/decisions/delegations。

import { z } from "zod"
import { cabinItemLabel } from "@octopus/shared"
import { createSdkMcpServer, tool } from "@octopus/providers"
import type { CabinService } from "../cabin/cabin-service"
import type { CabinCommService } from "../cabin/cabin-comm-service"
import type { CabinDecisionService } from "../cabin/cabin-decision-service"
import type { CabinDelegationService } from "../cabin/cabin-delegation-service"
import type { CabinItemService } from "../cabin/cabin-item-service"
import type { CabinBriefInput } from "../cabin/cabin-brief"

export interface CabinToolsService {
  service: CabinService
  comm: CabinCommService
  decisions?: CabinDecisionService
  delegations?: CabinDelegationService
  /** 舱内「事项」读侧（2026-11-26 用户）：投递正文被截断 / 需要原文时回读。 */
  items?: CabinItemService
}

let provider: (() => CabinToolsService | null) | null = null

export function setCabinToolsProvider(fn: (() => CabinToolsService | null) | null): void {
  provider = fn
}

export function getCabinToolsProvider(): CabinToolsService | null {
  return provider ? provider() : null
}

/** 工作实体状态 → 人能扫一眼的短词（编队 / reminder 共用）。 */
function workStatusLabel(status: string, kind?: string): string {
  // 会话的 done 不叫「完成」：交完结论仍是活的，和任务一样写「待命」；归档才是终态。
  if (kind === "delegation" && status === "done") return "待命"
  // 任务 raw done 是走完归档闸的终态；其它作业（workflow / subagent）done 才是已完成。
  if (kind === "task" && status === "done") return "已归档"
  const map: Record<string, string> = {
    draft: "草稿", ready: "待触发", running: "执行中", paused: "已暂停",
    awaiting_review: "待验收", awaiting_archive: "待归档", archiving: "归档中",
    done: "已完成", aborted: "已中止", failed: "失败",
    queued: "排队", waiting_input: "在问你", cancelled: "已取消", archived: "已归档",
  }
  return map[status] ?? status
}

/**
 * 每回合编队摘要（design 25 §6.3）：派生自 CabinView + listWorkView，不持久。
 *
 * 这是汐音「统筹帷幄」的自我认知来源：谁在跑、卡在哪、我管着几条线、
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

    // attention 逐条列出（已有 handle / subject），最多 8 条。
    const attentionLines = view.attention.slice(0, 8).map((a) => {
      const head = a.handle ? `${a.handle} ` : ""
      return `${head}${a.title} [${a.stage}/${a.awaiting}]`
    })

    const fleetLines = works.slice(0, 10).map((w) =>
      `${w.handle} ${w.title}  ${workStatusLabel(w.status, w.kind)}`,
    )

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
  constraints: z.array(z.string()).optional().describe("约束 / 不能碰的东西（含分支计划：<仓> ← base → 合入 target）"),
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
      "派发一个真实 Octopus 任务进舱：建任务+作者主线程+首回合授权 wake，执行在独立 worktree。brief 是**你编译后的可执行意图**（goal/done_when/constraints），系统会把用户原文逐字附后；不要用 brief 覆盖原文。mandate_strength=explicit 表示用户已明确授权（建任务/开工作树/消耗 token），**不表示跳过规格澄清**；clarify=auto 只在用户原话是「你看着办/直接做」时传。inferred 表示需人确认。落点分支（任务从哪 fork、MR 合回哪）默认取舱籍项目的 mainline_branch；用户要求别的分支时，把「分支计划：<仓> ← base → 合入 target」写进 brief.constraints。",
      {
        title: z.string().min(1).describe("任务显示名"),
        prompt: z.string().min(1).describe("用户需求原文（逐字，权威）"),
        brief: briefSchema.optional().describe("汐音编译的可执行意图；原文另存，不可被覆盖"),
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
      "cabin_delegation_archive",
      "归档一条委派会话（D1/D2…）。归档前可选：通读整段会话做一次反思、用 octo-wiki 技能落一条沉淀，然后再调本工具；不做沉淀也可以直接归档。归档后编队写「已归档」并沉到归档区，不再回流任何待办。运行中 / 排队的会话不能归档（先等它交结论或取消）。summary 是归档说明（进审计与结论）。",
      {
        delegation_id: z.string().min(1).describe("委派 id（不是句柄）"),
        summary: z.string().optional().describe("一句话归档说明（可选）"),
      },
      async (input) => {
        const { delegations } = must()
        if (!delegations) throw new Error("delegation service not wired")
        const row = delegations.get(input.delegation_id)
        if (!row || row.cabin_id !== cabinId) {
          return { content: [{ type: "text" as const, text: JSON.stringify({
            status: "not_found", delegation_id: input.delegation_id,
          }) }] }
        }
        try {
          const res = delegations.archive(row.id, { summary: input.summary })
          return { content: [{ type: "text" as const, text: JSON.stringify({
            status: "archived", delegation_id: row.id,
            handle: delegationHandle(cabinId, row.id),
            state: res?.state ?? row.state,
            archived_at: res?.archived_at ?? null,
          }) }] }
        } catch (err) {
          return { content: [{ type: "text" as const, text: JSON.stringify({
            status: "rejected",
            error: err instanceof Error ? err.message : String(err),
            message: "没有归档：按 error 处理（运行中的会话先等结论或取消）。",
          }) }] }
        }
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
      "统一作业账本（task/workflow/subagent）+ 独立委派：派发事实+派生 status+句柄。监督读。",
      {},
      async () => {
        const { service } = must()
        const jobs = service.listJobsView(cabinId)
        const works = service.listWorkView(cabinId)
        return { content: [{ type: "text" as const, text: JSON.stringify({ jobs, works }, null, 2) }] }
      },
    ),
    tool(
      "cabin_list_items",
      "读舱内「事项」（零散小待办：优化 / 修复 / 想法）。默认只列未决（todo + delivered）。正文过长会截断（body_truncated=true），完整原文用 cabin_get_item。",
      {
        status: z.enum(["open", "todo", "delivered", "done", "dropped", "all"]).optional()
          .describe("过滤；默认 open = todo + delivered"),
        ids: z.array(z.string()).optional().describe("只读这些事项 id"),
      },
      async (input) => {
        const { items } = must()
        if (!items) throw new Error("cabin item service not wired")
        const status = input.status ?? "open"
        const idSet = input.ids && input.ids.length > 0 ? new Set(input.ids) : null
        const filtered = items.list(cabinId).filter((row) => {
          if (idSet && !idSet.has(row.id)) return false
          if (status === "all") return true
          if (status === "open") return row.status === "todo" || row.status === "delivered"
          return row.status === status
        })
        const BODY_MAX = 1200
        const payload = filtered.slice(0, 50).map((row) => {
          const chars = Array.from(row.body ?? "")
          const truncated = chars.length > BODY_MAX
          return {
            id: row.id, seq: row.seq, kind: row.kind, status: row.status,
            title: row.title,
            body: truncated ? chars.slice(0, BODY_MAX).join("") : row.body,
            body_chars: chars.length,
            body_truncated: truncated,
            delivered_at: row.delivered_at,
            closed_at: row.closed_at,
          }
        })
        return { content: [{ type: "text" as const, text: JSON.stringify({ items: payload, total: filtered.length }, null, 2) }] }
      },
    ),
    tool(
      "cabin_get_item",
      "读单条事项的完整正文（投递消息里正文被截断，或需要逐字原文时用）。",
      { item_id: z.string().min(1).describe("事项 id（不是 #IT-n 句柄；句柄用 cabin_list_items 查）") },
      async (input) => {
        const { items } = must()
        if (!items) throw new Error("cabin item service not wired")
        try {
          const row = items.get(cabinId, input.item_id)
          return { content: [{ type: "text" as const, text: JSON.stringify(row, null, 2) }] }
        } catch (err) {
          return { content: [{ type: "text" as const, text: JSON.stringify({
            status: "not_found", item_id: input.item_id,
            error: err instanceof Error ? err.message : String(err),
          }) }] }
        }
      },
    ),
    tool(
      "cabin_set_item_status",
      "改舱内「事项」的状态：done = 完成关项、dropped = 搁置关项、todo = 重新打开。**只在用户明确要求关项 / 重开时调用**：投递给你处理、但用户还没表态时不要自行关，汇报完由人在回执卡上确认。关项只写 closed_at，记录保留，不删除。",
      {
        ids: z.array(z.string().min(1)).min(1).max(50)
          .describe("事项 id 或 #IT-n 句柄，两种都收（也接受纯序号 n）"),
        status: z.enum(["done", "dropped", "todo"])
          .describe("目标状态：done 完成 / dropped 搁置 / todo 重新打开（仅对已关闭事项生效）"),
      },
      async (input) => {
        const { items } = must()
        if (!items) throw new Error("cabin item service not wired")
        try {
          // 投递消息里只露 #IT-n 句柄，模型未必知道原始 id —— 两种都收。
          const all = items.list(cabinId)
          const byId = new Map(all.map((row) => [row.id, row]))
          const bySeq = new Map(all.map((row) => [row.seq, row]))
          const resolved: string[] = []
          const unresolved: string[] = []
          for (const token of input.ids) {
            const text = token.trim()
            const direct = byId.get(text)
            const seqMatch = /^#?it-?(\d+)$/i.exec(text) ?? /^(\d+)$/.exec(text)
            const target = direct ?? (seqMatch ? bySeq.get(Number(seqMatch[1])) : undefined)
            if (!target) { unresolved.push(token); continue }
            if (!resolved.includes(target.id)) resolved.push(target.id)
          }
          if (resolved.length === 0) {
            return { content: [{ type: "text" as const, text: JSON.stringify({
              status: "not_found",
              missing: unresolved,
              message: "这些 id / 句柄在本舱找不到：先用 cabin_list_items 查一遍再改。",
            }) }] }
          }
          const res = items.setStatus(cabinId, resolved, input.status)
          return { content: [{ type: "text" as const, text: JSON.stringify({
            status: "applied",
            outcome: input.status,
            items: res.items.map((row) => ({
              id: row.id,
              handle: cabinItemLabel(row),
              title: row.title,
              before: byId.get(row.id)?.status ?? null,
              after: row.status,
              changed: row.status !== byId.get(row.id)?.status,
              closed_at: row.closed_at,
            })),
            missing: [...res.missing, ...unresolved],
          }, null, 2) }] }
        } catch (err) {
          return { content: [{ type: "text" as const, text: JSON.stringify({
            status: "rejected",
            error: err instanceof Error ? err.message : String(err),
            message: "状态没有改成：按 error 处理，不要假定已经关项 / 重开。",
          }) }] }
        }
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
      "给作业留一条备注 / 范围变更（不授权）：写进审计时间线，作战详情的「对接」能看到。默认只留痕；notify=true 才唤醒对应会话转达。你直接改了任务 home、删了产物或调整了范围后，必须留一条。",
      {
        job_id: z.string().min(1),
        text: z.string().min(1),
        notify: z.boolean().optional().describe("是否唤醒对应会话转达；默认 false 只留痕"),
      },
      async (input) => {
        const { comm } = must()
        const event = comm.note(cabinId, input.job_id, input.text, { notify: input.notify ?? false })
        return { content: [{ type: "text" as const, text: JSON.stringify({
          event_id: event.id, kind: "note", notified: input.notify ?? false,
        }) }] }
      },
    ),
    tool(
      "cabin_resume_job",
      "恢复作业：task 草稿 → 入列并触发、ready → 触发、运行中暂停 → 恢复；其余只留痕。gate 缺项会原样报错，不会假装已启动。",
      { job_id: z.string().min(1) },
      async (input) => {
        const { comm } = must()
        try {
          const event = await comm.resume(cabinId, input.job_id)
          const payload = JSON.parse(event.payload ?? "{}") as Record<string, unknown>
          return { content: [{ type: "text" as const, text: JSON.stringify({
            event_id: event.id, kind: "resume",
            action: payload.action ?? "notify",
            from_status: payload.from_status ?? null,
            to_status: payload.to_status ?? null,
          }) }] }
        } catch (err) {
          return { content: [{ type: "text" as const, text: JSON.stringify({
            status: "failed",
            error: err instanceof Error ? err.message : String(err),
            missing: (err as { missing?: unknown }).missing ?? null,
            detail: (err as { detail?: unknown }).detail ?? null,
            message: "恢复动作没有完成：按 missing / detail 里的缺项补规格后再试；不要把这条当作已启动。",
          }) }] }
        }
      },
    ),
    tool(
      "cabin_ack_attention",
      "把一条已完成回流从「要我处理」收掉（不回复任务/会话、不唤醒执行者）。只在审阅判断『不需要人回复、已用提示信息告知』后调用；item_id 形如 done-task-<任务id> / done-delegation-<委派id>。",
      { item_id: z.string().min(1) },
      async (input) => {
        const { service } = must()
        const res = service.ackAttention(cabinId, input.item_id, "orchestrator")
        return { content: [{ type: "text" as const, text: JSON.stringify({ item_id: input.item_id, ...res }) }] }
      },
    ),
  ]

  return createSdkMcpServer({
    name: "octopus-cabin",
    version: "1.1.0",
    instructions:
      "舱主的调度工具集（自己动手用通用的 Read/Edit/Bash，不在这里）。派发=建真实任务（执行在 doer/worktree）；轻活=独立委派（无 phase/验收、有归档闸）；决策用 cabin_relay_decision 代述，逐字不改。监督读派生视图；一次只问人一个结构化问题。完成回流先审一道：需要人回复就 AskUserQuestion，不需要就一句提示 + cabin_ack_attention 收项（不回复执行者）。会话跑完只是「待命」，归档由你管：用户说归档（或你判断该收口）时，可先通读会话做反思、用 octo-wiki 技能落沉淀，再调 cabin_delegation_archive；不沉淀也能直接归档。直接改了任务 home 或范围变更后，用 cabin_note_job 留痕，不要让它只存在于主对话。事项投递的正文若被截断或需要逐字原文，用 cabin_list_items / cabin_get_item 回读，不要凭标题猜需求。事项关项 / 重开用 cabin_set_item_status：用户明确说「关掉 / 完成 / 搁置 / 重开」时才改，投递后只是处理完、用户还没表态就先汇报，等人确认。",
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

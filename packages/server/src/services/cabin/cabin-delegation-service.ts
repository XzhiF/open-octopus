// packages/server/src/services/cabin/cabin-delegation-service.ts
//
// design 25 §4.2：轻量委派 —— 「替我跑一件事，回来告诉我」。
//
// 明确边界：不做多 phase、不做 spec 票、不做 worktree 隔离、不接验收。
// 归档有自己的闸（archived_at，由汐音管理），不是任务的归档编排。
// 一份 brief + 一个 doer 会话 + 一句话结论。
//
// 与 cabin_jobs 的关系：账本不合并，视图统一（读侧归一化）。
// 委派句柄用 `D1`，任务用 `#1` —— 扫一眼就能区分「立项的」与「跑一趟的」。

import { randomUUID } from "crypto"
import type { CabinDAO } from "../../db/dao/cabin-dao"
import type { CabinDelegationDAO } from "../../db/dao/cabin-delegation-dao"
import type { CabinDelegationRow, CabinDelegationState } from "../../db/types"
import type { CabinService } from "./cabin-service"
import type { CabinCommService } from "./cabin-comm-service"
import { getSessionService } from "../agent/session-service"
import { briefLines, normalizeBrief, type CabinBriefInput, type NormalizedBrief } from "./cabin-brief"

const now = () => new Date().toISOString()

export class CabinDelegationNotFoundError extends Error {
  constructor(id: string) { super(`cabin delegation not found: ${id}`); this.name = "CabinDelegationNotFoundError" }
}

export interface CabinDelegationDeps {
  cabin: CabinDAO
  delegations: CabinDelegationDAO
  service: CabinService
  comm: CabinCommService
  /** 主会话消息落库后的即时通知（SSE session_updated），否则回执要等轮询。 */
  onAppend?: (sessionId: string, workspaceId: string | null) => void
}

export interface DelegateInput {
  title: string
  /** 用户原话（逐字，永不覆盖 —— I4）。 */
  intent: string
  brief?: CabinBriefInput | null
  autonomy?: "approve" | "checkpoint" | "hands-off"
  /** 只登记不唤醒（测试 / 导入路径）。 */
  noWake?: boolean
}

export class CabinDelegationService {
  constructor(private readonly deps: CabinDelegationDeps) {}

  /** 委派收尾（done/failed/cancelled）：决策服务据此把该委派名下未决卡收口
   *  （v22 #9 —— 之前 expireForSubject 没有任何调用方）。 */
  private subjectEndHook: ((cabinId: string, subjectId: string) => void) | null = null

  setSubjectEndHook(hook: ((cabinId: string, subjectId: string) => void) | null): void {
    this.subjectEndHook = hook
  }

  private mustCabin(cabinId: string) {
    const row = this.deps.cabin.findById(cabinId)
    if (!row) throw new Error(`cabin not found: ${cabinId}`)
    return row
  }

  list(cabinId: string): CabinDelegationRow[] {
    return this.deps.delegations.listByCabin(cabinId)
  }

  get(id: string): CabinDelegationRow | undefined {
    return this.deps.delegations.getById(id)
  }

  findByDoerSession(sessionId: string): CabinDelegationRow | undefined {
    return this.deps.delegations.findByDoerSession(sessionId)
  }

  /** 创建并派发。会话是它的证据面（点开看过程），不是任务线程。 */
  delegate(cabinId: string, input: DelegateInput): CabinDelegationRow {
    const cabin = this.mustCabin(cabinId)
    const brief = normalizeBrief(input.brief ?? null)
    const autonomy = input.autonomy ?? brief?.autonomy ?? "checkpoint"
    const title = input.title.trim() || input.intent.trim().slice(0, 40)
    const intent = input.intent.trim()
    if (!intent) throw new Error("intent 不能为空（用户原话是权威）")

    const session = getSessionService().createSession({ cwd: cabin.path, cabin_id: cabinId })
    const ts = now()
    const row: CabinDelegationRow = {
      id: randomUUID(),
      cabin_id: cabinId,
      title,
      intent_text: intent,
      brief: brief ? JSON.stringify(brief) : null,
      autonomy,
      state: "running",
      doer_session_id: session.id,
      result_summary: null,
      created_at: ts,
      updated_at: ts,
      ended_at: null,
      archived_at: null,
    }
    this.deps.delegations.insert(row)
    try {
      this.deps.cabin.getDb().prepare(
        "UPDATE sessions SET cabin_id = ?, title = ?, updated_at = ? WHERE id = ?",
      ).run(cabinId, `D · ${title}`, ts, session.id)
    } catch { /* session columns best effort */ }

    this.appendAudit(cabinId, row, "delegate", { title, autonomy })
    try { this.deps.service.notifyViewChanged(cabinId) } catch { /* view hook optional */ }
    if (!input.noWake) {
      void this.deps.comm.wakeSessionPublic(session.id, cabin.org ?? "", this.wakeMessage(row, brief, intent))
    }
    return row
  }

  private wakeMessage(row: CabinDelegationRow, brief: NormalizedBrief | null, intent: string): string {
    return [
      `[汐音 · 代用户转达] 轻量委派「${row.title}」`,
      `授权：autonomy=${row.autonomy} · 这是一次委派，不是一个立项任务 —— 没有 phase / worktree / 验收流程。`,
      "",
      ...(brief ? ["## 意图（汐音编译，可执行）", briefLines(brief), ""] : []),
      "## 用户原文（逐字，权威）",
      intent,
      "",
      "冲突时以「用户原文」为准；brief 与原文有出入，先问，不要自行取舍。",
      "完成后调用 cabin_delegation_done 交一句话结论（含产物路径 / 链接）。不要建任务、不要开工作树。",
    ].join("\n")
  }

  private appendAudit(
    cabinId: string,
    row: CabinDelegationRow,
    stage: string,
    extra: Record<string, unknown> = {},
  ): void {
    try {
      this.deps.service.appendEvent(row.id, cabinId, "dispatch", "orchestrator", {
        delegation: true,
        delegationId: row.id,
        stage,
        title: row.title,
        autonomy: row.autonomy,
        ...extra,
      })
    } catch { /* 审计尽力而为 */ }
  }

  // ── 状态迁移 ─────────────────────────────────────────────────────

  setState(id: string, state: CabinDelegationState, extra: { result_summary?: string | null; ended_at?: string | null } = {}): CabinDelegationRow | undefined {
    const row = this.deps.delegations.getById(id)
    if (!row) return undefined
    this.deps.delegations.updateState(id, state, extra)
    try { this.deps.service.notifyViewChanged(row.cabin_id) } catch { /* view hook optional */ }
    const ended = state === "done" || state === "failed" || state === "cancelled"
    return {
      ...row, state, updated_at: now(),
      ...(extra.result_summary !== undefined ? { result_summary: extra.result_summary } : {}),
      ...(ended ? { ended_at: extra.ended_at ?? now() } : {}),
    }
  }

  markWaitingInput(id: string): void {
    const row = this.deps.delegations.getById(id)
    if (!row || row.archived_at) return
    if (row.state === "done" || row.state === "failed" || row.state === "cancelled") return
    this.deps.delegations.updateState(id, "waiting_input")
    try { this.deps.service.notifyViewChanged(row.cabin_id) } catch { /* view hook optional */ }
  }

  markRunning(id: string): void {
    const row = this.deps.delegations.getById(id)
    if (!row || row.archived_at) return
    if (row.state === "waiting_input") {
      this.deps.delegations.updateState(id, "running")
      try { this.deps.service.notifyViewChanged(row.cabin_id) } catch { /* view hook optional */ }
    }
  }

  /**
   * 归档（2026-11-25 用户）：会话也有归档闸，由汐音管理。
   *
   * 归档 ≠ 结束：`state=done` 只代表交完结论（编队写「待命」——人还能继续跟它
   * 互动）；归档是显式动作，写 `archived_at` 后编队才写「已归档」并沉到归档组。
   * 反思 + wiki 沉淀不属于这里的状态机：汐音可以在调用前自己做（可做可不做）。
   *
   * · 还在跑 / 排队的会话不能归档 —— 先等结论或取消；
   * · waiting_input 归档时顺手收口成 done（没交结论也关闸）；
   * · failed / cancelled 保留原终态，只补 archived_at；
   * · 已归档再调是幂等的。
   */
  archive(id: string, opts: { summary?: string } = {}): CabinDelegationRow | undefined {
    const row = this.deps.delegations.getById(id)
    if (!row) return undefined
    if (row.archived_at) return row
    if (row.state === "running" || row.state === "queued") {
      throw new Error("会话还在跑：先等它交结论或取消后再归档")
    }
    const ts = now()
    const nextState: CabinDelegationState = row.state === "waiting_input" ? "done" : row.state
    this.deps.delegations.updateState(id, nextState, {
      ...(opts.summary ? { result_summary: opts.summary } : {}),
      ...(row.ended_at ? {} : { ended_at: ts }),
      archived_at: ts,
    })
    this.appendAudit(row.cabin_id, row, "archive", {
      state: nextState,
      ...(opts.summary ? { summary: opts.summary } : {}),
    })
    try { this.subjectEndHook?.(row.cabin_id, row.id) } catch { /* 收口失败不影响归档 */ }
    try { this.deps.service.notifyViewChanged(row.cabin_id) } catch { /* view hook optional */ }
    return {
      ...row,
      state: nextState,
      updated_at: ts,
      ended_at: row.ended_at ?? ts,
      archived_at: ts,
      ...(opts.summary ? { result_summary: opts.summary } : {}),
    }
  }

  /**
   * 开机对账（2026-11-25 用户）：进程刚起来时没有任何活跃流，残留 running 的委派
   * 一定是上次死在一轮中间的 —— 落到「等你答」。否则编队一直显示作战中、秒表空转
   * （doer 明明已经回复了人）。返回修好的条数。
   */
  reconcileRunning(): number {
    let repaired = 0
    for (const cabin of this.deps.cabin.list()) {
      for (const delegation of this.list(cabin.id)) {
        if (delegation.state !== "running") continue
        this.markWaitingInput(delegation.id)
        repaired += 1
      }
    }
    return repaired
  }

  finish(id: string, summary: string, ok = true): CabinDelegationRow | undefined {
    const row = this.deps.delegations.getById(id)
    if (!row) return undefined
    // 已归档是终态：迟到的 cabin_delegation_done 不再把状态拉回「待命」。
    if (row.archived_at) return row
    const next = this.setState(id, ok ? "done" : "failed", { result_summary: summary, ended_at: now() })
    this.appendAudit(row.cabin_id, row, ok ? "done" : "failed", { summary })
    try { this.subjectEndHook?.(row.cabin_id, row.id) } catch { /* 收口失败不影响完成态 */ }
    // design 25 §11.9：跑完在主对话留一条结论 + 产物引用（不建任务、不进验收）。
    this.announceToMain(row, summary, ok)
    // 2026-11-19 用户 #9：完成回流先让汐音审一道 —— 需要回复就出 AskUserQuestion，
    // 不需要就提示一句并把「已完成」项收掉。失败仍走「受阻」，不在这里唤审。
    if (ok) this.wakeTriage(row, summary)
    return next
  }

  /** 完成审阅唤醒：读结论 → 判断要不要人回复 → ack（见 cabin_ack_attention 工具）。 */
  private wakeTriage(row: CabinDelegationRow, summary: string): void {
    const cabin = this.deps.cabin.findById(row.cabin_id)
    const main = cabin?.main_session_id
    if (!main) return
    const handle = this.handleOf(row.cabin_id, row.id)
    const message = [
      `[完成回流 · 请你先审] ${handle}「${row.title}」已完成。`,
      `结论：${summary}`,
      "判断要不要人回复：",
      "- 需要 → 用 AskUserQuestion 一次一问（卡片会投到本对话与 inbox），问题里说清依据；",
      "- 不需要 → 用一两句提示信息告诉我哪个任务完成了（不要重做、不要回复执行者），" +
        `然后调用 cabin_ack_attention(item_id="done-delegation-${row.id}") 把这条完成项收掉。`,
    ].join("\n")
    try {
      void this.deps.comm.wakeSessionPublic(main, cabin?.org ?? "", message)
    } catch { /* 唤醒失败不影响回执与完成态 */ }
  }

  /** 委派收尾 → 舱主会话一条结论卡（零 LLM）。 */
  private announceToMain(row: CabinDelegationRow, summary: string, ok: boolean): void {
    const cabin = this.deps.cabin.findById(row.cabin_id)
    const sessionId = cabin?.main_session_id
    if (!sessionId) return
    const ts = now()
    const handle = this.handleOf(row.cabin_id, row.id)
    try {
      this.deps.cabin.getDb().prepare(
        "INSERT INTO messages (id, session_id, role, content, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(
        randomUUID(), sessionId, "user",
        `${ok ? "✓" : "✕"} ${handle} ${row.title} · ${summary}`,
        JSON.stringify({
          displayType: "event",
          activity: {
            kind: "cabin.delegation_done",
            severity: ok ? "info" : "warn",
            title: ok ? "委派完成" : "委派失败",
            workspaceId: cabin?.workspace_id ?? null,
            taskId: null,
            status: ok ? "done" : "failed",
            payload: {
              delegationDone: {
                delegationId: row.id,
                handle,
                title: row.title,
                summary,
                ok,
                sessionId: row.doer_session_id,
                at: ts,
              },
            },
          },
        }),
        ts,
      )
      this.deps.cabin.getDb().prepare(
        "UPDATE sessions SET last_message_at = ?, updated_at = ? WHERE id = ?",
      ).run(ts, ts, sessionId)
      // 回执已落库：立即通知打开着的主对话刷新，不等下一次轮询。
      this.deps.onAppend?.(sessionId, cabin?.workspace_id ?? null)
    } catch { /* best effort */ }
  }

  /** D1 段位（与 `#1` 区分）：按创建顺序派生，不落库。 */
  private handleOf(cabinId: string, delegationId: string): string {
    const rows = this.deps.delegations.listByCabin(cabinId)
    const index = rows.findIndex((r) => r.id === delegationId)
    return index >= 0 ? `D${index + 1}` : "D?"
  }

  cancel(id: string): CabinDelegationRow | undefined {
    const row = this.deps.delegations.getById(id)
    if (!row) return undefined
    if (row.archived_at) return row
    const next = this.setState(id, "cancelled", { ended_at: now() })
    if (row) {
      try { this.subjectEndHook?.(row.cabin_id, row.id) } catch { /* 收口失败不影响取消态 */ }
    }
    return next
  }
}

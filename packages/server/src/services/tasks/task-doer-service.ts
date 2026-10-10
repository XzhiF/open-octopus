// packages/server/src/services/tasks/task-doer-service.ts
//
// taskboard-modal-v2 票01 (ADR-0025) — the task-doer chat seam (S1) service.
//
// One task = one task-doer session (`tasks.doer_session_id`), lazy-created on
// first touch and durable across Rounds (「一面两会话」的「做」面 — the 「谈」
// face stays on source_chat_session_id / task-author, untouched here).
//
// The session is a plain workspace-chat session (ChatService → chat_sessions)
// on the task's BOUND workspace (K4: first trigger creates + binds, later
// rounds reuse), so the whole history read/write surface of the existing
// ws-chat channel applies unchanged — no new chat protocol. The doer runs with
// cwd = that workspace: project worktrees live under {ws}/projects/<repo>, and
// the task-home write-ring (buildPathGuard, ADR-0018 §6) is not involved at
// all — it is装载 only for task-author sessions. 计划回写 票04 (ADR-0026) adds
// the REVERSE half: every doer turn carries buildDoerBatchGuard(wsPath, taskId)
// — writes into {ws}/.scratch/** (the seed-overwritten batch mirror) are
// refused on the spot with a reason pointing at the plan-writeback REST
// channel; everything else (projects/ writes, commits, reads, Bash surface)
// is untouched.
//
// Seam posture: everything here is observable through GET/POST
// /api/tasks/:id/chat (routes/task-chat.ts) — statuses, the persisted binding,
// the assembled sendQuery prompt, and the [quick-edit] commits on the
// execution branches.
//

import type Database from "better-sqlite3"
import fs from "fs"
import os from "os"
import path from "path"
import type { SSEService } from "../sse"
import type { ChatService } from "../chat"
import { runChatTurn, type ChatTurnOutcome, type ChatTurnStream } from "../chat-turn"
import type { WorkspaceService } from "../workspace"
import { CloneRuntime, buildDoerBatchGuard } from "../agent/clone-runtime"
import { getBuiltinCloneDef } from "../agent/builtin-clones"
import type { TaskHomeService } from "./task-home-service"
import { TaskNotFoundError, TaskStatusConflictError, type TasksService } from "./tasks-service"
import { batchRelPath } from "./task-artifact-sync"
import { specRunbookLevel } from "./runbook-spec"
import { ExecutionDAO, TaskDAO } from "../../db/dao"
import {
  QUICK_EDIT_MARKER,
  TAKEOVER_EDIT_MARKER,
  gitOps,
} from "../git-ops"

// ── Result shapes ──────────────────────────────────────────────────────

export interface EnsuredDoerSession {
  taskId: string
  sessionId: string
  /** true when THIS call created the session (first touch). */
  created: boolean
  workspaceId: string
  /** workspace.path with a leading `~` expanded (same posture as chat.ts:80). */
  wsPath: string
}

interface RawTaskRow {
  id: string
  org: string
  name: string
  status: string
  workspace_id: string | null
  doer_session_id: string | null
  task_spec: string
}

// A doer chat refuses the states with no live 现场 to talk INTO:
//   draft     — 谈 belongs to task-author (ADR-0025 会话两面性), own message;
//   archiving — the末 phase already passed the gate, home merge in flight;
//   done / aborted — the run is history; the ledger, not a chat, is the record.
// Everything else is in scope. Note 'ready' stays ALLOWED on purpose: K3 parks a
// manual-gate card at persisted 'ready' WHILE a round awaits review, and 待验收
// is exactly where US28 wants the chat tab to open. A never-triggered 'ready'
// has no bound workspace and falls to the no-workspace 409 below.
const DOER_CHAT_REFUSED = new Set(["archiving", "done", "aborted"])

/** First line of the user's instruction, capped — the [quick-edit] subject
 *  stays greppable (票09 counts by the marker) without quoting essays. */
function quickEditSummary(content: string): string {
  const first = content.split(/\r?\n/)[0].trim()
  return first.length > 60 ? `${first.slice(0, 59)}…` : first
}


// Canonical vocabulary (GLOSSARY-MAP: Round/修复轮/快速修改/人工接管) for the
// injected phase-state line — the doer reads 中文 labels, not DB enums.
const PHASE_STATE_LABEL: Record<string, string> = {
  pending: "未开始",
  running: "执行中",
  paused: "已暂停",
  takeover: "人工接管中",
  awaiting_review: "待验收",
  accepted: "已验收",
}

export class TaskDoerService {
  /** 执行行读面 —— 接管来源判定用 findLatestTaskInstance（任务当前那一轮），
   *  与 08 停流标记同认 executions.takeover_at/takeover_delivered_at 两列。
   *  taskDao 承载 doer 会话绑定的那一条 UPDATE（票10 review-3：seam 不再裸写
   *  SQL —— bind 走 DAO，与 updateAutosave/armOnce 同一分层纪律）。 */
  private readonly execDao: ExecutionDAO
  private readonly taskDao: TaskDAO

  constructor(protected readonly deps: {
    db: Database.Database
    sse: SSEService
    tasksService: TasksService
    chatService: ChatService
    workspaceService: WorkspaceService
    taskHomeService: TaskHomeService
  }) {
    this.execDao = new ExecutionDAO(deps.db)
    this.taskDao = new TaskDAO(deps.db)
  }

  /**
   * 这一回合是不是「人工接管中」的回合？判据 = 任务**当前那一轮**（最新实例行，
   * 与 08 停流标记读的是 executions.takeover_at / takeover_delivered_at 两列
   * 权威）停流未交付：takeover_at 已写、takeover_delivered_at 未写。回合
   * **开始时**定一次，贯穿落 commit：接管中的有效编辑盖 [takeover-edit]；
   * 待验收/ready 的快速修改照旧盖 [quick-edit]（票01 契约字符串逐字不变）。
   * 票09 三本账由此永不双计 —— 快改列只数 [quick-edit]，接管列认 DB 两列。
   * 接管后改派 task-fix 派出的是无标记新轮（最新实例随即换成它），下一回合
   * 自然回到 [quick-edit]。
   */
  private isTakeoverTurn(taskId: string): boolean {
    const latest = this.execDao.findLatestTaskInstance(taskId)
    return !!latest && latest.takeover_at != null && latest.takeover_delivered_at == null
  }

  /**
   * GET /api/tasks/:id/chat — the idempotent lazy-create.
   *
   * Throws TaskNotFoundError (→404) for an unknown/soft-deleted task and
   * TaskStatusConflictError (→409) when the task is not in an executable/
   * reviewable state or has no bound workspace yet. A dangling binding (the
   * chat session was deleted out from under us) self-heals: a fresh session is
   * created and re-bound — the task row stays the single pointer.
   */
  ensureSession(taskId: string): EnsuredDoerSession {
    const row = this.rawTaskRow(taskId)
    if (row.status === "draft") {
      throw new TaskStatusConflictError(
        "草稿期任务走 task-author 会话（谈），task-doer 对话在执行/验收态才可用",
      )
    }
    if (DOER_CHAT_REFUSED.has(row.status)) {
      throw new TaskStatusConflictError(
        `任务当前状态 '${row.status}' 无可对话的现场（对话仅在执行中/待验收可用）`,
      )
    }
    const workspaceId = row.workspace_id
    if (!workspaceId) {
      throw new TaskStatusConflictError("任务尚未绑定执行工作区，无法开启对话")
    }
    const ws = this.deps.workspaceService.getById(workspaceId)
    if (!ws) {
      throw new TaskStatusConflictError(`执行工作区不可用（${workspaceId}）`)
    }
    const wsPath = ws.path.replace(/^~/, os.homedir())

    if (row.doer_session_id) {
      const existing = this.deps.chatService.getSession(row.doer_session_id)
      if (existing) {
        return { taskId, sessionId: existing.id, created: false, workspaceId, wsPath }
      }
      // dangling pointer — fall through to (re-)create
    }

    const session = this.deps.chatService.createSession(workspaceId, `task-doer · ${row.name}`)
    // 定向 UPDATE 走 DAO（不 bump version —— 开对话不是改规格，票10 review-3）。
    this.taskDao.bindDoerSession(taskId, session.id)
    return { taskId, sessionId: session.id, created: true, workspaceId, wsPath }
  }

  /**
   * POST /api/tasks/:id/chat — one doer turn on the bound session.
   *
   * System prompt = task-doer persona (CloneRuntime, same assembly as ws-chat
   * uses for the workspace clone) + a per-turn injected 任务现场 block
   * (buildTaskContext) — the 「server 侧解析会话归属并注入任务上下文」 half of
   * US38. Everything else (SSE event shapes, message persistence, provider
   * session threading, abort) is the extracted ws-chat engine verbatim.
   */
  async streamTurn(
    taskId: string,
    content: string,
    stream: ChatTurnStream,
  ): Promise<{ outcome: ChatTurnOutcome; target: EnsuredDoerSession }> {
    const target = this.ensureSession(taskId)
    const session = this.deps.chatService.getSession(target.sessionId)
    if (!session) {
      // ensureSession just landed it; a vanish means concurrent deletion — 409-ish
      // conflict surfaced through the SSE error channel is overkill; throw.
      throw new TaskStatusConflictError("doer 会话不可用，请重开对话")
    }
    // 回合开始即定来源（票09 三本账不双计的写侧半）：接管中 → [takeover-edit]，
    // 其余 → [quick-edit]。取一次贯穿本回合 —— 中途交付/改派不改判已开始的回合。
    const takeoverTurn = this.isTakeoverTurn(taskId)
    const row = this.rawTaskRow(taskId)
    const append = `${this.personaPrompt(row.org)}\n\n${this.buildTaskContext(taskId, target, takeoverTurn)}`

    const outcome = await runChatTurn({
      stream,
      chatService: this.deps.chatService,
      sseService: this.deps.sse,
      sessionId: target.sessionId,
      notifyChannel: target.workspaceId,
      content,
      cwd: target.wsPath,
      provider: session.provider,
      providerSessionId: session.providerSessionId,
      systemPromptAppend: append,
      // 计划回写 票04 (S2) 反向硬闸：ws 侧批次目录（.scratch 同构位 = seed 的
      // 覆盖目标，「会被洗」断层）的写入当场拒绝，tool 结果带回可见原因 +
      // 计划回写 REST 指路（POST /api/tasks/:id/plan[/issues]）；projects/ 写、
      // 每改即 commit、以及批次目录的读全部不受影响。与 author 守卫同机制
      // （provider onBeforeToolCall → canUseTool 权威闸）、方向相反（author 圈进
      // home，这里只把 doer 挡在 {ws}/.scratch 之外 —— 其余命令面完整保留）。
      // task-home 写权环本身依旧不参与（ADR-0025 会话两面性），此闸只走 chat 通道。
      onBeforeToolCall: buildDoerBatchGuard(target.wsPath, taskId),
      // 快速修改每改即 commit (票01 写纪律的 server 半): the turn moved the
      // workspace's git现场 → land one marked commit per dirty repo on its
      // checked-out execution branch, announced over SSE before close. The
      // marker is form-aware ([quick-edit] / [takeover-edit], see
      // {@link isTakeoverTurn}); the SSE frame name quick_edit_commit is the
      // 票01/07 契约 and does NOT change. NOT a keyword judgment — 大改动劝退
      // lives in the persona (model side); the server only mechanicalizes
      // "did files actually change".
      onTurnComplete: async () => {
        const commits = await this.commitQuickEdits(target, content, takeoverTurn)
        for (const cm of commits) {
          await stream.writeSSE({
            event: "quick_edit_commit",
            data: JSON.stringify({ sessionId: target.sessionId, taskId, ...cm }),
          })
        }
      },
    })
    return { outcome, target }
  }

  /**
   * Per-repo quick-edit auto-commit under {ws}/projects/*. The bound workspace's
   * project worktrees already carry the execution branch checked out (K4/票05),
   * so this never picks branches — it commits where HEAD already is. A repo
   * that isn't dirty contributes nothing; commit failure is per-repo best-effort
   * (one bad repo must not eat the reply the user already saw).
   */
  private async commitQuickEdits(
    target: EnsuredDoerSession,
    content: string,
    takeoverTurn: boolean,
  ): Promise<Array<{ repo: string; branch: string; commit: string; message: string }>> {
    const projectsDir = path.join(target.wsPath, "projects")
    let names: string[]
    try {
      names = fs.readdirSync(projectsDir)
    } catch {
      return []
    }
    const git = gitOps
    const subject = `${takeoverTurn ? TAKEOVER_EDIT_MARKER : QUICK_EDIT_MARKER} ${quickEditSummary(content)}`
    const out: Array<{ repo: string; branch: string; commit: string; message: string }> = []
    for (const name of names) {
      const repo = path.join(projectsDir, name)
      try {
        if (!fs.existsSync(path.join(repo, ".git"))) continue
        if (!(await git.hasUncommittedChanges(repo))) continue
        const before = await git.getHeadCommit(repo)
        await git.autoCommit(
          repo,
          `${subject}\n\ntask: ${target.taskId}\ndoer_session: ${target.sessionId}\nrepo: ${name}`,
        )
        const after = await git.getHeadCommit(repo)
        if (after === before) continue // .gitignore-only dirt — nothing staged
        out.push({ repo: name, branch: await git.getCurrentBranch(repo), commit: after, message: subject })
      } catch (err: unknown) {
        console.warn(
          `[TaskDoerService] quick-edit commit failed for ${repo} (non-fatal):`,
          err instanceof Error ? err.message : String(err),
        )
      }
    }
    return out
  }

  /** task-doer persona via the standard clone assembly (filesystem persona.md
   *  wins, inline builtin-clones copy is the fallback — same posture as the
   *  workspace clone prompt in routes/chat.ts). */
  private personaPrompt(org: string): string {
    try {
      const def = getBuiltinCloneDef("task-doer")
      if (def) return new CloneRuntime(def, org || "default").assembleContext()
    } catch {
      // Non-fatal — the task-context block below still carries the 写纪律.
    }
    return ""
  }

  /**
   * The per-turn injected 任务现场 — 只注路径与事实，不注大段内容 (same
   * discipline as the handoff channel: the agent reads files itself).
   *   - 当前 phase/round（派生态读模型，与弹窗同源）
   *   - 批次目录（home 权威 + ws 同构位）+ spec 家族文件名（含 fix-feedback）
   *   - 启动 Runbook（两级判据单源 {@link specRunbookLevel}，与 round-evidence
   *     resolveRunbook / ready-gate 同一函数）
   *   - 写纪律（每改即 commit —— 标记随形态：接管回合 [takeover-edit]，其余
   *     [quick-edit]；大改动劝退转修复轮 —— 判断在 persona/模型，这里每轮重申）
   */
  buildTaskContext(taskId: string, target: EnsuredDoerSession, takeoverTurn = false): string {
    const detail = this.deps.tasksService.getTask(taskId)
    const spec = detail.task_spec as {
      phases?: Array<{ index: number; name: string; slug: string; specPath?: string }>
      acceptance_runbook?: {
        up?: { command?: string; cwd?: string }
        ready?: { command?: string }
        views?: Array<{ url?: string }>
      }
      acceptance_preview?: { command?: string; cwd?: string; url?: string }
    }
    const phases = spec.phases ?? []
    const views = detail.derived?.phaseViews ?? []

    // 活跃 phase：接管/待验收/执行中优先，否则最后一项（对话发生在现场，不在未来）。
    const active =
      views.find((p) => p.status === "takeover" || p.status === "awaiting_review" || p.status === "running") ??
      views[views.length - 1]
    const pdef = active ? phases.find((p) => p.index === active.index) : undefined
    const round = active?.awaitingRound ?? active?.currentRound ?? 1

    const homeDir = this.deps.taskHomeService.homePath(taskId)
    const lines: string[] = []
    lines.push("## 任务现场（server 注入，本轮有效）")
    lines.push(
      `- task: ${taskId}「${detail.name}」 状态=${detail.derived?.taskStatus ?? detail.status}`,
    )
    if (active) {
      lines.push(
        `- 当前 phase: ${active.index}「${active.name}」(slug=${active.slug})，round ${round}（${PHASE_STATE_LABEL[active.status] ?? active.status}）`,
      )
    } else {
      lines.push(`- 当前 phase: 任务尚无 phase（phases[] 为空）`)
    }

    if (pdef?.specPath) {
      const batchBits: string[] = []
      const specAbs = path.isAbsolute(pdef.specPath)
        ? pdef.specPath
        : path.join(homeDir, pdef.specPath)
      const homeBatch = path.dirname(specAbs)
      batchBits.push(`批次目录(home 权威): ${homeBatch}`)
      const rel = batchRelPath(homeDir, homeBatch)
      // rel 有值 ⇔ 批次在 home 之下 —— 工作区同构位直读 wsBatch（旧三元
      // `rel ? wsBatch : homeBatch` 的 else 分支不可达，票10 review-8 删）。
      if (rel) {
        const wsBatch = path.join(target.wsPath, rel)
        batchBits.push(`批次目录(工作区同构位): ${wsBatch}`)
        batchBits.push(`批次相对位: ${rel.split(path.sep).join("/")}`)
        const listing = this.listFilesRel(wsBatch)
        if (listing.length > 0) batchBits.push(`spec 家族文件: ${listing.join(", ")}`)
      } else {
        const listing = this.listFilesRel(homeBatch)
        if (listing.length > 0) batchBits.push(`spec 家族文件: ${listing.join(", ")}`)
      }
      lines.push(`- ${batchBits.join("\n- ")}`)
    }

    // 启动 Runbook —— 两级判据单源 specRunbookLevel（① 显式 runbook / ② legacy
    // preview），与 round-evidence-service.resolveRunbook、ready-gate 同函数
    //（票10 review-6：三处内联副本收口）。渲染仍按级取原始字段（legacy 行显示
    // 观测 url 原值，不显示合成出来的 curl 就绪探活 —— 给模型的是起法事实）。
    switch (specRunbookLevel(spec)) {
      case "explicit": {
        const rb = spec.acceptance_runbook!
        const viewsStr = (rb.views ?? []).map((v) => v.url).filter(Boolean).join(", ")
        lines.push(
          `- 启动 Runbook: up=\`${rb.up!.command}\` (cwd=${rb.up!.cwd ?? "."}) / ready=\`${rb.ready!.command}\`${viewsStr ? ` / views: ${viewsStr}` : ""}`,
        )
        break
      }
      case "legacy": {
        const legacy = spec.acceptance_preview!
        lines.push(`- 启动 Runbook(legacy preview): 起=\`${legacy.command}\` / 观测=${legacy.url}`)
        break
      }
      default:
        lines.push(`- 启动 Runbook: 未配置`)
    }

    const marker = takeoverTurn ? TAKEOVER_EDIT_MARKER : QUICK_EDIT_MARKER
    if (takeoverTurn) {
      lines.push(
        `- 写纪律（人工接管 · 一步一交）: 每次有效编辑由 server 自动在执行分支落一个 ${marker} 提交（接管件不计入台账「快速修改」列 —— 接管留痕认执行记录的停流/交付两列），勿自行 git commit/push；这轮不适合对话干时按 persona 走「✋ 有问题 → ③ 改派 task-fix 修复轮」。`,
      )
    } else {
      lines.push(
        `- 写纪律（快速修改）: 每次有效编辑由 server 自动在执行分支落一个 ${marker} 提交，勿自行 git commit/push；大改动（跨多文件逻辑、新接口/模块级）按 persona 劝退转「打回 → 修复轮」并整理反馈指令草稿。`,
      )
    }
    return lines.join("\n")
  }

  /** batch 目录浅清单（maxdepth 2, files only, cap 40）—— 只注名字让 agent 自己读。 */
  private listFilesRel(dir: string): string[] {
    const out: string[] = []
    const walk = (abs: string, rel: string, depth: number): void => {
      if (depth > 2 || out.length >= 40) return
      let entries: fs.Dirent[]
      try {
        entries = fs.readdirSync(abs, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        if (out.length >= 40) return
        const relPath = rel ? `${rel}/${e.name}` : e.name
        if (e.isDirectory()) walk(path.join(abs, e.name), relPath, depth + 1)
        else if (e.isFile()) out.push(relPath)
      }
    }
    walk(dir, "", 0)
    return out.sort()
  }

  /** Raw active row — the seam reads exactly the six facts the chat decision
   *  needs (no DTO round-trip). */
  protected rawTaskRow(taskId: string): RawTaskRow {
    const row = this.deps.db
      .prepare(
        "SELECT id, org, name, status, workspace_id, doer_session_id, task_spec FROM tasks WHERE id = ? AND deleted_at IS NULL",
      )
      .get(taskId) as RawTaskRow | undefined
    if (!row) throw new TaskNotFoundError()
    return row
  }
}

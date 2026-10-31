// packages/server/src/services/tasks/task-thread-service.ts
//
// 2026-10-28 task-thread redesign (原型 tmp/main-chat-task-lifecycle-proto.html):
// ONE main chat session per task, identity derived from the task's state.
//
// Before this service a task had two hidden chats (「一面两会话」):
//   - draft:        a task-author CLONE session (clone_name='task-author')
//   - execution:    a separate task-doer workspace chat (tasks.doer_session_id)
// The redesign keeps the main chat constant and switches a per-turn PROFILE:
//
//   draft                          → author  (task home cwd, home write fence)
//   ready / running / paused       → doer    (workspace cwd, doer guard, auto-commit)
//   awaiting_review                → doer    (same; review decisions stay human)
//   archiving                      → doer    (read-only; archive owns git)
//   done / aborted / failed        → base    (read-only retrospective)
//
// Activation is deliberately narrow: a session is a task thread ONLY when it is
// a MAIN session (clone_name IS NULL) AND `tasks.source_chat_session_id` points
// at it. Legacy task-author clone sessions keep the old clone route untouched,
// which is what lets M1–M3 ship server-side without breaking the current UI.
//
// What a profile controls:
//   cwd              — where the SDK runs (task home vs execution workspace)
//   plugins          — STABLE skill-discovery set for the whole thread
//                      (agent + task-author + task home) so skills never
//                      appear/disappear mid-thread and the prompt cache stays put
//   guard            — author fence / doer batch fence / read-only
//   context          — per-turn <system-reminder> block (never mutates the
//                      frozen system prompt; cache discipline)
//   autoCommit       — execution turns land one [quick-edit] commit per dirty repo
//
// Identity itself is delivered as a role card (existing role-card machinery),
// not by rebuilding the session or the system prompt.

import type Database from "better-sqlite3"
import fs from "fs"
import os from "os"
import path from "path"
import { AcceptanceDAO, ExecutionDAO, TaskDAO } from "../../db/dao"
import type { TaskRow } from "../../db/types"
import { WorkspaceService } from "../workspace"
import { getAgentDir, getBuiltInCloneDir } from "../agent/paths"
import { derivedTaskNameFromMessage, generateTaskTitle } from "./task-title"
import { buildAcceptanceGuard, buildDoerBatchGuard, buildPathGuard } from "../agent/clone-runtime"
import { acceptancePlanReady } from "./acceptance-plan-service"
import { TaskHomeService } from "./task-home-service"
import { deriveTaskView, type TaskView } from "./derive-task-view"

export type TaskThreadIdentity = "author" | "doer" | "base"

export type TaskThreadGuard = (
  toolName: string,
  input: unknown,
) => Promise<{ allow: boolean; reason?: string } | undefined>

export interface TaskThreadTaskInfo {
  id: string
  name: string
  /** Persisted task status (the row value). */
  status: string
  /** Derived display status (v4: awaiting_review/archiving included). */
  displayStatus: string
  phaseIndex: number | null
  roundIndex: number | null
  awaitingReview: boolean
  workspaceId: string | null
  wsPath: string | null
  taskHome: string
  slug: string | null
  branch: string | null
}

export interface TaskThreadProfile {
  task: TaskThreadTaskInfo
  identity: TaskThreadIdentity
  /** Absolute cwd for the provider call. */
  cwd: string
  /** Stable skill-discovery set for the whole thread. */
  plugins: Array<{ type: "local"; path: string }>
  guard?: TaskThreadGuard
  /** Per-turn <system-reminder> body. */
  context: string
  /** Execution turns: land one [quick-edit] commit per dirty repo. */
  autoCommit: boolean
  readOnly: boolean
  /** Latest round was stopped by a human and not delivered → [takeover-edit]. */
  takeover: boolean
  /** 2026-10-30 验收引导态：awaiting_review ∧ 方案已 ready → 本会话负责逐项引导
   *  人验收；写权收窄为「≤2 文件的小修」，超范围必须升级 task-fix。 */
  acceptanceGuide: boolean
  /** 2026-10-31 AI-native 归档：archiving 态 → 主 Chat 负责播报进度、逐条问反思、
   *  在用户明确表态后执行落/跳过/重试；对话里只留一张归档总框。 */
  archiveGuide: boolean
  /** 2026-10-31 archive-consent：末 phase 已验收、归档尚未启动 —— 主 Chat 只问
   *  一次「现在归档吗？」，用户明确说「归档」后才 allowed 调 start_archive。 */
  archiveConsent: boolean
}

export interface TaskThreadDeps {
  db: Database.Database
  taskDAO?: TaskDAO
  executionDAO?: ExecutionDAO
  acceptanceDAO?: AcceptanceDAO
  workspaceService?: WorkspaceService
  taskHomeService?: TaskHomeService
  /** 首轮任务起名（默认 haiku；测试注入桩，VITEST 下默认关闭不触网）。 */
  generateTaskTitle?: (message: string) => Promise<string | null>
}

const WRITE_TOOLS = new Set(["Write", "Edit", "NotebookEdit"])
const READ_ONLY = new Set(["archiving", "done", "aborted", "failed"])
const TERMINAL = new Set(["done", "aborted", "failed"])

const STATUS_LABEL: Record<string, string> = {
  draft: "草稿",
  ready: "待执行",
  running: "运行中",
  paused: "已暂停",
  awaiting_review: "待验收",
  awaiting_archive: "待归档",
  archiving: "归档中",
  done: "已完成",
  aborted: "已中止",
  failed: "失败",
}

/** Shell writes we refuse in read-only states. Deliberately narrow: the
 *  reflection turn still needs `git diff/log`, `cat`, `rg`, etc. The role card
 *  is the second line of defence; this is the mechanical one. */
const READ_ONLY_BASH_WRITE_RE =
  /(^|[;&|\n]\s*)(rm|mv|cp|mkdir|rmdir|touch|tee|dd|chmod|chown)\b|(^|[^0-9])>{1,2}(?!&)|git\s+(commit|push|reset|checkout|switch|merge|rebase|clean|apply|stash)\b|(npm|pnpm|yarn)\s+(install|i|ci|add|remove)\b|pip\s+install\b|sed\s+-i\b/i

export function buildReadOnlyGuard(): TaskThreadGuard {
  return async (toolName, input) => {
    if (WRITE_TOOLS.has(toolName)) {
      return {
        allow: false,
        reason:
          "当前任务状态为只读（归档中/已完成/已终止），不能改代码或规格。" +
          "可以用 Read/Grep/Glob 或只读 shell 查看现场，回答用户的问题。",
      }
    }
    if (toolName === "Bash") {
      const command = String((input as Record<string, unknown> | undefined)?.command ?? "")
      if (READ_ONLY_BASH_WRITE_RE.test(command)) {
        return {
          allow: false,
          reason:
            "当前任务状态为只读，拒绝执行写入类命令。" +
            "查看现场请用只读命令（git diff/log、cat、rg、ls 等）。",
        }
      }
    }
    return undefined
  }
}

function expandHome(p: string): string {
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p
}

function parseJSON<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function existingDir(p: string): string | null {
  try {
    return fs.statSync(p).isDirectory() ? p : null
  } catch {
    return null
  }
}

export class TaskThreadService {
  private readonly taskDAO: TaskDAO
  private readonly executionDAO: ExecutionDAO
  private readonly acceptanceDAO: AcceptanceDAO
  private readonly workspaceService: WorkspaceService
  private readonly taskHomeService: TaskHomeService
  private readonly titleGenerator: ((message: string) => Promise<string | null>) | null

  constructor(deps: TaskThreadDeps) {
    this.taskDAO = deps.taskDAO ?? new TaskDAO(deps.db)
    this.executionDAO = deps.executionDAO ?? new ExecutionDAO(deps.db)
    this.acceptanceDAO = deps.acceptanceDAO ?? new AcceptanceDAO(deps.db)
    this.workspaceService = deps.workspaceService ?? new WorkspaceService()
    this.taskHomeService = deps.taskHomeService ?? new TaskHomeService()
    // VITEST 默认不触网（chat-route 测试会走这条路径）；测试要覆盖就注入桩。
    this.titleGenerator = deps.generateTaskTitle ?? (process.env.VITEST ? null : generateTaskTitle)
  }

  /** Bind (or rebind) the task's main chat thread. Targeted UPDATE, no version bump. */
  bindThread(taskId: string, sessionId: string | null): boolean {
    return this.taskDAO.bindSourceChatSession(taskId, sessionId)
  }

  /**
   * Resolve the turn profile for a chat session, or null when the session is
   * not a task thread. `clone_name` is passed in (the chat route already has
   * the session row) so legacy clone sessions are rejected without a query.
   */
  resolveForSession(session: { id: string; clone_name?: string | null }): TaskThreadProfile | null {
    if (session.clone_name) return null
    const task = this.taskDAO.getBySourceChatSession(session.id)
    if (!task) return null
    return this.buildProfile(task)
  }

  /**
   * 新建任务的首轮：用用户需求总结任务标题（2026-10-29）。
   *
   * 只在任务名仍是「那条消息的确定性截串」时替换 —— 也就是客户端刚创建时落的
   * 自动名。用户手动改过名（或任务后来换了名字）就永不覆盖。异步跑，不阻塞首轮回包；
   * 失败静默保留截串名。
   */
  maybeAdoptSmartTaskName(sessionId: string, message: string): void {
    const derived = derivedTaskNameFromMessage(message)
    const task = this.taskDAO.getBySourceChatSession(sessionId)
    if (!task || task.name !== derived) return
    const generate = this.titleGenerator
    if (!generate) return
    setImmediate(async () => {
      try {
        const title = await generate(message)
        if (!title || title === derived) return
        const fresh = this.taskDAO.getById(task.id)
        if (!fresh || fresh.name !== derived) return
        this.taskDAO.updateAutosave(task.id, title)
      } catch {
        /* non-fatal — 截串名继续用 */
      }
    })
  }

  /** Build a profile for a known task (used by tests and the launch/tool surfaces). */
  buildProfile(task: TaskRow): TaskThreadProfile {
    const spec = parseJSON<{
      format?: string
      slug?: string
      branch?: string | null
      phases?: Array<{ index: number; name: string; workflowRef?: string }>
    }>(task.task_spec, {})
    const executions = this.executionDAO.listTaskInstances(task.id, 200)
    const acceptances = this.acceptanceDAO.listByTask(task.id)
    const view: TaskView = deriveTaskView(
      { id: task.id, status: task.status, task_spec: task.task_spec },
      executions,
      acceptances,
    )

    const identity: TaskThreadIdentity =
      task.status === "draft" ? "author" : TERMINAL.has(task.status) ? "base" : "doer"

    const taskHome = this.taskHomeService.homePath(task.id)
    // Per-turn backfill: the SDK feeds `.task/.claude/rules/task-context.md` to
    // EVERY session under the workspace (nested memory) — including workflow
    // exec agents at the ws root. Homes written before the rule was scoped still
    // carry an unconditional "禁止写入项目代码库", which makes those agents refuse
    // to commit and leaves 「变更」empty. No-op once current.
    this.taskHomeService.ensureRulesFile(task.id)
    const workspace = task.workspace_id ? this.workspaceService.getById(task.workspace_id) : undefined
    const wsPath = workspace ? expandHome(workspace.path) : null
    // archive-consent: 末 phase 已验收、归档未启动 —— 只读；只能确认归档或中止。
    const awaitingArchive = view.taskStatus === "awaiting_archive"
    // ready has no execution workspace yet, so a doer turn can only read for now.
    const readOnly =
      identity === "base" || task.status === "archiving" || awaitingArchive || (identity === "doer" && !wsPath)

    const awaitingPhase = view.phaseViews.find((p) => p.status === "awaiting_review")
    const activePhase =
      view.phaseViews.find((p) => ["running", "paused", "takeover", "awaiting_review"].includes(p.status)) ??
      [...view.phaseViews].reverse().find((p) => p.currentRound != null) ??
      view.phaseViews[0]
    const phaseIndex = awaitingPhase?.index ?? activePhase?.index ?? null
    const roundIndex = awaitingPhase?.awaitingRound ?? activePhase?.currentRound ?? null

    const info: TaskThreadTaskInfo = {
      id: task.id,
      name: task.name,
      status: task.status,
      displayStatus: String(view.taskStatus),
      phaseIndex,
      roundIndex,
      awaitingReview: view.taskStatus === "awaiting_review",
      workspaceId: task.workspace_id,
      wsPath,
      taskHome,
      slug: spec.slug ?? null,
      branch: spec.branch ?? null,
    }

    const cwd =
      identity === "author"
        ? existingDir(taskHome) ?? getAgentDir()
        : existingDir(wsPath ?? "") ?? existingDir(taskHome) ?? getAgentDir()

    const plugins = this.buildPlugins(taskHome)
    const acceptanceGuide =
      identity === "doer" && !readOnly && info.awaitingReview && !!wsPath && acceptancePlanReady(task.id)
    const archiveGuide = identity === "doer" && info.status === "archiving"
    const archiveConsent = identity === "doer" && awaitingArchive
    const guard = this.buildGuard(identity, { taskHome, wsPath, readOnly, taskId: task.id, acceptanceGuide })
    const context = this.buildContext(info, { identity, spec, view, acceptanceGuide, archiveGuide, archiveConsent })

    return {
      task: info,
      identity,
      cwd,
      plugins,
      guard,
      context,
      autoCommit: identity === "doer" && !readOnly && !!wsPath,
      readOnly,
      // Newest instance row; a stopped-but-undelivered round is a takeover turn.
      takeover: (() => {
        const latest = executions[0]
        return !!latest && latest.takeover_at != null && latest.takeover_delivered_at == null
      })(),
      acceptanceGuide,
      archiveGuide,
      archiveConsent,
    }
  }

  /** Stable set for the whole thread: agent home + task-author skills + task home. */
  private buildPlugins(taskHome: string): Array<{ type: "local"; path: string }> {
    const plugins: Array<{ type: "local"; path: string }> = [
      { type: "local", path: getAgentDir() },
      { type: "local", path: getBuiltInCloneDir("task-author") },
    ]
    if (existingDir(taskHome)) plugins.push({ type: "local", path: taskHome })
    return plugins
  }

  private buildGuard(
    identity: TaskThreadIdentity,
    input: { taskHome: string; wsPath: string | null; readOnly: boolean; taskId: string; acceptanceGuide?: boolean },
  ): TaskThreadGuard | undefined {
    if (identity === "author") {
      return buildPathGuard(
        input.taskHome,
        path.join(getBuiltInCloneDir("task-author"), "memory"),
      ) as TaskThreadGuard
    }
    if (identity === "doer" && !input.readOnly && input.wsPath) {
      // 验收引导轮：仍是 doer（可小修），但每次引导最多 2 个写目标 —— 超出就
      // 提示升级大 fix（task-fix），不让人在验收里被无边界改动牵着走。
      if (input.acceptanceGuide) {
        return buildAcceptanceGuard(input.wsPath, input.taskId, { maxFiles: 2 }) as TaskThreadGuard
      }
      return buildDoerBatchGuard(input.wsPath, input.taskId) as TaskThreadGuard
    }
    return buildReadOnlyGuard()
  }

  private buildContext(
    info: TaskThreadTaskInfo,
    extra: {
      identity: TaskThreadIdentity
      spec: { phases?: Array<{ index: number; name: string; workflowRef?: string }> }
      view: TaskView
      acceptanceGuide?: boolean
      archiveGuide?: boolean
      archiveConsent?: boolean
    },
  ): string {
    const label = STATUS_LABEL[info.displayStatus] ?? info.displayStatus
    const coord =
      info.phaseIndex != null
        ? `Phase ${info.phaseIndex}${info.roundIndex != null ? ` · Round ${info.roundIndex}` : ""}`
        : "尚未开始"
    const head = `[任务线程] 任务：${info.name}（id: ${info.id}）· 状态：${label} · ${coord}`

    if (extra.identity === "author") {
      const phaseLines =
        extra.spec.phases?.length
          ? extra.spec.phases.map((p) => `P${p.index} ${p.name}${p.workflowRef ? ` → ${p.workflowRef}` : ""}`).join("；")
          : "尚未拆 phase"
      return [
        head,
        "[身份] 任务作者。把需求澄清成 v4 task_spec；只写 task home，project 仓库只读；不跑开发/构建/测试，不 commit/push。",
        `[任务 home] ${info.taskHome}`,
        `[phases] ${phaseLines}`,
        "[写规格] 优先用任务工具 update_task_spec_field（或 POST /api/tasks/:id/spec-field），不要整段覆盖 phases。",
        "[收尾] 规格齐后用任务工具 propose_launch，让用户在「立即执行 / 入列待触发 / 定时触发」中选一个；不要自行触发。",
        "[状态感知] 入列/触发/验收等状态变化会以事件卡出现在本会话；每轮也会刷新上面这行状态。",
      ].join("\n")
    }

    if (extra.identity === "doer") {
      const planCmd = `POST /api/tasks/${info.id}/plan`
      const frozen = info.displayStatus === "archiving" || info.displayStatus === "awaiting_archive"
      const readOnlyLine = info.displayStatus === "awaiting_archive"
        ? "[只读] 末 phase 已验收，任务停在待归档：不要改代码或规格；只能确认是否归档或中止。"
        : info.displayStatus === "archiving"
          ? "[只读] 归档编排进行中：不要改代码或规格。可以读 task home / archive/report.md，回答归档结果、冲突与重试问题。"
          : "[写权] 只写执行工作区的 projects/**；工作区批次目录 .scratch 是计划副本，只读。"
      const quickEditLine = frozen
        ? ""
        : "[纪律] 每次有效编辑由 server 自动落 [quick-edit] commit，不要自己 git commit/push。"
      const guideLines = extra.acceptanceGuide ? [
        "[验收引导] 本轮已交付，验收方案已生成（两层：人验场景 + 机器证据）。你的角色是**引导人验场景**，不是自己签字，也不是替人跑测试：",
        "  1. 先调 get_acceptance_plan 读方案：`cases` 是 1–3 条人验收场景（打开 → 操作 → 看什么），`checks` 是本轮已有机器证据（只读）。",
        "  2. 开场用**一句话**播报机器证据（共几项、缺几件）；**不要逐条跑、不要逐项问** —— e2e / 慢命令尤其不要主动重跑。",
        "  3. 一次只推进**一条场景**：按 steps 讲清「打开哪 → 做什么 → 看到什么」，然后问「通过 / 不通过 / 跳过」。用户要看页面就 start_acceptance_preview（结束 stop_acceptance_preview）；**只有用户点名要新结果时**才 run_acceptance_probe 跑某条机器证据。",
        "  4. 用户**在对话里明确表态**（「通过」「可以」「不行，因为…」「跳过」）即可直接调 record_acceptance_check（confirmed=true），只对场景；卡片只是快捷方式。不要代替用户判断、不要批量代勾，也不要把机器证据当成人工勾选项。",
        "  5. 用户说不通过 → 当场小修：只改与该问题直接相关的 **≤2 个文件**，不改 spec/票；改完按场景重新看一遍并把结果讲给用户，再问一次是否通过 —— 改完不等于通过，绝不默认勾上。",
        "  6. 问题超出小修边界（要改 spec、要动 3 个以上文件、或反复修不好）→ 调 propose_acceptance_escalation，让用户确认升级 task-fix 大修复；不要硬改。",
        "  7. 场景都有结论后，先做**放行前终检**：再调一次 get_acceptance_plan 看 postRound（末轮之后的新提交 / 未提交文件），把现场用一两句话讲给用户。有未提交改动就提醒：归档 preflight 会先拦下，届时再选「纳入 / 排除」，或现在先改完再放行。确认无遗漏后再问要不要「放行」或「退回修改」。",
        "  8. 用户**明确表态**后由你收口：放行 → submit_acceptance_decision(decision=\"accepted\", confirmed=true)；退回 → submit_acceptance_decision(decision=\"rejected\", feedback=用户说的原因, confirmed=true)。人点验收台是兜底，不是必需；但没有明确表态绝不放行、绝不退回，也不要把未勾场景当成通过。",
      ] : []
      const archiveLines = extra.archiveGuide ? [
        "[归档引导] 末 phase 已放行，任务处于 archiving（只读；归档编排由服务端执行）。你的角色是播报 + 逐条问反思 + 执行用户的口头决定：",
        "  1. 先调 get_archive_state 读 git 同步 / project 失败 / 术语冲突 / 反思 / 知识包状态。",
        "  2. 用一两句人话播报进度和你在等什么；不要贴表格或逐项清单 —— 明细让用户点总框里的「打开归档台看明细」。",
        "  3. 调 propose_wiki_entries 给出 2–5 条建议（它不再落卡片），然后**一次只问一条**：要不要落 wiki。",
        "  4. 用户说「落 / 跳过 / 都跳过 / 都落」→ 逐条 record_reflection_decision(confirmed=true) 执行并回执；不要代替人决定。",
        "  5. 归档失败：说清是哪个 project、什么原因；用户明确说「重试」→ retry_archive(confirmed=true)。",
        "  6. 若 preflight 提示有未提交改动：问用户「纳入归档」还是「排除并记录」，明确表态后调 resolve_archive_delta(decision, confirmed=true)；不要自己决定。",
        "  7. 不要声称已完成 —— done 由服务端在全部 project 的 git 同步成功后才写入。",
      ] : []
      const consentLines = extra.archiveConsent ? [
        "[归档确认] 末 phase 已通过，任务停在「待归档」(awaiting_archive)，归档尚未启动。",
        "  1. 用一两句话告诉用户本轮交付已完成；然后只问一次：「现在归档吗？」",
        "  2. 归档会执行 git 同步 / ADR+术语合并 / commit+push+PR / 知识沉淀；交付 PR 可能长期不合并，任务可以一直停在待归档。",
        "  3. 用户明确说「归档 / 开始归档 / 现在归档」→ 调用 start_archive(confirmed=true)；不要自己开始归档。",
        "  4. 用户说「暂不归档 / 先等等」→ 什么都不做，告诉用户任务保持待归档，随时说「归档」即可。",
        "  5. 用户说「中止 / 不做了」→ request_task_action(action=\"abort\", reason=...)，仍需人点确认卡。",
        "  6. 不要声称 done —— done 由服务端在全部 project 的 git 同步成功后才写入。",
      ] : []
      return [
        head,
        ...guideLines,
        ...archiveLines,
        ...consentLines,
        "[身份] 任务执行者。接住作者谈好的 spec / 批次 / 运行手册，在执行工作区里按用户指令改代码。",
        `[执行工作区] ${info.wsPath ?? "尚未绑定（等待触发）"}${info.branch ? ` · 分支 ${info.branch}` : ""}`,
        readOnlyLine,
        quickEditLine,
        `[改计划] 改 spec/票只能走计划回写：${planCmd}（批次目录只读，直接改会被硬闸拒绝）。`,
        "[动作] 触发/暂停/恢复/中止/重试归档请用任务工具 request_task_action（会落确认卡，人点才执行）；验收的通过/打回在用户明确表态后调 submit_acceptance_decision 收口（人点验收台是兜底）。",
        "[状态感知] 任务状态变化会以事件卡出现在本会话；每轮也会刷新上面这行状态。",
      ].filter(Boolean).join("\n")
    }

    return [
      head,
      "[身份] 只读回顾。任务已结束/归档，不再改代码或规格。",
      `[任务 home] ${info.taskHome}${info.wsPath ? ` · 执行工作区 ${info.wsPath}` : ""}`,
      "[归档复盘] 可用 get_archive_state 复述归档结果、冲突与反思；未决反思可按用户明确表态继续 record_reflection_decision 落/跳过。",
      "[归档增补] 用户要补充/修正归档内容时，用 record_archive_amendment(confirmed=true) 追加只增不改的记录（可选同时落 wiki）；不要改写原报告。",
      "[跟进任务] 用户要再改代码/继续开发时，用 open_followup_task(confirmed=true) 开一个继承 spec 的新任务；旧任务保持 done 不可变，不要在这里写代码。",
    ].join("\n")
  }
}

/** Process-wide handle for routes/tools (index.ts wires it once). */
let singleton: TaskThreadService | null = null

export function initTaskThreadService(deps: TaskThreadDeps): TaskThreadService {
  singleton = new TaskThreadService(deps)
  return singleton
}

export function getTaskThreadService(): TaskThreadService | null {
  return singleton
}

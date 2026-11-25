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
import { buildDoerBatchGuard, buildPathGuard } from "../agent/clone-runtime"
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
  /** task_spec.kind — null for ordinary v4 dev tasks; 'workflow-dev' for the
   *  workflow authoring kind (2026-11-06). */
  kind: string | null
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
  /** Per-turn <system-reminder> body (head + playbook, joined). */
  context: string
  /** Status line — refreshed EVERY turn (task / status / phase · round). */
  contextHead: string
  /** Identity + discipline + tools + guides. Sent once per change; hash-gated
   *  by the chat route so unchanged turns carry only the head. */
  contextPlaybook: string
  /** Execution turns: land one [quick-edit] commit per dirty repo. */
  autoCommit: boolean
  readOnly: boolean
  /** Latest round was stopped by a human and not delivered → [takeover-edit]. */
  takeover: boolean
  /** 2026-10-30 验收引导态：awaiting_review ∧ 方案已 ready → 本会话负责逐项引导
   *  人验收；写权 = 工作区 projects/**（打回后原地修，见 #11）。 */
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
  generateTaskTitle?: (message: string, kind?: string | null) => Promise<string | null>
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
    let kind: string | null = null
    try {
      kind = (JSON.parse(task.task_spec || "{}") as { kind?: string }).kind ?? null
    } catch {
      kind = null
    }
    setImmediate(async () => {
      try {
        const title = await generate(message, kind)
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
      kind?: string
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
      kind: spec.kind ?? null,
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

    const plugins = this.buildPlugins(taskHome, info.kind)
    const acceptanceGuide =
      identity === "doer" && !readOnly && info.awaitingReview && !!wsPath && acceptancePlanReady(task.id)
    const archiveGuide = identity === "doer" && info.status === "archiving"
    const archiveConsent = identity === "doer" && awaitingArchive
    const guard = this.buildGuard(identity, { taskHome, wsPath, readOnly, taskId: task.id })
    const { head: contextHead, playbook: contextPlaybook } = this.buildContext(info, {
      identity,
      spec,
      view,
      acceptanceGuide,
      archiveGuide,
      archiveConsent,
    })
    const context = [contextHead, contextPlaybook].filter(Boolean).join("\n")

    return {
      task: info,
      identity,
      cwd,
      plugins,
      guard,
      context,
      contextHead,
      contextPlaybook,
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

  /** Stable set for the whole thread. Workflow-dev tasks swap the task-author
   *  fork for the workflow-author fork (persona + octo-workflow-* skills); the
   *  shared agent dir and task home stay so skills never appear/disappear. */
  private buildPlugins(taskHome: string, kind: string | null): Array<{ type: "local"; path: string }> {
    const cloneDir =
      kind === "workflow-dev" ? "workflow-author" : kind === "clone-dev" ? "clone-author" : "task-author"
    const plugins: Array<{ type: "local"; path: string }> = [
      { type: "local", path: getAgentDir() },
      { type: "local", path: getBuiltInCloneDir(cloneDir) },
    ]
    if (existingDir(taskHome)) plugins.push({ type: "local", path: taskHome })
    return plugins
  }

  private buildGuard(
    identity: TaskThreadIdentity,
    input: { taskHome: string; wsPath: string | null; readOnly: boolean; taskId: string },
  ): TaskThreadGuard | undefined {
    if (identity === "author") {
      return buildPathGuard(
        input.taskHome,
        path.join(getBuiltInCloneDir("task-author"), "memory"),
      ) as TaskThreadGuard
    }
    if (identity === "doer" && !input.readOnly && input.wsPath) {
      // 验收期也走同一道 doer 批次护栏：只写工作区 projects/**，.scratch 批次
      // 目录仍只读。2026-11-23 #11：≤2 文件小修上限与 task-fix 升级出口已删除 ——
      // 打回后由 doer 自己规划、在工作区原地修。
      return buildDoerBatchGuard(input.wsPath, input.taskId) as TaskThreadGuard
    }
    return buildReadOnlyGuard()
  }

  /**
   * Split the per-turn <system-reminder> into two parts:
   *   - head     — the status line (task / status / phase · round). Refreshed
   *                EVERY turn: the model must see state changes immediately.
   *   - playbook — identity + discipline + tools + guides. Changes only on
   *                identity/state transitions, so the chat route sends it once
   *                per change (hash-gated) instead of re-paying for it each turn.
   * The joined `context` is kept for tests/debug surfaces.
   */
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
  ): { head: string; playbook: string } {
    const label = STATUS_LABEL[info.displayStatus] ?? info.displayStatus
    const coord =
      info.phaseIndex != null
        ? `Phase ${info.phaseIndex}${info.roundIndex != null ? ` · Round ${info.roundIndex}` : ""}`
        : "尚未开始"
    const head = `[任务线程] 任务：${info.name}（id: ${info.id}）· 状态：${label} · ${coord}`

    if (extra.identity === "author" && info.kind === "clone-dev") {
      return {
        head,
        playbook: [
          "[身份] 铸分身者（clone-author）。交付物是一个能用的分身：persona + skills +（可选）进程内工具包。",
          `[任务 home] ${info.taskHome} · 分身目录 ~/.octopus/agent/clones/<name>/ · 工具包 packages/clone-kits/<slug>/`,
          "[一次一问] 按顺序问清三件事：代号（slug）→ 人格（3–5 条可执行准则）→ 工具清单（要不要可执行工具；要就每个一行）。每问都给推荐答案。",
          "[登记] 用户确认后调 clone_dev_set_meta 写入 clone_name / mode / kit 声明；代号一旦写入不可改名。",
          "[实现] 人格写 persona.md；技能写 skills/<name>/SKILL.md；工具代码写 packages/clone-kits/<slug>/index.ts（用 _sdk 的 defineTool + buildServer），并导出 selfTest。改完跑 `node scripts/build-clone-kits.mjs` 生成 dist（验证与运行都读 dist）。",
          "[验证] 调 clone_dev_verify；三条硬判据必须全绿：工具可用 / 越权被拦 / 身份可用。改过工具代码后必须重跑。",
          "[收尾] 向用户报告文件与验证结果，然后 clone_dev_finish 进入「待合入」。合入由人拍板，不自己 merge、不自己 archive。",
          "[硬边界] 不改 shared / server / engine / web-app；需要核心配合时停下来列「核心改动清单」请用户确认。",
          "[状态感知] 状态以 get_task_status / clone_dev_get_state 为准。",
        ].join("\n"),
      }
    }

    if (extra.identity === "author" && info.kind === "workflow-dev") {
      return {
        head,
        playbook: [
          "[身份] 工作流开发者（workflow-author）。交付物是工作流 YAML，不是代码；只写 task home，project 仓库只读。",
          `[任务 home] ${info.taskHome} · 工作流目录 ${path.join(info.taskHome, "workflows")}`,
          "[一次一个] 当前工作流未完成（校验+仿真通过，且用户已决定 release/snapshot）前，不得开始下一个。",
          "[流程] 1 盘点现有工作流（list_workflows / get_workflow）→ 2 澄清需求（一次一问）→ 3 给出雏形与推荐方向，**等用户确认** → 4 写 YAML → 5 validate_workflow → 6 写 fixture + simulate_workflow → 7 用户同意后 run_workflow → 8 失败先诊断再修 → 9 问 release/snapshot 后 complete_workflow → 10 问是否继续；全部完成调 finish_workflow_dev，再问是否归档。",
          "[工具] 工作流盘点/运行/调试走 octopus-workflow（list_workflows / get_workflow / validate_workflow / simulate_workflow / run_workflow / get_execution / cancel_execution / pause_execution / resume_execution / retry_node / rerun_execution / diagnose_execution / reload_execution_workflow）。",
          "[任务工具] set_active_workflow（登记/切换当前工作流）、get_workflow_dev_state、complete_workflow（release|snapshot）、finish_workflow_dev、add_workspace_projects（把项目引入当前 workspace）。",
          "[运行硬闸] 未通过基础校验或仿真时 run_workflow 会拒绝；只有用户明确要求豁免时才可传 waiver 并说明原因。改过 YAML 后旧结果自动失效，必须重跑。",
          "[release] release = 复制到主 Agent 工作区 workflows/，默认对话可见；snapshot 只留在任务侧。必须问用户，不得默认 release。",
          "[收尾] 用户明确说「归档」后才调 start_archive；不要自己归档，也不要声称 done。",
          "[状态感知] 任务状态变化会以事件卡出现在本会话；每轮也会刷新上面这行状态。",
        ].join("\n"),
      }
    }

    if (extra.identity === "author") {
      const phaseLines =
        extra.spec.phases?.length
          ? extra.spec.phases.map((p) => `P${p.index} ${p.name}${p.workflowRef ? ` → ${p.workflowRef}` : ""}`).join("；")
          : "尚未拆 phase"
      return {
        head,
        playbook: [
          "[身份] 任务作者。把需求澄清成 v4 task_spec；只写 task home，project 仓库只读；不跑开发/构建/测试，不 commit/push。",
          `[任务 home] ${info.taskHome}`,
          `[phases] ${phaseLines}`,
          "[写规格] 优先用任务工具 update_task_spec_field（或 POST /api/tasks/:id/spec-field），不要整段覆盖 phases。",
          "[收尾] 规格与 phase 绑定齐了、入队 gate 自查通过后，**直接调 launch_task 开跑**，不必等用户点卡或另行说「立即执行」；开跑后用一句话告诉用户。只有用户明确说「先入列 / 等一下 / 定时」时才用 enqueue_task / 定时触发。启动方式确实需要用户选（比如要定时间窗）时才用 propose_launch 出卡。",
          "[状态感知] 入列/触发/验收等状态变化会以事件卡出现在本会话；每轮也会刷新上面这行状态。",
        ].join("\n"),
      }
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
        "  3. 一次只推进**一条场景**：按 steps 讲清「打开哪 → 做什么 → 看到什么」，然后问「通过 / 不通过 / 跳过」。**提问一律用对话正文，不要调用 AskUserQuestion**（选项卡会打断逐条引导；验收卡只是快捷方式）。用户要看页面就 start_acceptance_preview（结束 stop_acceptance_preview）；**只有用户点名要新结果时**才 run_acceptance_probe 跑某条机器证据。",
        "  4. 用户**在对话里明确表态**（「通过」「可以」「不行，因为…」「跳过」）即可直接调 record_acceptance_check（confirmed=true），只对场景；卡片只是快捷方式。不要代替用户判断、不要批量代勾，也不要把机器证据当成人工勾选项。",
        "  5. 用户说不通过 → 自己规划修复：直接在工作区改（只改与该问题直接相关的代码，不限文件数；不改 spec/票），跑验证，改完按场景重新看一遍并把结果讲给用户，再问一次是否通过 —— 改完不等于通过，绝不默认勾上。",
        "  6. 修不完或需要动规格/结构 → 把原因说清楚并开票留档（`Status: ready-for-agent`；要人定方向的用 `ready-for-human`），不要硬改、不要扩权。",
        "  7. 场景都有结论后，先做**放行前终检**：再调一次 get_acceptance_plan 看 postRound（末轮之后的新提交 / 未提交文件），把现场用一两句话讲给用户。有未提交改动就提醒：归档 preflight 会先拦下，届时再选「纳入 / 排除」，或现在先改完再放行。确认无遗漏后再问要不要「放行」或「退回修改」。",
        "  8. 用户**明确表态**后由你收口：放行 → submit_acceptance_decision(decision=\"accepted\", confirmed=true)；退回 → submit_acceptance_decision(decision=\"rejected\", feedback=用户说的原因, confirmed=true)。人点验收台是兜底，不是必需；但没有明确表态绝不放行、绝不退回，也不要把未勾场景当成通过。",
      ] : []
      const archiveLines = extra.archiveGuide ? [
        "[归档引导] 末 phase 已放行，任务处于 archiving（只读；归档编排由服务端执行）。你的角色是播报 + 逐条问反思与 wiki 冲突 + 执行用户的口头决定：",
        "  1. 先调 get_archive_state 读 git 同步 / project 失败 / 术语冲突 / 反思 / 知识包状态 / knowledge.findings（本次编译出的未决矛盾）。",
        "  2. 用一两句人话播报进度和你在等什么；不要贴表格或逐项清单 —— 明细让用户点总框里的「打开归档台看明细」。",
        "  3. 若 knowledge.findings 非空：一次只问一条，说明「旧断言 vs 新断言、涉及哪两页」，问「采纳修订 / 忽略 / 讨论」。用户明确表态后调 resolve_wiki_finding(finding_id, action, confirmed=true) 并回执；不要替人决定，不要批量。",
        "  4. 调 propose_wiki_entries 给出 2–5 条建议（它不再落卡片），然后**一次只问一条**：要不要落 wiki。",
        "  5. 用户说「落 / 跳过 / 都跳过 / 都落」→ 逐条 record_reflection_decision(confirmed=true) 执行并回执；不要代替人决定。",
        "  6. 归档失败：说清是哪个 project、什么原因；用户明确说「重试」→ retry_archive(confirmed=true)。",
        "  7. 若 preflight 提示有未提交改动：问用户「纳入归档」还是「排除并记录」，明确表态后调 resolve_archive_delta(decision, confirmed=true)；不要自己决定。",
        "  8. 不要声称已完成 —— done 由服务端在全部 project 的 git 同步成功后才写入。",
        "  9. 两阶段纪律：done 只判定 git；知识沉淀（素材包编译）可能延续到 done 之后几分钟，编译若产生断言矛盾会另发 finding 卡 —— 那是归档的第二阶段，不是 done 返工。done 之后才冒出的 finding 也按同样方式逐条问、逐条裁决。",
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
      if (info.kind === "clone-dev") {
        const devLine = info.displayStatus === "awaiting_archive"
          ? "[分身开发] 验证已全绿，任务停在「待合入」。只读：不要改工具/人格；只能确认合入或中止。"
          : info.displayStatus === "archiving"
            ? "[分身开发] 合入进行中：只读；可以复述 merge / 装包 / 注册结果。"
            : "[分身开发] 当前没有在开发的阶段。"
        return {
          head,
          playbook: [
            ...consentLines,
            ...archiveLines,
            devLine,
            "[身份] 铸分身者（clone-author）。分身开发已完成；合入由服务端执行。",
            "[跟进] 用户要再改分身时，先确认是开新任务还是回草稿；不要在待合入态直接改文件。",
            "[状态感知] 任务状态变化会以事件卡出现在本会话。",
          ].filter(Boolean).join("\n"),
        }
      }

      if (info.kind === "workflow-dev") {
        const devLine = info.displayStatus === "awaiting_archive"
          ? "[工作流开发] 全部工作流已完成，任务停在「待归档」。只读：不要改 YAML；只能确认是否归档或中止。"
          : info.displayStatus === "archiving"
            ? "[工作流开发] 归档编排进行中：只读；可以复述归档结果、冲突与重试问题。"
            : "[工作流开发] 当前没有在开发的阶段。"
        return {
          head,
          playbook: [
            ...consentLines,
            ...archiveLines,
            devLine,
            "[身份] 工作流开发者（workflow-author）。工作流开发已完成；归档由服务端执行。",
            "[跟进] 用户要再开发工作流时，先确认是开新任务还是回草稿；不要在归档态直接改文件。",
            "[状态感知] 任务状态变化会以事件卡出现在本会话。",
          ].filter(Boolean).join("\n"),
        }
      }

      return {
        head,
        playbook: [
          ...guideLines,
          ...archiveLines,
          ...consentLines,
          "[身份] 任务执行者。接住作者谈好的 spec / 批次 / 运行手册，在执行工作区里按用户指令改代码。",
          `[执行工作区] ${info.wsPath ?? "尚未绑定（等待触发）"}${info.branch ? ` · 分支 ${info.branch}` : ""}`,
          readOnlyLine,
          quickEditLine,
          "[提问] 执行期遇到必须人拍板的阻断问题（授权边界 / 取舍 / 冲突处理 / 范围变更）用 AskUserQuestion 一次一问 —— 卡片会自动投到舱主对话与 inbox，人答完你继续；验收的逐场景引导仍用对话正文，不要用 AskUserQuestion。",
          `[改计划] 改 spec/票只能走计划回写：${planCmd}（批次目录只读，直接改会被硬闸拒绝）。`,
          "[动作] 触发：任务已入列(ready)且该开跑时，**直接调 trigger_task**，不必等用户明确说「开跑」，也不必用确认卡；开跑后一句话告知。暂停 / 恢复 / 中止 / 重试归档仍默认用 request_task_action 落确认卡（破坏性或方向性动作由人拍板）；用户明确表态后可直接执行。验收的通过/打回在用户明确表态后调 submit_acceptance_decision 收口（人点验收台是兜底）。",
          "[状态感知] 任务状态变化会以事件卡出现在本会话；每轮也会刷新上面这行状态。",
        ].filter(Boolean).join("\n"),
      }
    }

    return {
      head,
      playbook: [
        "[身份] 只读回顾。任务已结束/归档，不再改代码或规格。",
        `[任务 home] ${info.taskHome}${info.wsPath ? ` · 执行工作区 ${info.wsPath}` : ""}`,
        "[归档复盘] 可用 get_archive_state 复述归档结果、冲突与反思；knowledge.findings 是归档第二阶段（知识沉淀编译）产生的未决矛盾，不是 done 的返工；用户明确表态后可逐条 resolve_wiki_finding；未决反思可按用户明确表态继续 record_reflection_decision 落/跳过。",
        "[归档增补] 用户要补充/修正归档内容时，用 record_archive_amendment(confirmed=true) 追加只增不改的记录（可选同时落 wiki）；不要改写原报告。",
        "[跟进任务] 用户要再改代码/继续开发时，用 open_followup_task(confirmed=true) 开一个继承 spec 的新任务；旧任务保持 done 不可变，不要在这里写代码。",
      ].join("\n"),
    }
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

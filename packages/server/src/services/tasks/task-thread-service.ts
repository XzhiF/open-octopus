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
import { buildDoerBatchGuard, buildPathGuard } from "../agent/clone-runtime"
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
}

export interface TaskThreadDeps {
  db: Database.Database
  taskDAO?: TaskDAO
  executionDAO?: ExecutionDAO
  acceptanceDAO?: AcceptanceDAO
  workspaceService?: WorkspaceService
  taskHomeService?: TaskHomeService
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

  constructor(deps: TaskThreadDeps) {
    this.taskDAO = deps.taskDAO ?? new TaskDAO(deps.db)
    this.executionDAO = deps.executionDAO ?? new ExecutionDAO(deps.db)
    this.acceptanceDAO = deps.acceptanceDAO ?? new AcceptanceDAO(deps.db)
    this.workspaceService = deps.workspaceService ?? new WorkspaceService()
    this.taskHomeService = deps.taskHomeService ?? new TaskHomeService()
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
    const workspace = task.workspace_id ? this.workspaceService.getById(task.workspace_id) : undefined
    const wsPath = workspace ? expandHome(workspace.path) : null
    // ready has no execution workspace yet, so a doer turn can only read for now.
    const readOnly =
      identity === "base" || task.status === "archiving" || (identity === "doer" && !wsPath)

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
    const guard = this.buildGuard(identity, { taskHome, wsPath, readOnly, taskId: task.id })
    const context = this.buildContext(info, { identity, spec, view })

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
    input: { taskHome: string; wsPath: string | null; readOnly: boolean; taskId: string },
  ): TaskThreadGuard | undefined {
    if (identity === "author") {
      return buildPathGuard(
        input.taskHome,
        path.join(getBuiltInCloneDir("task-author"), "memory"),
      ) as TaskThreadGuard
    }
    if (identity === "doer" && !input.readOnly && input.wsPath) {
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
      const readOnlyLine = info.status === "archiving"
        ? "[只读] 归档编排进行中：不要改代码或规格。可以读 task home / archive/report.md，回答归档结果、冲突与重试问题。"
        : "[写权] 只写执行工作区的 projects/**；工作区批次目录 .scratch 是计划副本，只读。"
      const quickEditLine = info.status === "archiving"
        ? ""
        : "[纪律] 每次有效编辑由 server 自动落 [quick-edit] commit，不要自己 git commit/push。"
      return [
        head,
        "[身份] 任务执行者。接住作者谈好的 spec / 批次 / 运行手册，在执行工作区里按用户指令改代码。",
        `[执行工作区] ${info.wsPath ?? "尚未绑定（等待触发）"}${info.branch ? ` · 分支 ${info.branch}` : ""}`,
        readOnlyLine,
        quickEditLine,
        `[改计划] 改 spec/票只能走计划回写：${planCmd}（批次目录只读，直接改会被硬闸拒绝）。`,
        "[动作] 触发/暂停/恢复/中止/重试归档请用任务工具 request_task_action（会落确认卡，人点才执行）；验收通过/打回由人在验收窗决策。",
        "[状态感知] 任务状态变化会以事件卡出现在本会话；每轮也会刷新上面这行状态。",
      ].filter(Boolean).join("\n")
    }

    return [
      head,
      "[身份] 只读回顾。任务已结束/归档，不再改代码或规格。",
      `[任务 home] ${info.taskHome}${info.wsPath ? ` · 执行工作区 ${info.wsPath}` : ""}`,
      "[可做] 复盘、解释归档结果/冲突、查产物与用量；要再开发请开新任务或复制任务。",
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

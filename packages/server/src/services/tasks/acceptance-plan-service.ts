// packages/server/src/services/tasks/acceptance-plan-service.ts
//
// 验收方案预生成（2026-10-30 AI-native 验收）—— 每轮交付终态后，由一个**独立
// 的验收规划 Agent**（built-in/acceptance-plan 工作流）读本轮证据，产出
// `acceptance-plan-r{N}.json`，再唤醒主 Chat 逐步引导人验收。
//
// Why（用户 2026-10-30 拍板）：旧第三步把 spec 用户故事原句直接当核对项，人不知道
// 该验什么、怎么验。方案必须**前置生成**，不能等人打开验收窗才现编；且主 Chat 才是
// 引导主场，验收窗负责查询 + 人工兜底。
//
// 设计要点：
//   · 只读证据：server 先算好 acceptance-evidence-rN.json（批次文件 + 真实 diff +
//     verify/runbook + spec 路径），Agent 读它再按需读文件/跑只读 git，不自己猜范围。
//   · 不污染轮次口径：规划执行行 task_id = null（listTaskInstances 只认 task_id），
//     复用任务自己的执行工作区（allow_existing_root），跑完不留工作区垃圾。
//   · 幂等：按 task+phase+round 去重；ready 不再生成；generating 在飞不重入。
//   · 诚实降级：Agent 失败 / 方案非法 → status=failed + SSE，getPlaybook 回退旧编译，
//     绝不阻塞验收。kill switch: OCTOPUS_ACCEPTANCE_PLAN=off。
//   · 人只签字：方案里的 machine 只是建议，最终决策仍在验收台/台账。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import path from "path"
import type Database from "better-sqlite3"
import { TASK_ACCEPTANCE_PLAN_EVENT, type AcceptanceRunbook, type AcceptanceVerify, type TaskSpec } from "@octopus/shared"
import { ExecutionDAO } from "../../db/dao"
import type { ExecutionRow } from "../../db/types"
import type { SSEService } from "../sse"
import type { WorkspaceService } from "../workspace"
import { getExecutionService } from "../execution-service-registry"
import { getChatEventBridge } from "../activity/chat-event-bridge"
import type { TasksService } from "./tasks-service"
import type { TaskHomeService } from "./task-home-service"
import type { RoundEvidenceService } from "./round-evidence-service"
import type { ChecksFile, PlaybookPayload } from "./playbook-types"
import { checksFileName, parseChecksMd } from "./playbook-compile"
import {
  AcceptancePlanSchema,
  planEvidenceName,
  planJsonName,
  planMdName,
  planStatusName,
  planToPlaybook,
  renderPlanMd,
  type AcceptanceEvidenceManifest,
  type AcceptancePlan,
  type AcceptancePlanStatusFile,
  type PlanSummary,
} from "./acceptance-plan-types"

export const ACCEPTANCE_PLAN_WORKFLOW_REF = "built-in/acceptance-plan"

/** 15 分钟还没落地就当上一次生成已死（server 重启/执行被清理）→ 允许重来。 */
const GENERATING_STALE_MS = 15 * 60 * 1000

export interface AwaitingRoundInfo {
  execRow: ExecutionRow
  phaseIndex: number
  roundIndex: number
  batchRelDir: string | null
}

export interface PlanProgress {
  total: number
  pass: number
  fail: number
  skip: number
  decided: number
  undecided: number
  next_item_id: string | null
}

export interface PlanDetail {
  status: PlanSummary
  plan: AcceptancePlan | null
  checks: ChecksFile | null
  progress: PlanProgress | null
  paths: { json: string | null; md: string | null }
  /** server 校验发现的矛盾项（给人看的诚实提示）。 */
  warnings: string[]
}

export class AcceptancePlanService {
  private readonly execDao: ExecutionDAO
  private readonly inFlight = new Map<string, Promise<void>>()

  constructor(
    db: Database.Database,
    private readonly sse: SSEService,
    private readonly tasksService: TasksService,
    private readonly workspaceService: WorkspaceService,
    private readonly taskHome: TaskHomeService,
    private readonly roundEvidence: RoundEvidenceService,
  ) {
    this.execDao = new ExecutionDAO(db)
  }

  // ── kill switch ────────────────────────────────────────────────────

  private enabled(): boolean {
    return (process.env.OCTOPUS_ACCEPTANCE_PLAN ?? "").trim().toLowerCase() !== "off"
  }

  // ── read side (sync — getPlaybook / 主 Chat 工具共用) ───────────────

  /** 当前 awaiting 轮的方案状态 + 方案（若已 ready）。无 awaiting → null。 */
  planState(taskId: string): { summary: PlanSummary; plan?: AcceptancePlan } | null {
    let info: AwaitingRoundInfo
    try {
      info = this.roundEvidence.awaitingRoundInfo(taskId)
    } catch {
      return null
    }
    return this.planStateFor(taskId, info)
  }

  /** 任意轮坐标的方案状态（2026-10-30 归档只读回看复用同一读取规则）。 */
  planStateFor(taskId: string, info: AwaitingRoundInfo): { summary: PlanSummary; plan?: AcceptancePlan } {
    if (!info.batchRelDir) {
      return { summary: { status: "missing", error: "specPath 为绝对路径，没有批次目录可落方案" } }
    }
    const status = this.readStatusFile(taskId, info.batchRelDir, info.roundIndex)
    const summary: PlanSummary = {
      status: status?.status ?? "missing",
      ...(status?.finished_at ? { generated_at: status.finished_at } : {}),
      ...(status?.error ? { error: status.error } : {}),
      ...(status?.plan_path ? { source: status.plan_path } : {}),
    }
    if ((status?.status ?? "missing") === "ready") {
      const plan = this.readPlanFile(taskId, info.batchRelDir, info.roundIndex)
      if (!plan) {
        return { summary: { ...summary, status: "failed", error: "方案文件缺失或未通过校验" } }
      }
      return { summary, plan }
    }
    return { summary }
  }

  /** getPlaybook 的快路径：plan ready → 直接给映射后的 PlaybookPayload，否则 null。 */
  tryBuildPlaybook(taskId: string): PlaybookPayload | null {
    const st = this.planState(taskId)
    if (!st?.plan) return null
    return planToPlaybook(st.plan, st.summary)
  }

  /** 指定轮的同款快路径（历史轮只读回看）。 */
  tryBuildPlaybookFor(taskId: string, info: AwaitingRoundInfo): PlaybookPayload | null {
    const st = this.planStateFor(taskId, info)
    if (!st.plan) return null
    return planToPlaybook(st.plan, st.summary)
  }

  /** TaskThreadService 用的轻量谓词：本轮方案是否已 ready（决定是否进入引导态）。 */
  isReady(taskId: string): boolean {
    try {
      return this.planState(taskId)?.summary.status === "ready"
    } catch {
      return false
    }
  }

  /** 给主 Chat 工具/窗口的完整只读快照（方案 + checks + 进度）。 */
  getPlanDetail(taskId: string): PlanDetail {
    const st = this.planState(taskId)
    if (!st) throw new Error("当前没有待验收的轮次 — 验收方案只针对 awaiting_review 的轮")
    const info = this.roundEvidence.awaitingRoundInfo(taskId)
    const checks = info.batchRelDir ? this.readChecks(taskId, info.batchRelDir, info.roundIndex) : null
    const plan = st.plan ?? null
    const progress = plan ? computeProgress(plan, checks) : null
    return {
      status: st.summary,
      plan,
      checks,
      progress,
      paths: info.batchRelDir
        ? {
            json: `${info.batchRelDir}/${planJsonName(info.roundIndex)}`,
            md: `${info.batchRelDir}/${planMdName(info.roundIndex)}`,
          }
        : { json: null, md: null },
      warnings: plan?.warnings ?? [],
    }
  }

  readChecks(taskId: string, batchRelDir: string, roundIndex: number): ChecksFile | null {
    try {
      const raw = this.taskHome.readHomeFile(taskId, `${batchRelDir}/${checksFileName(roundIndex)}`).content
      return parseChecksMd(raw)
    } catch {
      return null
    }
  }

  private readStatusFile(taskId: string, batchRelDir: string, roundIndex: number): AcceptancePlanStatusFile | null {
    try {
      const raw = readFileSync(this.planAbsPath(taskId, batchRelDir, planStatusName(roundIndex)), "utf-8")
      const o = JSON.parse(raw) as AcceptancePlanStatusFile
      return o && typeof o === "object" && typeof o.status === "string" ? o : null
    } catch {
      return null
    }
  }

  private readPlanFile(taskId: string, batchRelDir: string, roundIndex: number): AcceptancePlan | null {
    let raw: string
    try {
      raw = readFileSync(this.planAbsPath(taskId, batchRelDir, planJsonName(roundIndex)), "utf-8")
    } catch {
      return null
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(stripFence(raw))
    } catch {
      return null
    }
    const res = AcceptancePlanSchema.safeParse(parsed)
    return res.success ? res.data : null
  }

  // ── ensure / generate ──────────────────────────────────────────────

  /** 终态 hook 与 GET /playbook 的懒触发共用入口：按 awaiting 轮取坐标后生成。 */
  ensureForAwaiting(taskId: string): Promise<void> {
    if (!this.enabled()) return Promise.resolve()
    let info: AwaitingRoundInfo
    try {
      info = this.roundEvidence.awaitingRoundInfo(taskId)
    } catch {
      return Promise.resolve() // 没有待验收轮 —— 无事可做
    }
    return this.ensure(taskId, info)
  }

  async ensure(taskId: string, info: AwaitingRoundInfo, opts: { force?: boolean } = {}): Promise<void> {
    if (!this.enabled()) return
    const { phaseIndex, roundIndex, batchRelDir, execRow } = info
    if (!batchRelDir) return // absolute specPath bypass — no batch dir to host the plan
    const key = `${taskId}:${phaseIndex}:${roundIndex}`
    const existing = this.inFlight.get(key)
    if (existing) return existing

    const status = this.readStatusFile(taskId, batchRelDir, roundIndex)
    if (!opts.force) {
      if (status?.status === "ready") return
      if (status?.status === "failed") return // 失败不自动重试（人点重新生成才走 regenerate）
      if (status?.status === "generating" && this.isFresh(status.started_at)) return
    }

    const run = this.generate(taskId, info).finally(() => {
      this.inFlight.delete(key)
    })
    this.inFlight.set(key, run)
    return run
  }

  /** 只在「本轮还没有任何人工勾选」时允许重生成（保留人的决策）。 */
  async regenerate(taskId: string): Promise<{ ok: boolean; reason?: string }> {
    if (!this.enabled()) return { ok: false, reason: "验收方案生成已关闭（OCTOPUS_ACCEPTANCE_PLAN=off）" }
    let info: AwaitingRoundInfo
    try {
      info = this.roundEvidence.awaitingRoundInfo(taskId)
    } catch (err: unknown) {
      return { ok: false, reason: err instanceof Error ? err.message : "没有待验收轮" }
    }
    if (!info.batchRelDir) return { ok: false, reason: "没有批次目录可落方案" }
    const checks = this.readChecks(taskId, info.batchRelDir, info.roundIndex)
    if (checks && Object.keys(checks.checks ?? {}).length > 0) {
      return { ok: false, reason: "本轮已有人工勾选 —— 重生成会作废人的判定，已拒绝" }
    }
    await this.ensure(taskId, info, { force: true })
    return { ok: true }
  }

  private isFresh(startedAt: string | undefined): boolean {
    if (!startedAt) return false
    const ms = Date.parse(startedAt)
    return Number.isFinite(ms) && Date.now() - ms < GENERATING_STALE_MS
  }

  private async generate(taskId: string, info: AwaitingRoundInfo): Promise<void> {
    const { phaseIndex, roundIndex, batchRelDir, execRow } = info
    const batchRel = batchRelDir as string
    try {
      const ws = this.workspaceService.getById(execRow.workspace_id)
      if (!ws || !existsSync(ws.path)) {
        throw new Error("任务工作区已不在 —— 验收方案无法取证（可用旧清单人工验收）")
      }
      const task = this.tasksService.getTask(taskId)
      const spec = (task.task_spec ?? {}) as TaskSpec
      const phase = (spec.phases ?? [])[phaseIndex - 1]
      const phaseName = phase?.name ?? `Phase ${phaseIndex}`
      const batchAbs = path.join(this.taskHome.homePath(taskId), batchRel)
      mkdirSync(batchAbs, { recursive: true })

      this.writeStatus(taskId, batchRel, roundIndex, {
        status: "generating",
        started_at: new Date().toISOString(),
      })
      this.emit(taskId, phaseIndex, roundIndex, "generating")

      const manifest = await this.buildManifest(taskId, info, { phaseName, goal: phase?.name ?? "" })
      const evidenceAbs = path.join(batchAbs, planEvidenceName(roundIndex))
      writeFileSync(evidenceAbs, JSON.stringify(manifest, null, 2), "utf-8")

      const planJsonAbs = path.join(batchAbs, planJsonName(roundIndex))
      const planMdAbs = path.join(batchAbs, planMdName(roundIndex))
      // 工作流 bash 节点跑在 Git Bash：Windows 反斜杠绝对路径在那里不可靠，
      // 统一转正斜杠（`C:/x/…` 在 Git Bash 与 Node Write 里都成立）。
      const posix = (p: string): string => p.replace(/\\/g, "/")
      const inputValues: Record<string, string> = {
        task_id: taskId,
        task_name: taskNameOf(task),
        phase_index: String(phaseIndex),
        round_index: String(roundIndex),
        evidence_path: posix(evidenceAbs),
        batch_dir: posix(batchAbs),
        plan_json_path: posix(planJsonAbs),
        plan_md_path: posix(planMdAbs),
      }

      const registry = getExecutionService(execRow.workspace_id)
      if (!registry) throw new Error(`工作区 ${execRow.workspace_id} 不可用（执行服务缺失）`)
      const execution = registry.service.create(execRow.workspace_id, {
        workflow_ref: ACCEPTANCE_PLAN_WORKFLOW_REF,
        name: `acceptance-plan-${taskId.slice(0, 8)}-p${phaseIndex}-r${roundIndex}`,
        triggered_by: "acceptance-plan",
        input_values: inputValues,
        // 不挂 task_id —— round 口径（listTaskInstances）完全不认它。
        task_id: null,
        allow_existing_root: true,
      })
      this.execDao.updateExecution(execution.id, {
        pipeline_config: JSON.stringify({
          acceptance_plan: true,
          task_id: taskId,
          phase_index: phaseIndex,
          round_index: roundIndex,
        }),
      })
      registry.service.registerExternalCallbacks(
        {
          onComplete: ((_args?: unknown) => {
            void this.finalize(taskId, info, execution.id)
          }) as never,
          onError: ((_args?: unknown) => {
            void this.finalize(taskId, info, execution.id)
          }) as never,
        } as never,
        execution.id,
      )
      registry.service.start(execution.id, inputValues).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err)
        console.error(`[acceptance-plan] start failed for task ${taskId}:`, msg)
        this.markFailed(taskId, batchRel, roundIndex, phaseIndex, `规划工作流启动失败：${msg}`)
      })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[acceptance-plan] generate failed for task ${taskId}:`, msg)
      this.markFailed(taskId, batchRel, roundIndex, phaseIndex, msg)
    }
  }

  /** 执行终态：读盘校验 → 规范化 → ready + SSE + 唤醒主 Chat；失败则 failed + SSE。 */
  private async finalize(taskId: string, info: AwaitingRoundInfo, executionId: string): Promise<void> {
    const { batchRelDir, roundIndex, phaseIndex } = info
    if (!batchRelDir) return
    try {
      const raw = this.readPlanFile(taskId, batchRelDir, roundIndex)
      if (!raw) {
        this.markFailed(taskId, batchRelDir, roundIndex, phaseIndex, "规划 Agent 未产出合法方案文件（acceptance-plan-rN.json 缺失或不合规）", executionId)
        return
      }
      const plan = this.normalizePlan(taskId, raw, info)
      const jsonAbs = this.planAbsPath(taskId, batchRelDir, planJsonName(roundIndex))
      writeFileSync(jsonAbs, JSON.stringify(plan, null, 2), "utf-8")
      const mdAbs = this.planAbsPath(taskId, batchRelDir, planMdName(roundIndex))
      if (!existsSync(mdAbs)) writeFileSync(mdAbs, renderPlanMd(plan), "utf-8")

      this.writeStatus(taskId, batchRelDir, roundIndex, {
        status: "ready",
        started_at: this.readStatusFile(taskId, batchRelDir, roundIndex)?.started_at,
        finished_at: new Date().toISOString(),
        execution_id: executionId,
        plan_path: `${batchRelDir}/${planJsonName(roundIndex)}`,
      })
      this.emit(taskId, phaseIndex, roundIndex, "ready", undefined, `${batchRelDir}/${planJsonName(roundIndex)}`)
      // 主 Chat 引导（fire-and-forget；bridge 自己防重复 + 只认主线程会话）
      try {
        getChatEventBridge().requestAcceptanceGuide(taskId, {
          phaseIndex,
          roundIndex,
          itemCount: plan.items.length,
          goal: plan.goal || undefined,
        })
      } catch {
        /* 唤醒失败不阻塞验收 —— 人可以自己打开验收台 */
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[acceptance-plan] finalize failed for task ${taskId}:`, msg)
      this.markFailed(taskId, batchRelDir, roundIndex, phaseIndex, msg, executionId)
    }
  }

  private markFailed(
    taskId: string,
    batchRelDir: string,
    roundIndex: number,
    phaseIndex: number,
    error: string,
    executionId?: string,
  ): void {
    try {
      this.writeStatus(taskId, batchRelDir, roundIndex, {
        status: "failed",
        started_at: this.readStatusFile(taskId, batchRelDir, roundIndex)?.started_at,
        finished_at: new Date().toISOString(),
        error,
        ...(executionId ? { execution_id: executionId } : {}),
      })
    } catch { /* best-effort */ }
    this.emit(taskId, phaseIndex, roundIndex, "failed", error)
    try {
      getChatEventBridge().notifyAcceptancePlanFailed(taskId, error)
    } catch { /* best-effort */ }
  }

  // ── normalization / evidence ───────────────────────────────────────

  /** 规范化 + 诚实校验：id 前缀/去重、evidence 路径存在性、覆盖来源。 */
  private normalizePlan(taskId: string, plan: AcceptancePlan, info: AwaitingRoundInfo): AcceptancePlan {
    const warnings = [...plan.warnings]
    const home = this.taskHome.homePath(taskId)
    const seen = new Set<string>()
    const items = plan.items.map((it, i) => {
      let id = it.id.trim()
      if (!/^plan:/.test(id)) id = `plan:${it.ticket}:${i + 1}`
      while (seen.has(id)) id = `${id}-${i + 1}`
      seen.add(id)
      const evidenceRefs = it.evidenceRefs.map((e) => {
        if (!e.path) return e
        const p = e.path.trim()
        if (!p) return e
        const abs = path.isAbsolute(p) ? p : path.join(home, p.replace(/\\/g, "/"))
        const ok = existsSync(abs)
        if (!ok && !e.missing) {
          warnings.push(`「${it.title}」的证据 ${e.label} 路径不存在：${p}`)
          return { ...e, missing: true }
        }
        return e
      })
      return { ...it, id, evidenceRefs }
    })
    const generatedAt = plan.generated_at || new Date().toISOString()
    return {
      ...plan,
      version: "1",
      task_id: taskId,
      phase_index: info.phaseIndex,
      round_index: info.roundIndex,
      generated_at: Number.isNaN(Date.parse(generatedAt)) ? new Date().toISOString() : generatedAt,
      items,
      warnings,
    }
  }

  private async buildManifest(
    taskId: string,
    info: AwaitingRoundInfo,
    extra: { phaseName: string; goal: string },
  ): Promise<AcceptanceEvidenceManifest> {
    const { phaseIndex, roundIndex, batchRelDir } = info
    const batchRel = batchRelDir as string
    const task = this.tasksService.getTask(taskId)
    const spec = (task.task_spec ?? {}) as TaskSpec
    let listing: Array<{ path: string; bytes: number }> = []
    try {
      listing = this.taskHome.listHomeDir(taskId, batchRel, true).map((e) => ({ path: e.path, bytes: e.bytes }))
    } catch {
      listing = []
    }
    const byBase = (re: RegExp): string | null => {
      const hit = listing.find((e) => re.test(e.path.split("/").pop() ?? ""))
      return hit ? hit.path : null
    }
    const e2ePaths = listing
      .filter((e) => /(^|\/)\d[\d.-]*e2e[^/]*\.md$/i.test(e.path))
      .map((e) => e.path)
      .sort((a, b) => parseInt(a.match(/\d+/)?.[0] ?? "0", 10) - parseInt(b.match(/\d+/)?.[0] ?? "0", 10))
    let repos: AcceptanceEvidenceManifest["repos"] = []
    try {
      const diff = await this.roundEvidence.getRoundDiff(taskId)
      repos = diff.repos
        .filter((r) => !r.expired)
        .map((r) => ({
          name: r.name,
          commits: r.commits,
          additions: r.additions,
          dels: r.dels,
          files: r.groups.flatMap((g) => g.files.map((f) => ({ path: f.path, adds: f.adds, dels: f.dels }))).slice(0, 300),
        }))
    } catch {
      repos = []
    }
    const home = this.taskHome.homePath(taskId)
    const batchAbs = path.join(home, batchRel)
    const posix = (p: string): string => p.replace(/\\/g, "/")
    return {
      task_id: taskId,
      task_name: taskNameOf(task),
      phase_index: phaseIndex,
      round_index: roundIndex,
      phase_name: extra.phaseName,
      goal: extra.goal,
      batch_rel_dir: batchRel,
      batch_abs_dir: posix(batchAbs),
      spec_path: byBase(/^spec\.md$/i) ?? byBase(/spec.*\.md$/i),
      round_report_path: byBase(/^round-report\.md$/i) ?? byBase(/round.*report.*\.md$/i),
      e2e_ticket_path: e2ePaths[e2ePaths.length - 1] ?? null,
      e2e_test_plan_path: byBase(/^e2e-test-plan\.md$/i),
      files: listing,
      repos,
      verify: (spec.acceptance_verify as AcceptanceVerify | undefined) ?? null,
      runbook: (spec.acceptance_runbook as AcceptanceRunbook | undefined) ?? null,
      acceptance_criteria: [],
      plan_output: {
        json_abs: posix(path.join(batchAbs, planJsonName(roundIndex))),
        md_abs: posix(path.join(batchAbs, planMdName(roundIndex))),
      },
      generated_at: new Date().toISOString(),
    }
  }

  // ── fs helpers (server-owned JSON lives in the batch dir; the .md home-file
  //    door is user-facing and rejects .json, so plans are written directly) ──

  private planAbsPath(taskId: string, batchRelDir: string, name: string): string {
    const home = path.resolve(this.taskHome.homePath(taskId))
    const abs = path.resolve(home, batchRelDir.replace(/\\/g, "/"), name)
    if (!abs.startsWith(home + path.sep)) throw new Error(`验收方案路径越界: ${abs}`)
    return abs
  }

  private writeStatus(
    taskId: string,
    batchRelDir: string,
    roundIndex: number,
    patch: Partial<AcceptancePlanStatusFile> & { status: AcceptancePlanStatusFile["status"] },
  ): void {
    const abs = this.planAbsPath(taskId, batchRelDir, planStatusName(roundIndex))
    mkdirSync(path.dirname(abs), { recursive: true })
    writeFileSync(abs, JSON.stringify(patch, null, 2), "utf-8")
  }

  private emit(
    taskId: string,
    phaseIndex: number,
    roundIndex: number,
    status: string,
    error?: string,
    source?: string,
  ): void {
    this.sse.emit("taskpool", {
      event: TASK_ACCEPTANCE_PLAN_EVENT,
      data: {
        task_id: taskId,
        phase_index: phaseIndex,
        round_index: roundIndex,
        status,
        ...(error ? { error } : {}),
        ...(source ? { source } : {}),
      },
    })
  }
}

// ── helpers ──────────────────────────────────────────────────────────

function taskNameOf(task: { name?: string | null; id: string }): string {
  return task.name ?? task.id.slice(0, 8)
}

/** 容忍 Agent 把 JSON 包在 ```json 围栏里（多数模型会自作主张加）。 */
function stripFence(s: string): string {
  const t = s.trim()
  const m = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(t)
  return m ? m[1] : t
}

// ── late-bound ready predicate (TaskThreadService 用它决定是否进入「验收引导」态) ──
// 任务线程/工具在服务构造顺序上早于 AcceptancePlanService（routes/agent/index.ts vs
// index.ts 装配块），所以走注册表而不是构造注入，避免循环 import。
let readyProvider: ((taskId: string) => boolean) | null = null

export function setAcceptancePlanReadyProvider(fn: ((taskId: string) => boolean) | null): void {
  readyProvider = fn
}

export function acceptancePlanReady(taskId: string): boolean {
  try {
    return readyProvider?.(taskId) ?? false
  } catch {
    return false
  }
}

export function computeProgress(plan: AcceptancePlan, checks: ChecksFile | null): PlanProgress {  const map = checks?.checks ?? {}
  let pass = 0
  let fail = 0
  let skip = 0
  for (const it of plan.items) {
    const d = map[it.id]?.decision
    if (d === "pass") pass++
    else if (d === "fail") fail++
    else if (d === "skip") skip++
  }
  const decided = pass + fail + skip
  const next = plan.items.find((it) => !map[it.id]) ?? null
  return {
    total: plan.items.length,
    pass,
    fail,
    skip,
    decided,
    undecided: plan.items.length - decided,
    next_item_id: next?.id ?? null,
  }
}

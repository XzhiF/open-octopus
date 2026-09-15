// all-sources-2 票02 —— CLI 真跑捕获（KD4 定案：直写中心库，见 issues/01 probe）。
// workflow run 的 onNodeEnd 终局处消耗 result.llmCalls/modelUsages → llm_calls 明细 +
// node_token_usages 账本行（账本=Σ明细，形状与 server chat 捕获同型）。
// SQL 单源 = @octopus/shared USAGE_WRITE_SQL（server DAO 与本文件共用，加列不漂移）。
//
// 归集降级路径（jsonl+server 归集）：probe 实测直写成功率 100%/零 busy 抛出，未启用 —— 票02 不建。
// PRAGMA 按 probe 同款：WAL + busy_timeout=5000 + synchronous=NORMAL。
// 捕获失败只 log stderr、不抛（观测永不阻断执行，同 server observability 纪律）。

import Database from "better-sqlite3"
import os from "os"
import path from "path"
import fs from "fs"
import {
  USAGE_WRITE_SQL,
  ledgerCostUsd,
  LLM_CALL_SOURCE,
  type ModelUsage,
} from "@octopus/shared"
import type { LLMCallRecord } from "@octopus/providers"

/** CLI 直写目标库：env 覆盖 → 默认中心库（probe 实测裸进程可解析可打开）。 */
export function resolveCliDbPath(): string {
  if (process.env.OCTOPUS_DB_PATH) return process.env.OCTOPUS_DB_PATH
  return path.join(os.homedir(), ".octopus", "db", "octopus.db")
}

/**
 * 打开直写库。文件不存在/表未建（server 从未初始化）→ null（本次 run 静默跳过捕获）。
 * 与 server 同款 PRAGMA；只读探测失败一律降级为 null，不让捕获炸掉 CLI。
 */
export function openUsageDb(dbPath: string = resolveCliDbPath()): Database.Database | null {
  if (!fs.existsSync(dbPath)) return null
  let db: Database.Database | null = null
  try {
    db = new Database(dbPath)
    db.pragma("journal_mode = WAL")
    db.pragma("busy_timeout = 5000")
    db.pragma("synchronous = NORMAL")
    const hasTable = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='llm_calls'")
      .get()
    if (!hasTable) { db.close(); return null }
    return db
  } catch (err) {
    console.error(`[cli-usage] 打开 ${dbPath} 失败（本次 run 不落库）:`, err instanceof Error ? err.message : String(err))
    try { db?.close() } catch { /* already dead */ }
    return null
  }
}

export interface CliUsageContext {
  /** KD6: trace_id = 本次 run 标识（CLI 生成、传入 WorkflowEngine.executionId） */
  runId: string
  org: string
  workflowRef: string
  nodeId: string
  /** chat 的 host 列成本不编数原则同 apply：CLI run 无 workspace 行 → NULL */
  workspaceId?: string | null
  sessionId?: string | null
}

/** cost 三态（给价→用；没给→价表估算；仍无→NULL）单源 = shared ledgerCostUsd（server 写入口同函数）。 */

/**
 * 一节点收尾 = 一事务：明细 INSERT OR IGNORE（确定式 id `cli:{run}:{messageId}` 防重放）+
 * 账本按 model 一行（id `cli:{run}:{node}:{model}`，存在即跳 —— 与 chat 捕获同款防双计；
 * UPSERT 累加语义留给 engine/harness 重跑路径，不在 CLI 触发）。
 */
export function captureNodeUsage(
  db: Database.Database,
  ctx: CliUsageContext,
  calls: LLMCallRecord[],
  modelUsages?: ModelUsage[],
): void {
  if (calls.length === 0 && (!modelUsages || modelUsages.length === 0)) return
  try {
    db.transaction(() => {
      const insertCall = db.prepare(USAGE_WRITE_SQL.insertLlmCall)
      calls.forEach((r, i) => {
        insertCall.run({
          id: `cli:${ctx.runId}:${r.messageId ?? `${ctx.nodeId}:${i}`}`,
          node_execution_id: null,
          execution_id: ctx.runId,
          turn_index: r.turnIndex,
          call_index: i,
          message_id: r.messageId ?? null,
          model: r.model ?? null,
          stop_reason: r.stopReason ?? null,
          timestamp: r.timestamp,
          duration_ms: r.durationMs,
          ttft_ms: r.ttftMs ?? null,
          input_tokens: r.inputTokens,
          output_tokens: r.outputTokens,
          cache_read_tokens: r.cacheReadTokens,
          cache_creation_tokens: r.cacheCreationTokens,
          cost_usd: ledgerCostUsd(r, r.model, r.costUsd),
          org: ctx.org,
          workspace_id: ctx.workspaceId ?? null,
          workflow_ref: ctx.workflowRef,
          node_id: ctx.nodeId,
          session_id: ctx.sessionId ?? null,
          instance_id: `cli-${process.pid}`,
          source: LLM_CALL_SOURCE.cli,
          trace_id: ctx.runId,
          span_id: r.messageId ?? null,
        })
      })

      // 账本（US3 对称）：modelUsages 是权威终值；缺（异常路径）才折叠明细。
      const groups: ModelUsage[] =
        modelUsages && modelUsages.length > 0
          ? modelUsages
          : foldCalls(calls)
      const upsert = db.prepare(USAGE_WRITE_SQL.upsertNodeUsage)
      const exists = db.prepare("SELECT 1 FROM node_token_usages WHERE id = ?")
      for (const g of groups) {
        const id = `cli:${ctx.runId}:${ctx.nodeId}:${g.model}`
        if (exists.get(id)) continue // 重放防双计
        upsert.run(
          id, null, g.model,
          g.inputTokens, g.outputTokens, ledgerCostUsd(g, g.model, g.costUsd),
          g.cacheReadTokens, g.cacheCreationTokens,
          LLM_CALL_SOURCE.cli, new Date().toISOString(), null, ctx.runId,
        )
      }
    })()
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      `[cli-usage] run=${ctx.runId} node=${ctx.nodeId} 捕获失败（非致命）:`,
      err instanceof Error ? err.message : String(err),
    )
  }
}

function foldCalls(calls: LLMCallRecord[]): ModelUsage[] {
  const byModel = new Map<string, ModelUsage>()
  for (const c of calls) {
    const model = c.model ?? "unknown"
    let g = byModel.get(model)
    if (!g) { g = { model, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }; byModel.set(model, g) }
    g.inputTokens += c.inputTokens
    g.outputTokens += c.outputTokens
    g.cacheReadTokens += c.cacheReadTokens
    g.cacheCreationTokens += c.cacheCreationTokens
  }
  return Array.from(byModel.values())
}

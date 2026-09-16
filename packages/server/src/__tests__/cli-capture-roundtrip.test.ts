import { describe, it, expect, beforeEach, afterEach } from "vitest"
import Database from "better-sqlite3"
import { Hono } from "hono"
import { applySchema } from "../db/schema"
import { TokenUsageDAO } from "../db/dao/token-usage-dao"
import { createUsageRoutes } from "../routes/usage"
import { USAGE_WRITE_SQL, LLM_CALL_SOURCE } from "@octopus/shared"

/**
 * all-sources-2 票02 验证 3（integration）：CLI 直写行（用与 CLI 进程完全同源的
 * USAGE_WRITE_SQL 注入等价事件）→ sqlite 直查与 GET /api/usage/llm-calls
 * （source=cli + trace_id 过滤）逐字段对上。
 */
let db: Database.Database
let app: Hono

beforeEach(() => {
  db = new Database(":memory:")
  applySchema(db)
  app = new Hono()
  app.route("/api/usage", createUsageRoutes(new TokenUsageDAO(db)))
})

afterEach(() => db.close())

it("cli 行经 API source=cli+trace_id 过滤回读 = sqlite 直查", async () => {
  const stmt = db.prepare(USAGE_WRITE_SQL.insertLlmCall) // CLI 进程的同一份 SQL
  stmt.run({
    id: "cli:run-9:m-a", node_execution_id: null, execution_id: "run-9",
    turn_index: 1, call_index: 0, message_id: "m-a", model: "claude-test",
    stop_reason: "end_turn", timestamp: 1700, duration_ms: 100, ttft_ms: null,
    input_tokens: 10, output_tokens: 20, cache_read_tokens: 1, cache_creation_tokens: 2,
    cost_usd: 0.1, org: "test-org", workspace_id: null, workflow_ref: "t.yaml",
    node_id: "n1", session_id: null, instance_id: "cli-4242",
    source: LLM_CALL_SOURCE.cli, trace_id: "run-9", span_id: "m-a",
  })
  db.prepare(USAGE_WRITE_SQL.upsertNodeUsage).run(
    "cli:run-9:n1:claude-test", null, "claude-test", 10, 20, 0.1, 1, 2,
    LLM_CALL_SOURCE.cli, new Date().toISOString(), null, "run-9",
  )
  // 干扰行：chat 域同 trace 不允许（不同源），换个 trace
  stmt.run({
    id: "chat:t8:m-x", node_execution_id: null, execution_id: null,
    turn_index: 1, call_index: 0, message_id: "m-x", model: "claude-test",
    stop_reason: null, timestamp: 1800, duration_ms: 50, ttft_ms: null,
    input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0,
    cost_usd: null, org: "test-org", workspace_id: null, workflow_ref: null,
    node_id: null, session_id: "s1", instance_id: null,
    source: LLM_CALL_SOURCE.chat, trace_id: "t8", span_id: "m-x",
  })

  const res = await app.request("/api/usage/llm-calls?trace_id=run-9&source=cli")
  expect(res.status).toBe(200)
  const body = (await res.json()) as { calls: Array<Record<string, unknown>>; rounds: Array<Record<string, unknown>> }
  expect(body.calls.map(x => x.id)).toEqual(["cli:run-9:m-a"])

  const direct = db.prepare("SELECT * FROM llm_calls WHERE id='cli:run-9:m-a'").get() as Record<string, unknown>
  expect(body.calls[0]).toEqual({
    id: direct.id, nodeExecutionId: direct.node_execution_id, executionId: direct.execution_id,
    turnIndex: direct.turn_index, callIndex: direct.call_index, messageId: direct.message_id,
    model: direct.model, stopReason: direct.stop_reason, timestamp: direct.timestamp,
    durationMs: direct.duration_ms, ttftMs: direct.ttft_ms, inputTokens: direct.input_tokens,
    outputTokens: direct.output_tokens, cacheReadTokens: direct.cache_read_tokens,
    cacheCreationTokens: direct.cache_creation_tokens, costUsd: direct.cost_usd,
    org: direct.org, workspaceId: direct.workspace_id, workflowRef: direct.workflow_ref,
    nodeId: direct.node_id, sessionId: direct.session_id, instanceId: direct.instance_id,
    source: direct.source, traceId: direct.trace_id, spanId: direct.span_id,
  })

  // 缺省口径仍是 chat（票03 KD6 不回退）：不带 source 时 cli 行不可见
  const def = (await (await app.request("/api/usage/llm-calls?trace_id=run-9")).json()) as { calls: unknown[] }
  expect(def.calls).toHaveLength(0)

  // 账本对称（US3）：明细 SUM ≡ 账本行
  const sum = db.prepare(`
    SELECT SUM(input_tokens) i, SUM(output_tokens) o FROM llm_calls WHERE source='cli' AND trace_id='run-9'
  `).get() as { i: number; o: number }
  const ntu = db.prepare("SELECT input_tokens, output_tokens, source, trace_id FROM node_token_usages WHERE id='cli:run-9:n1:claude-test'").get() as Record<string, number | string>
  expect([ntu.input_tokens, ntu.output_tokens]).toEqual([sum.i, sum.o])
  expect(ntu.source).toBe("cli")
})

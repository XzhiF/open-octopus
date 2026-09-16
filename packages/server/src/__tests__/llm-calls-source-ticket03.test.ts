import { describe, it, expect, beforeEach, afterEach } from "vitest"
import Database from "better-sqlite3"
import { applySchema, migrateLlmCallsSourceBackfillV44 } from "../db/schema"
import { ExecutionDAO } from "../db/dao/execution-dao"
import { TokenUsageDAO } from "../db/dao/token-usage-dao"
import { ObservabilityService } from "../services/observability"
import { InteractionService } from "../services/interaction/InteractionService"
import { AgentDelegationService } from "../services/harness/agent-delegation"
import { LLM_CALL_SOURCE } from "@octopus/shared"
import type { LLMCallRecord } from "@octopus/providers"

/**
 * all-sources-2 票03 —— 引擎域三写入点 source 补标 + 存量回填。
 * unit：三写入点各 fake 跑一次 → 明细行 source 值断言。
 * DB：回填迁移在含存量 NULL 行的库上执行 → 无 NULL 残留；重跑 no-op。
 */
let db: Database.Database

const META = { executionId: "e1", nodeId: "n1", org: "test-org", workspaceId: "ws-1", workflowRef: "t.yaml" }

beforeEach(() => {
  db = new Database(":memory:")
  applySchema(db)
  const now = new Date().toISOString()
  db.prepare("INSERT INTO workspaces (id, name, path, org, created_at, updated_at) VALUES ('ws-1', 'Test WS', '/tmp/test', 'test-org', datetime('now'), datetime('now'))").run()
  db.prepare(`
    INSERT INTO executions (id, workspace_id, parent_id, workflow_ref, workflow_name, status, started_at, completed_at, org, created_at, updated_at)
    VALUES ('e1', 'ws-1', '0', 't.yaml', 'T', 'completed', ?, ?, 'test-org', ?, ?)
  `).run(now, now, now, now)
  db.prepare(`
    INSERT INTO node_executions (id, execution_id, node_id, node_type, status, retry_count, duration, started_at, completed_at)
    VALUES ('e1-n1', 'e1', 'n1', 'agent', 'completed', 0, 1000, ?, ?)
  `).run(now, now)
})

afterEach(() => db.close())

describe("写入点 1: EngineCallbacks→observability.persistLLMCalls → source='engine'", () => {
  it("明细行落库带 engine 标", () => {
    const svc = new ObservabilityService(new ExecutionDAO(db), new TokenUsageDAO(db))
    svc.bufferEvent("e1-n1", { type: "heartbeat", data: {} } as never, META as never)
    const record = {
      turnIndex: 1, messageId: "m1", timestamp: Date.now(), durationMs: 100,
      inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0,
      model: "claude-sonnet-4-5-20250827",
    } as LLMCallRecord
    svc.persistLLMCalls("e1-n1", "e1", [record], "inst-1")
    const row = db.prepare("SELECT source FROM llm_calls WHERE message_id = 'm1'").get() as { source: string | null }
    expect(row.source).toBe(LLM_CALL_SOURCE.engine)
  })
})

describe("写入点 2: InteractionService.writeLlmCall → source='interaction'", () => {
  it("明细行落库带 interaction 标", () => {
    const dao = new TokenUsageDAO(db)
    const acc = {
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 1, cacheCreationTokens: 2 },
      model: "claude-sonnet-4-5-20250827", costUsd: null,
      llmCallStartTime: Date.now(), assistantMessageId: "msg-1", completionDetected: false,
    }
    const session = {
      nodeExecutionId: "e1-n1", executionId: "e1", currentRound: 1,
      workspaceId: "ws-1", nodeId: "n1", providerSessionId: "ps-1",
    }
    // fake this：只喂 writeLlmCall 用到的 tokenDao
    ;(InteractionService.prototype as never as {
      writeLlmCall(this: unknown, acc: unknown, session: unknown): void
    }).writeLlmCall.call({ tokenDao: dao }, acc, session)
    const row = db.prepare("SELECT source FROM llm_calls WHERE message_id = 'msg-1'").get() as { source: string | null }
    expect(row.source).toBe(LLM_CALL_SOURCE.interaction)
  })
})

describe("写入点 3: agent-delegation.recordTokenUsage → 账本 source='harness'（词表单源）", () => {
  it("ntu 行 source 与 shared 词表对齐", () => {
    const dao = new TokenUsageDAO(db)
    const tokenInfo = {
      model: "claude-sonnet-4-5-20250827",
      inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0,
      costUsd: undefined,
    }
    ;(AgentDelegationService.prototype as never as {
      recordTokenUsage(this: unknown, id: string, exec: string, node: string, usage: unknown): void
    }).recordTokenUsage.call({ tokenUsageDao: dao }, "d-1", "e1", "n1", tokenInfo)
    const row = db.prepare("SELECT source FROM node_token_usages WHERE id = 'd-1-token'").get() as { source: string }
    expect(row.source).toBe(LLM_CALL_SOURCE.harness)
  })
})

describe("存量回填 migrateLlmCallsSourceBackfillV44 (KD2)", () => {
  function seedNullRow(id: string) {
    db.prepare(`
      INSERT INTO llm_calls (id, node_execution_id, execution_id, turn_index, call_index,
        timestamp, duration_ms, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens)
      VALUES (?, 'e1-n1', 'e1', 1, 0, 1000, 10, 1, 1, 0, 0)
    `).run(id)
  }

  it("含存量 NULL 行的库上执行 → 无 NULL 残留；非 NULL（chat）不动", () => {
    seedNullRow("old-1")
    seedNullRow("old-2")
    db.prepare(`
      INSERT INTO llm_calls (id, node_execution_id, execution_id, turn_index, call_index,
        timestamp, duration_ms, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, source)
      VALUES ('chat-1', NULL, NULL, 1, 0, 1000, 10, 1, 1, 0, 0, 'chat')
    `).run()
    migrateLlmCallsSourceBackfillV44(db)
    const left = (db.prepare("SELECT COUNT(*) AS c FROM llm_calls WHERE source IS NULL").get() as { c: number }).c
    expect(left).toBe(0)
    const kept = db.prepare("SELECT source FROM llm_calls WHERE id = 'chat-1'").get() as { source: string }
    expect(kept.source).toBe("chat")
    const backfilled = db.prepare("SELECT source FROM llm_calls WHERE id = 'old-1'").get() as { source: string }
    expect(backfilled.source).toBe(LLM_CALL_SOURCE.engine)
  })

  it("重跑 no-op（幂等）", () => {
    seedNullRow("old-1")
    migrateLlmCallsSourceBackfillV44(db)
    const before = db.prepare("SELECT id, source FROM llm_calls ORDER BY id").all()
    expect(() => migrateLlmCallsSourceBackfillV44(db)).not.toThrow()
    expect(db.prepare("SELECT id, source FROM llm_calls ORDER BY id").all()).toEqual(before)
  })

  it("表不存在（极旧库/新库）→ 跳过不抛", () => {
    const bare = new Database(":memory:")
    expect(() => migrateLlmCallsSourceBackfillV44(bare)).not.toThrow()
    bare.close()
  })
})

describe("词表单源 (KD1)", () => {
  it("shared 枚举覆盖全词表", () => {
    expect(Object.values(LLM_CALL_SOURCE).sort()).toEqual(
      ["aux_compress", "aux_memory", "aux_suggest", "chat", "cli", "engine", "harness", "interaction", "scheduler"].sort(),
    )
  })
})

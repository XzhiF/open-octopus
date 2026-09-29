// P1 B4 票2B-1：TokenUsageDAO 已迁 postgres.js —— 排行榜读路径（ntu / node_executions /
// executions / workspaces / llm_calls_costed）全部落 PG。本文件从临时 SQLite 文件库切到
// PG 随机测试库（每文件一座，dao-fixture 姿势）；造数 datetime('now')→now()，
// ON CONFLICT 裸列名按 PG 规则限定表名（雷区清单），断言语义与条数逐条保持。
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { LeaderboardService } from "../services/leaderboard"
import { TokenUsageDAO } from "../db/dao"
import { setupRegisteredPgSchema, type PgFixture } from "../db/pg/__tests__/dao-fixture"
import { describePg } from "../db/pg/__tests__/dao-fixture"

describePg("LeaderboardService", () => {
  let pg: PgFixture
  let service: LeaderboardService

  beforeAll(async () => {
    pg = await setupRegisteredPgSchema()
    service = new LeaderboardService(new TokenUsageDAO(pg.sql))
  })

  afterAll(async () => {
    await pg.close()
  })

  async function cleanAll() {
    await pg!.truncate("node_token_usages", "llm_calls", "billing_price_config", "node_executions", "executions", "workspaces")
  }

  async function seedWorkspace(id: string, name: string) {
    await pg!.sql.unsafe(
      "INSERT INTO workspaces (id, name, org, path, status, created_at, updated_at) VALUES ($1, $2, 'xzf', '/tmp/ws', 'active', now(), now())",
      [id, name],
    )
  }

  async function seedExecution(id: string, workspaceId: string, workflowRef: string, workflowName: string) {
    await pg!.sql.unsafe(
      "INSERT INTO executions (id, workspace_id, parent_id, workflow_ref, workflow_name, status, org, created_at, updated_at) VALUES ($1, $2, '0', $3, $4, 'completed', 'xzf', now(), now())",
      [id, workspaceId, workflowRef, workflowName],
    )
  }

  async function seedNodeExecution(id: string, executionId: string, nodeId: string) {
    await pg!.sql.unsafe(
      "INSERT INTO node_executions (id, execution_id, node_id, node_type, status) VALUES ($1, $2, $3, 'agent', 'completed')",
      [id, executionId, nodeId],
    )
  }

  // NEW-r2：node_token_usages 纯记 token（cost_usd 快照列已删），
  // 排行榜的钱从 llm_calls_costed 视图派生 —— 出 cost 需 seed 价行 + 对应 llm_calls。
  async function seedTokenUsage(
    id: string,
    nodeExecutionId: string,
    model: string,
    input: number,
    output: number,
    cacheRead = 0,
    cacheCreation = 0,
  ) {
    await pg!.sql.unsafe(
      "INSERT INTO node_token_usages (id, node_execution_id, model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, now())",
      [id, nodeExecutionId, model, input, output, cacheRead, cacheCreation],
    )
  }

  async function seedCall(id: string, nodeExecutionId: string, executionId: string, workspaceId: string, model: string) {
    await pg!.sql.unsafe(
      `INSERT INTO llm_calls (id, node_execution_id, execution_id, turn_index, call_index, model, timestamp, duration_ms, input_tokens, output_tokens, workspace_id)
       VALUES ($1, $2, $3, 1, 0, $4, 1700000000000, 100, 1000, 500, $5)`,
      [id, nodeExecutionId, executionId, model, workspaceId],
    )
  }

  /** USD 全时段兜底价（正常价）；单价/Mtok → 1000 in + 500 out @ {i,o} = i/1000 + o/2000 USD。 */
  async function priceCatchall(id: string, modelId: string, input = 2, output = 8) {
    await pg!.sql.unsafe(
      `INSERT INTO billing_price_config (id, vendor, model_id, input_unit_price, output_unit_price, cache_write_unit_price, cache_read_unit_price, currency, created_at, updated_at)
       VALUES ($1, 'test-vendor', $2, $3, $4, 0, 0, 'USD', now(), now())`,
      [id, modelId, input, output],
    )
  }

  describe("空数据库", () => {
    beforeAll(async () => {
      service.clearCache()
      await cleanAll()
    })

    it("返回三个空数组", async () => {
      const result = await service.getLeaderboard()
      expect(result.byWorkspace).toEqual([])
      expect(result.byWorkflow).toEqual([])
      expect(result.byModel).toEqual([])
    })
  })

  describe("单 workspace 单模型", () => {
    beforeAll(async () => {
      service.clearCache()
      await cleanAll()

      await seedWorkspace("ws1", "Workspace Alpha")
      await seedExecution("exec1", "ws1", "flow.yaml", "流程 A")
      await seedNodeExecution("node1", "exec1", "step1")
      await seedTokenUsage("tu1", "node1", "claude-sonnet-4-6", 1000, 500)
      await priceCatchall("p-sonnet", "claude-sonnet-4-6")
      await seedCall("c1", "node1", "exec1", "ws1", "claude-sonnet-4-6")
    })

    it("正确聚合", async () => {
      const result = await service.getLeaderboard()
      expect(result.byWorkspace).toHaveLength(1)
      expect(result.byWorkspace[0].workspaceName).toBe("Workspace Alpha")
      expect(result.byWorkspace[0].totalTokens).toBe(1500)
      expect(result.byWorkspace[0].costComplete).toBe(true)
    })
  })

  describe("多 workspace 多模型", () => {
    beforeAll(async () => {
      service.clearCache()
      await cleanAll()

      await seedWorkspace("ws1", "Alpha")
      await seedWorkspace("ws2", "Beta")

      await seedExecution("e1", "ws1", "flow1.yaml", "流程 1")
      await seedExecution("e2", "ws2", "flow2.yaml", "流程 2")

      await seedNodeExecution("n1", "e1", "s1")
      await seedNodeExecution("n2", "e2", "s2")

      await seedTokenUsage("t1", "n1", "claude-sonnet-4-6", 2000, 1000)
      await seedTokenUsage("t2", "n1", "claude-opus-4-5", 500, 200)
      await seedTokenUsage("t3", "n2", "claude-sonnet-4-6", 3000, 1500)
    })

    it("正确分组和排序", async () => {
      const result = await service.getLeaderboard()
      expect(result.byWorkspace).toHaveLength(2)
      expect(result.byWorkspace[0].workspaceName).toBe("Beta")
      expect(result.byWorkspace[0].totalTokens).toBe(4500)
      expect(result.byWorkspace[1].totalTokens).toBe(3700)
    })

    it("每个 workspace 包含多个模型", async () => {
      const result = await service.getLeaderboard()
      const alpha = result.byWorkspace.find(w => w.workspaceName === "Alpha")!
      expect(alpha.models).toHaveLength(2)
    })
  })

  describe("limit 参数", () => {
    beforeAll(async () => {
      service.clearCache()
    })

    it("默认返回 6 条", async () => {
      const result = await service.getLeaderboard()
      expect(result.byWorkspace.length).toBeLessThanOrEqual(6)
    })

    it("超出 [1, 50] 范围自动钳位", async () => {
      service.clearCache()
      const result1 = await service.getLeaderboard(0)
      expect(result1.byWorkspace.length).toBeLessThanOrEqual(1)

      service.clearCache()
      const result2 = await service.getLeaderboard(100)
      expect(result2.byWorkspace.length).toBeLessThanOrEqual(50)
    })
  })

  describe("cost complete (r2: derived from llm_calls_costed view)", () => {
    beforeAll(async () => {
      service.clearCache()
      await cleanAll()

      await seedWorkspace("ws1", "Partial Cost")
      await seedExecution("e1", "ws1", "flow.yaml", "flow")
      await seedNodeExecution("n1", "e1", "s1")
      await seedNodeExecution("n2", "e1", "s2")
      await seedTokenUsage("t1", "n1", "claude-sonnet-4-6", 1000, 500)
      await seedTokenUsage("t2", "n2", "model-x", 1000, 500)
      // Only c1 has a model price, c2 is unpriced → not all rows have prices = incomplete
      await priceCatchall("p-sonnet", "claude-sonnet-4-6")
      await seedCall("c1", "n1", "e1", "ws1", "claude-sonnet-4-6")
      await seedCall("c2", "n2", "e1", "ws1", "model-x")
    })

    it("partial rows without a price → costComplete = false", async () => {
      const result = await service.getLeaderboard()
      expect(result.byWorkspace[0].costComplete).toBe(false)
    })

    it("after all have prices, costComplete = true (late pricing immediately recomputes history)", async () => {
      service.clearCache()
      await priceCatchall("p-x", "model-x")
      const result = await service.getLeaderboard()
      expect(result.byWorkspace[0].costComplete).toBe(true)
      expect(result.byWorkspace[0].totalCostUsd).toBeCloseTo(0.012, 6) // 2 笔 × (1000×2 + 500×8)/Mtok = 0.006/笔
    })
  })

  describe("cache tokens", () => {
    beforeAll(async () => {
      service.clearCache()
      await cleanAll()

      await seedWorkspace("ws1", "Cache Test")
      await seedExecution("e1", "ws1", "flow.yaml", "流程")
      await seedNodeExecution("n1", "e1", "s1")
      await seedTokenUsage("t1", "n1", "claude-sonnet-4-6", 1000, 500, 2000, 1000)
    })

    it("模型排行榜包含缓存数据", async () => {
      const result = await service.getLeaderboard()
      const model = result.byModel.find(m => m.model === "claude-sonnet-4-6")!
      expect(model.cacheReadTokens).toBe(2000)
      expect(model.cacheCreationTokens).toBe(1000)
      expect(model.totalTokens).toBe(4500)
    })

    it("totalTokens 公式跨维度统一（含 cache）", async () => {
      const result = await service.getLeaderboard()
      expect(result.byWorkspace[0].totalTokens).toBe(4500)
      expect(result.byModel[0].totalTokens).toBe(4500)
    })
  })

  describe("排序正确性", () => {
    beforeAll(async () => {
      service.clearCache()
      await cleanAll()

      await seedWorkspace("ws1", "Low")
      await seedWorkspace("ws2", "High")
      await seedExecution("e1", "ws1", "f1.yaml", "F1")
      await seedExecution("e2", "ws2", "f2.yaml", "F2")
      await seedNodeExecution("n1", "e1", "s1")
      await seedNodeExecution("n2", "e2", "s2")
      await seedTokenUsage("t1", "n1", "model-a", 100, 50)
      await seedTokenUsage("t2", "n2", "model-a", 5000, 2500)
    })

    it("按 totalTokens 倒排", async () => {
      const result = await service.getLeaderboard()
      expect(result.byWorkspace[0].workspaceName).toBe("High")
      expect(result.byWorkspace[1].workspaceName).toBe("Low")
    })
  })

  describe("execution 维度", () => {
    beforeAll(async () => {
      service.clearCache()
      await cleanAll()

      await seedWorkspace("ws1", "Workspace A")
      await seedWorkspace("ws2", "Workspace B")
      await seedExecution("e1", "ws1", "flow.yaml", "流程 1")
      await seedExecution("e2", "ws2", "flow.yaml", "流程 2")
      await seedNodeExecution("n1", "e1", "s1")
      await seedNodeExecution("n2", "e2", "s2")
      await seedTokenUsage("t1", "n1", "model-a", 1000, 500)
      await seedTokenUsage("t2", "n2", "model-a", 2000, 1000)
    })

    it("每条 execution 独立展示", async () => {
      const result = await service.getLeaderboard()
      expect(result.byWorkflow).toHaveLength(2)
      expect(result.byWorkflow[0].workspaceName).not.toBe(result.byWorkflow[1].workspaceName)
      expect(result.byWorkflow[0].totalTokens).toBeGreaterThan(result.byWorkflow[1].totalTokens)
    })

    it("包含 executionId", async () => {
      const result = await service.getLeaderboard()
      expect(result.byWorkflow[0].executionId).toBeDefined()
      expect(typeof result.byWorkflow[0].executionId).toBe("string")
    })
  })

  describe("大规模数据", () => {
    beforeAll(async () => {
      service.clearCache()
      await cleanAll()

      await seedWorkspace("ws1", "Large")
      for (let i = 0; i < 100; i++) {
        await seedExecution(`e${i}`, "ws1", `flow${i}.yaml`, `流程 ${i}`)
        await seedNodeExecution(`n${i}`, `e${i}`, `s${i}`)
        for (let j = 0; j < 10; j++) {
          await seedTokenUsage(`t${i}_${j}`, `n${i}`, `model-${j}`, 100 + j, 50 + j)
        }
      }
    })

    it("1000+ 条记录查询在 200ms 内返回", async () => {
      const start = Date.now()
      const result = await service.getLeaderboard()
      const duration = Date.now() - start
      expect(duration).toBeLessThan(200)
      expect(result.byWorkspace).toHaveLength(1)
    })
  })

  describe("ON CONFLICT 重试", () => {
    beforeAll(async () => {
      service.clearCache()
      await cleanAll()

      await seedWorkspace("ws1", "Retry")
      await seedExecution("e1", "ws1", "flow.yaml", "流程")
      await seedNodeExecution("n1", "e1", "s1")
      await seedTokenUsage("t1", "n1", "model-a", 1000, 500)

      // 模拟重试：ON CONFLICT DO UPDATE（NEW-r2：ntu 不再存钱，upsert 只累计 token）
      // PG：DO UPDATE SET 裸列名 ambiguous → 限定表名（雷区清单）。
      await pg!.sql.unsafe(
        `INSERT INTO node_token_usages (id, node_execution_id, model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, created_at)
         VALUES ('t1', 'n1', 'model-a', 500, 250, 0, 0, now())
         ON CONFLICT(id) DO UPDATE SET
           input_tokens = node_token_usages.input_tokens + excluded.input_tokens,
           output_tokens = node_token_usages.output_tokens + excluded.output_tokens,
           cache_read_tokens = node_token_usages.cache_read_tokens + excluded.cache_read_tokens,
           cache_creation_tokens = node_token_usages.cache_creation_tokens + excluded.cache_creation_tokens`,
      )
      // 钱与 ntu 无关：一笔 llm_call + 兜底价 → 视图派生（seedCall 固定 1000in+500out @ USD {2,8}/Mtok = 0.006）
      await priceCatchall("p-retry", "model-a")
      await seedCall("c-retry", "n1", "e1", "ws1", "model-a")
    })

    it("重试后聚合正确", async () => {
      const result = await service.getLeaderboard()
      const model = result.byModel[0]
      expect(model.inputTokens).toBe(1500)
      expect(model.outputTokens).toBe(750)
      expect(model.costUsd).toBeCloseTo(0.006, 6)
    })
  })

  describe("特殊字符", () => {
    beforeAll(async () => {
      service.clearCache()
      await cleanAll()

      await seedWorkspace("ws1", "工作空间 <script>")
      await seedExecution("e1", "ws1", "流程 & 测试.yaml", "Unicode 测试 🚀")
      await seedNodeExecution("n1", "e1", "s1")
      await seedTokenUsage("t1", "n1", "model-a", 100, 50)
    })

    it("Unicode 字符正常处理", async () => {
      const result = await service.getLeaderboard()
      expect(result.byWorkspace[0].workspaceName).toBe("工作空间 <script>")
      expect(result.byWorkflow[0].workflowName).toBe("Unicode 测试 🚀")
    })
  })
})

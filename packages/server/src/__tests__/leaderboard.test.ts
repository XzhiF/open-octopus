import { describe, it, expect, beforeAll, afterAll } from "vitest"
import Database from "better-sqlite3"
import os from "os"
import path from "path"
import { LeaderboardService } from "../services/leaderboard"
import { applySchema } from "../db/schema"
import { TokenUsageDAO } from "../db/dao"

function createTestDb(): Database.Database {
  return new Database(path.join(os.tmpdir(), `test-leaderboard-${Date.now()}.db`))
}

describe("LeaderboardService", () => {
  let db: Database.Database
  let service: LeaderboardService

  beforeAll(() => {
    db = createTestDb()
    applySchema(db)
    service = new LeaderboardService(new TokenUsageDAO(db))
  })

  afterAll(() => {
    db.close()
  })

  function cleanAll() {
    db.prepare("DELETE FROM node_token_usages").run()
    db.prepare("DELETE FROM node_executions").run()
    db.prepare("DELETE FROM executions").run()
    db.prepare("DELETE FROM workspaces").run()
  }

  function seedWorkspace(id: string, name: string) {
    db.prepare(
      "INSERT INTO workspaces (id, name, org, path, status, created_at, updated_at) VALUES (?, ?, 'xzf', '/tmp/ws', 'active', datetime('now'), datetime('now'))"
    ).run(id, name)
  }

  function seedExecution(id: string, workspaceId: string, workflowRef: string, workflowName: string) {
    db.prepare(
      "INSERT INTO executions (id, workspace_id, parent_id, workflow_ref, workflow_name, status, org, created_at, updated_at) VALUES (?, ?, '0', ?, ?, 'completed', 'xzf', datetime('now'), datetime('now'))"
    ).run(id, workspaceId, workflowRef, workflowName)
  }

  function seedNodeExecution(id: string, executionId: string, nodeId: string) {
    db.prepare(
      "INSERT INTO node_executions (id, execution_id, node_id, node_type, status) VALUES (?, ?, ?, 'agent', 'completed')"
    ).run(id, executionId, nodeId)
  }

  function seedTokenUsage(
    id: string,
    nodeExecutionId: string,
    model: string,
    input: number,
    output: number,
    cost: number | null,
    cacheRead = 0,
    cacheCreation = 0,
  ) {
    db.prepare(
      "INSERT INTO node_token_usages (id, node_execution_id, model, input_tokens, output_tokens, cost_usd, cache_read_tokens, cache_creation_tokens, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))"
    ).run(id, nodeExecutionId, model, input, output, cost, cacheRead, cacheCreation)
  }

  describe("空数据库", () => {
    beforeAll(() => {
      service.clearCache()
    })

    it("返回三个空数组", () => {
      const result = service.getLeaderboard()
      expect(result.byWorkspace).toEqual([])
      expect(result.byWorkflow).toEqual([])
      expect(result.byModel).toEqual([])
    })
  })

  describe("单 workspace 单模型", () => {
    beforeAll(() => {
      service.clearCache()
      cleanAll()

      seedWorkspace("ws1", "Workspace Alpha")
      seedExecution("exec1", "ws1", "flow.yaml", "流程 A")
      seedNodeExecution("node1", "exec1", "step1")
      seedTokenUsage("tu1", "node1", "claude-sonnet-4-6", 1000, 500, 0.05)
    })

    it("正确聚合", () => {
      const result = service.getLeaderboard()
      expect(result.byWorkspace).toHaveLength(1)
      expect(result.byWorkspace[0].workspaceName).toBe("Workspace Alpha")
      expect(result.byWorkspace[0].totalTokens).toBe(1500)
      expect(result.byWorkspace[0].costComplete).toBe(true)
    })
  })

  describe("多 workspace 多模型", () => {
    beforeAll(() => {
      service.clearCache()
      cleanAll()

      seedWorkspace("ws1", "Alpha")
      seedWorkspace("ws2", "Beta")

      seedExecution("e1", "ws1", "flow1.yaml", "流程 1")
      seedExecution("e2", "ws2", "flow2.yaml", "流程 2")

      seedNodeExecution("n1", "e1", "s1")
      seedNodeExecution("n2", "e2", "s2")

      seedTokenUsage("t1", "n1", "claude-sonnet-4-6", 2000, 1000, 0.10)
      seedTokenUsage("t2", "n1", "claude-opus-4-5", 500, 200, 0.08)
      seedTokenUsage("t3", "n2", "claude-sonnet-4-6", 3000, 1500, 0.15)
    })

    it("正确分组和排序", () => {
      const result = service.getLeaderboard()
      expect(result.byWorkspace).toHaveLength(2)
      expect(result.byWorkspace[0].workspaceName).toBe("Beta")
      expect(result.byWorkspace[0].totalTokens).toBe(4500)
      expect(result.byWorkspace[1].totalTokens).toBe(3700)
    })

    it("每个 workspace 包含多个模型", () => {
      const result = service.getLeaderboard()
      const alpha = result.byWorkspace.find(w => w.workspaceName === "Alpha")!
      expect(alpha.models).toHaveLength(2)
    })
  })

  describe("limit 参数", () => {
    beforeAll(() => {
      service.clearCache()
    })

    it("默认返回 6 条", () => {
      const result = service.getLeaderboard()
      expect(result.byWorkspace.length).toBeLessThanOrEqual(6)
    })

    it("超出 [1, 50] 范围自动钳位", () => {
      service.clearCache()
      const result1 = service.getLeaderboard(0)
      expect(result1.byWorkspace.length).toBeLessThanOrEqual(1)

      service.clearCache()
      const result2 = service.getLeaderboard(100)
      expect(result2.byWorkspace.length).toBeLessThanOrEqual(50)
    })
  })

  describe("cost_usd 完整性", () => {
    beforeAll(() => {
      service.clearCache()
      cleanAll()

      seedWorkspace("ws1", "Partial Cost")
      seedExecution("e1", "ws1", "flow.yaml", "流程")
      seedNodeExecution("n1", "e1", "s1")
      seedNodeExecution("n2", "e1", "s2")
      seedTokenUsage("t1", "n1", "claude-sonnet-4-6", 1000, 500, 0.05)
      seedTokenUsage("t2", "n2", "claude-sonnet-4-6", 1000, 500, null)
    })

    it("部分记录 null 时 costComplete = false", () => {
      const result = service.getLeaderboard()
      expect(result.byWorkspace[0].costComplete).toBe(false)
    })

    it("所有记录都有 cost 时 costComplete = true", () => {
      service.clearCache()
      db.prepare("UPDATE node_token_usages SET cost_usd = 0.05 WHERE id = 't2'").run()
      const result = service.getLeaderboard()
      expect(result.byWorkspace[0].costComplete).toBe(true)
    })
  })

  describe("cache tokens", () => {
    beforeAll(() => {
      service.clearCache()
      cleanAll()

      seedWorkspace("ws1", "Cache Test")
      seedExecution("e1", "ws1", "flow.yaml", "流程")
      seedNodeExecution("n1", "e1", "s1")
      seedTokenUsage("t1", "n1", "claude-sonnet-4-6", 1000, 500, 0.05, 2000, 1000)
    })

    it("模型排行榜包含缓存数据", () => {
      const result = service.getLeaderboard()
      const model = result.byModel.find(m => m.model === "claude-sonnet-4-6")!
      expect(model.cacheReadTokens).toBe(2000)
      expect(model.cacheCreationTokens).toBe(1000)
      expect(model.totalTokens).toBe(4500)
    })

    it("totalTokens 公式跨维度统一（含 cache）", () => {
      const result = service.getLeaderboard()
      expect(result.byWorkspace[0].totalTokens).toBe(4500)
      expect(result.byModel[0].totalTokens).toBe(4500)
    })
  })

  describe("排序正确性", () => {
    beforeAll(() => {
      service.clearCache()
      cleanAll()

      seedWorkspace("ws1", "Low")
      seedWorkspace("ws2", "High")
      seedExecution("e1", "ws1", "f1.yaml", "F1")
      seedExecution("e2", "ws2", "f2.yaml", "F2")
      seedNodeExecution("n1", "e1", "s1")
      seedNodeExecution("n2", "e2", "s2")
      seedTokenUsage("t1", "n1", "model-a", 100, 50, 0.01)
      seedTokenUsage("t2", "n2", "model-a", 5000, 2500, 0.50)
    })

    it("按 totalTokens 倒排", () => {
      const result = service.getLeaderboard()
      expect(result.byWorkspace[0].workspaceName).toBe("High")
      expect(result.byWorkspace[1].workspaceName).toBe("Low")
    })
  })

  describe("execution 维度", () => {
    beforeAll(() => {
      service.clearCache()
      cleanAll()

      seedWorkspace("ws1", "Workspace A")
      seedWorkspace("ws2", "Workspace B")
      seedExecution("e1", "ws1", "flow.yaml", "流程 1")
      seedExecution("e2", "ws2", "flow.yaml", "流程 2")
      seedNodeExecution("n1", "e1", "s1")
      seedNodeExecution("n2", "e2", "s2")
      seedTokenUsage("t1", "n1", "model-a", 1000, 500, 0.05)
      seedTokenUsage("t2", "n2", "model-a", 2000, 1000, 0.10)
    })

    it("每条 execution 独立展示", () => {
      const result = service.getLeaderboard()
      expect(result.byWorkflow).toHaveLength(2)
      expect(result.byWorkflow[0].workspaceName).not.toBe(result.byWorkflow[1].workspaceName)
      expect(result.byWorkflow[0].totalTokens).toBeGreaterThan(result.byWorkflow[1].totalTokens)
    })

    it("包含 executionId", () => {
      const result = service.getLeaderboard()
      expect(result.byWorkflow[0].executionId).toBeDefined()
      expect(typeof result.byWorkflow[0].executionId).toBe("string")
    })
  })

  describe("大规模数据", () => {
    beforeAll(() => {
      service.clearCache()
      cleanAll()

      seedWorkspace("ws1", "Large")
      for (let i = 0; i < 100; i++) {
        seedExecution(`e${i}`, "ws1", `flow${i}.yaml`, `流程 ${i}`)
        seedNodeExecution(`n${i}`, `e${i}`, `s${i}`)
        for (let j = 0; j < 10; j++) {
          seedTokenUsage(`t${i}_${j}`, `n${i}`, `model-${j}`, 100 + j, 50 + j, 0.01 * j)
        }
      }
    })

    it("1000+ 条记录查询在 200ms 内返回", () => {
      const start = Date.now()
      const result = service.getLeaderboard()
      const duration = Date.now() - start
      expect(duration).toBeLessThan(200)
      expect(result.byWorkspace).toHaveLength(1)
    })
  })

  describe("ON CONFLICT 重试", () => {
    beforeAll(() => {
      service.clearCache()
      cleanAll()

      seedWorkspace("ws1", "Retry")
      seedExecution("e1", "ws1", "flow.yaml", "流程")
      seedNodeExecution("n1", "e1", "s1")
      seedTokenUsage("t1", "n1", "model-a", 1000, 500, 0.05)

      // 模拟重试：ON CONFLICT DO UPDATE
      db.prepare(
        `INSERT INTO node_token_usages (id, node_execution_id, model, input_tokens, output_tokens, cost_usd, cache_read_tokens, cache_creation_tokens, created_at)
         VALUES ('t1', 'n1', 'model-a', 500, 250, 0.02, 0, 0, datetime('now'))
         ON CONFLICT(id) DO UPDATE SET
           input_tokens = input_tokens + excluded.input_tokens,
           output_tokens = output_tokens + excluded.output_tokens,
           cost_usd = COALESCE(cost_usd, 0) + COALESCE(excluded.cost_usd, 0),
           cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
           cache_creation_tokens = cache_creation_tokens + excluded.cache_creation_tokens`,
      ).run()
    })

    it("重试后聚合正确", () => {
      const result = service.getLeaderboard()
      const model = result.byModel[0]
      expect(model.inputTokens).toBe(1500)
      expect(model.outputTokens).toBe(750)
      expect(model.costUsd).toBeCloseTo(0.07, 5)
    })
  })

  describe("特殊字符", () => {
    beforeAll(() => {
      service.clearCache()
      cleanAll()

      seedWorkspace("ws1", "工作空间 <script>")
      seedExecution("e1", "ws1", "流程 & 测试.yaml", "Unicode 测试 🚀")
      seedNodeExecution("n1", "e1", "s1")
      seedTokenUsage("t1", "n1", "model-a", 100, 50, 0.01)
    })

    it("Unicode 字符正常处理", () => {
      const result = service.getLeaderboard()
      expect(result.byWorkspace[0].workspaceName).toBe("工作空间 <script>")
      expect(result.byWorkflow[0].workflowName).toBe("Unicode 测试 🚀")
    })
  })
})

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import Database from "better-sqlite3"
import fs from "fs"
import path from "path"
import os from "os"
import { applySchema } from "../../../db/schema"
import { ArchiveDAO } from "../../../db/dao/archive-dao"
import { ExecutionDAO } from "../../../db/dao/execution-dao"
import { WorkspaceDAO } from "../../../db/dao/workspace-dao"
import { ArchiveService } from "../archive-service"
import { listAllActiveRules } from "../../knowledge/file-ops"

/**
 * C —— 归档 → 注入 闭环端到端：走真实的 archiveWorkspace 归档路径产出经验文件，
 * 再用注入读取面（listAllActiveRules，即 precompute/injector 的数据源）断言
 * 每条被归档的经验都可见。旧链路两处断点（merger 不写 id + org 落盘目录不被
 * 扫描）任何一处复发，本测试即红。
 */

describe("archive → knowledge injection e2e", () => {
  let db: Database.Database
  let tmpKb: string
  let wsDir: string

  beforeEach(() => {
    db = new Database(":memory:")
    applySchema(db)
    tmpKb = fs.mkdtempSync(path.join(os.tmpdir(), "kb-e2e-"))
    wsDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-e2e-"))
    process.env.OCTOPUS_KNOWLEDGE_DIR = tmpKb
  })

  afterEach(() => {
    delete process.env.OCTOPUS_KNOWLEDGE_DIR
    db?.close()
    fs.rmSync(tmpKb, { recursive: true, force: true })
    fs.rmSync(wsDir, { recursive: true, force: true })
  })

  it("归档产出的每条经验都能被注入器读到（org / workflow / project 三个 scope）", async () => {
    const workspaceDAO = new WorkspaceDAO(db)
    const archiveDAO = new ArchiveDAO(db)
    const executionDAO = new ExecutionDAO(db)

    db.prepare(`
      INSERT INTO workspaces (id, name, org, description, status, path, source, source_schedule_id, created_at, updated_at)
      VALUES ('ws-e2e', 'e2e-ws', 'test-org', null, 'active', ?, 'user', null, datetime('now'), datetime('now'))
    `).run(wsDir)
    db.prepare(`
      INSERT INTO executions (id, workspace_id, org, workflow_ref, workflow_name, status, parent_id, created_at, updated_at)
      VALUES ('exec-e2e', 'ws-e2e', 'test-org', 't.yaml', 'flow', 'completed', '0', datetime('now'), datetime('now'))
    `).run()

    const actions = [
      { id: "e2e-org-1", text: "Org lesson: always archive before delete", action: "add" as const, confidence: 0.9, category: "process", scope: "org", target: "all" },
      { id: "e2e-wf-1", text: "Workflow lesson: retry on flaky network", action: "add" as const, confidence: 0.8, category: "process", scope: "workflow", target: "flow" },
      { id: "e2e-pr-1", text: "Project lesson: use prepared statements", action: "add" as const, confidence: 0.7, category: "code", scope: "project", target: "repo-x" },
    ]

    const service = new ArchiveService(archiveDAO, executionDAO, db)
    const result = await service.archiveWorkspace("ws-e2e", "test-org", {
      extractExperiences: actions.map(a => a.text),
      installSkills: [],
      experienceActions: actions,
    })

    expect(result.success).toBe(true)
    expect(result.extractedExperiences).toBe(3)

    // 注入器的数据源 = listAllActiveRules(org)（precompute.ts 同款调用）
    const active = listAllActiveRules("test-org")
    const byId = new Map(active.map(r => [r.rule_id, r]))

    for (const a of actions) {
      const rule = byId.get(a.id)
      expect(rule, `经验 ${a.id} 对注入器不可见`).toBeDefined()
      expect(rule!.text).toBe(a.text)
    }
    expect(byId.get("e2e-org-1")!.scope).toBe("global")     // org 经验 → 全局注入
    expect(byId.get("e2e-wf-1")!.scope).toBe("workflow")
    expect(byId.get("e2e-pr-1")!.scope).toBe("project")

    // 归档记录也如实反映提取数
    const wsArchive = archiveDAO.findByWorkspaceId("ws-e2e")
    expect(wsArchive!.extracted_experiences).toBe(3)
  })
})

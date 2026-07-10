# Archive V2 优化实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 优化归档系统 — 弹窗尺寸、SSE 进度反馈、Draft 副本机制、统计 BUG 修复、经验 Agent merge、Skill 分组安装

**架构：** 3 批次渐进实现。Batch 1 快速修复（弹窗尺寸 + 统计 BUG）。Batch 2 核心架构（Draft DB + SSE 进度流 + ArchiveProgress 组件）。Batch 3 知识联动（经验 Agent merge + Skill 分组安装）。

**技术栈：** TypeScript, Hono SSE (streamSSE), SQLite (better-sqlite3), React, Claude SDK, Tailwind CSS

**规格文档：** `docs/superpowers/specs/2026-07-09-archive-v2-optimization-design.md`

---

## 文件结构

### 新建文件

| 文件 | 职责 |
|------|------|
| `packages/server/src/db/dao/archive-draft-dao.ts` | archive_drafts 表 DAO（upsert/find/delete） |
| `packages/server/src/services/archive/step-emitter.ts` | SSE StepEmitter 封装（step/log/complete 事件发送） |
| `packages/server/src/services/archive/experience-merger.ts` | 经验 Agent merge 引擎（按文件批量合并） |
| `packages/web-app/components/workspaces/archive-progress.tsx` | Steps + Terminal 双面板进度组件 |

### 修改文件

| 文件 | 变更 |
|------|------|
| `packages/server/src/db/schema.sql` | 新增 archive_drafts 表 |
| `packages/server/src/services/archive/analysis-assembler.ts` | 导出 computeStats + ArchiveStats 增加全量字段 |
| `packages/server/src/services/archive/context-builder.ts` | ArchiveContext 增加 totalExecutionCount/totalSuccessCount |
| `packages/server/src/services/agent/orchestrator-service.ts` | analyzeWorkspaceForArchive 增加 draft upsert |
| `packages/server/src/services/archive/archive-service.ts` | archiveWorkspace 增加 emitter 参数 + 删除 N+1 + 集成 merger |
| `packages/server/src/services/archive/prompts.ts` | buildExperiencePrompt 增加 action/replaces_text 字段 |
| `packages/server/src/routes/archive.ts` | 归档路由改 SSE + 新增 draft 路由 |
| `packages/web-app/components/workspaces/archive-preview-dialog.tsx` | 弹窗尺寸 + draft 加载 + 进度视图切换 + 经验分组 + Skill 组选择 |
| `packages/web-app/lib/archive-api.ts` | draft API + SSE 消费函数 + 新类型 |

---

## Batch 1: P0 快速修复

### 任务 1：弹窗尺寸调整

**文件：**
- 修改：`packages/web-app/components/workspaces/archive-preview-dialog.tsx:109`

- [ ] **步骤 1：修改 DialogContent className**

```tsx
// 修改前 (line 109):
<DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">

// 修改后:
<DialogContent className="max-h-[90vh] w-full max-w-[960px] overflow-y-auto">
```

- [ ] **步骤 2：验证构建**

运行：`cd packages/web-app && npx next build` 或使用 dev server 验证弹窗渲染正常
预期：弹窗宽度 960px，高度最大 90vh

- [ ] **步骤 3：Commit**

```bash
git add packages/web-app/components/workspaces/archive-preview-dialog.tsx
git commit -m "fix: archive dialog size to 960px × 90vh"
```

---

### 任务 2：统计 BUG 修复 — 统一 computeStats

**文件：**
- 修改：`packages/server/src/services/archive/context-builder.ts`
- 修改：`packages/server/src/services/archive/analysis-assembler.ts`
- 修改：`packages/server/src/services/archive/archive-service.ts`
- 测试：`packages/server/src/services/archive/__tests__/analysis-assembler.test.ts`

- [ ] **步骤 1：ArchiveContext 增加全量计数**

在 `context-builder.ts` 的 `ArchiveContext` 接口增加字段：

```typescript
// 在 ArchiveContext 接口中添加（约 line 17-33 区域）
export interface ArchiveContext {
  workspace: { /* ... existing fields ... */ }
  executions: ExecutionSummary[]
  workflows: WorkflowProfile[]
  errorCatalog: ErrorEntry[]
  costProfile: CostProfile
  nodePatterns: NodePattern[]
  existingKnowledge: ExistingRule[]
  // ★ 新增：全量计数（不受采样影响）
  totalExecutionCount: number
  totalSuccessCount: number
}
```

在 `buildArchiveContext` 函数中，添加全量 COUNT 查询：

```typescript
// 在 buildArchiveContext 函数内，与现有 Promise.all 并行添加：
const totalCounts = await (async () => {
  const row = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as success
    FROM executions
    WHERE workspace_id = ?
  `).get(workspaceId) as { total: number; success: number }
  return { total: row?.total ?? 0, success: row?.success ?? 0 }
})()

// 在返回的 ArchiveContext 对象中添加：
return {
  // ... existing fields ...
  totalExecutionCount: totalCounts.total,
  totalSuccessCount: totalCounts.success,
}
```

- [ ] **步骤 2：修改 computeStats 使用全量计数**

在 `analysis-assembler.ts` 中修改 `computeStats`：

```typescript
// 修改前（line 87-111 区域）：
export function computeStats(ctx: ArchiveContext): ArchiveStats {
  const { executions, workspace } = ctx

  const execution_count = executions.length
  const completed = executions.filter((e) => e.status === "completed").length
  const success_rate = execution_count > 0 ? (completed / execution_count) * 100 : 0
  // ...
}

// 修改后：
export function computeStats(ctx: ArchiveContext): ArchiveStats {
  const { executions, workspace } = ctx

  // ★ 使用全量计数而非采样计数
  const execution_count = ctx.totalExecutionCount
  const success_rate = execution_count > 0
    ? (ctx.totalSuccessCount / execution_count) * 100
    : 0

  // 成本和时间仍从采样数据计算（因为需要详细数据）
  const total_cost = executions.reduce((sum, e) => sum + e.cost, 0)
  const total_duration_s = executions.reduce((sum, e) => sum + e.duration_s, 0)
  const total_duration_ms = total_duration_s * 1000

  const avg_cost_per_execution = execution_count > 0 ? total_cost / executions.length : 0
  const avg_duration_ms = execution_count > 0 ? total_duration_ms / executions.length : 0

  return {
    execution_count,
    success_rate,
    total_cost,
    total_duration_ms,
    avg_cost_per_execution,
    avg_duration_ms,
    lifespan_days: workspace.lifespan_days,
    workflow_count: ctx.workflows.length,
  }
}
```

- [ ] **步骤 3：archiveWorkspace 使用 computeStats**

在 `archive-service.ts` 的 P2.4 `archiveWorkspace` 方法中，删除 N+1 循环，改用传入的 stats：

```typescript
// 删除 lines 297-305 区域的 N+1 查询：
// const totalCost = executions.reduce(...)
// const totalDurationMs = executions.reduce(...)

// 替换为：使用 options.stats 或默认值
const stats = options.stats ?? {
  execution_count: archivedExecutions,
  total_cost: 0,
  total_duration_ms: 0,
  success_rate: 0,
  avg_cost_per_execution: 0,
  avg_duration_ms: 0,
  lifespan_days: 0,
  workflow_count: 0,
}

// 修改 workspaceArchiveRow 构造：
const workspaceArchiveRow: WorkspaceArchiveRow = {
  workspace_id: workspaceId,
  org: workspace.org,
  name: workspace.name,
  description: workspace.description,
  source: workspace.source,
  execution_count: stats.execution_count,  // ← 使用 stats
  total_cost: stats.total_cost,            // ← 使用 stats
  total_duration_ms: stats.total_duration_ms, // ← 使用 stats
  created_at: workspace.created_at,
  archived_at: new Date().toISOString(),
  metadata: null,
  extracted_experiences: 0,
  extracted_skills: 0,
  analysis_report: options.analysisReport ? JSON.stringify(options.analysisReport) : null,
  file_deleted: 0,
}
```

同时修改 `archiveWorkspace` 的 options 类型：

```typescript
async archiveWorkspace(
  workspaceId: string,
  org: string,
  options: {
    extractExperiences: string[]
    installSkills: string[]  // 后续 Batch 3 改为 SkillInstallOption[]
    analysisReport?: unknown
    stats?: {  // ← 新增
      execution_count: number
      total_cost: number
      total_duration_ms: number
      success_rate: number
      avg_cost_per_execution: number
      avg_duration_ms: number
      lifespan_days: number
      workflow_count: number
    }
  }
): Promise<{ /* unchanged return type */ }>
```

- [ ] **步骤 4：更新测试**

在 `analysis-assembler.test.ts` 的 `makeContext` helper 中添加新字段：

```typescript
function makeContext(overrides: Partial<ArchiveContext> = {}): ArchiveContext {
  return {
    workspace: { /* ... existing ... */ },
    executions: [],
    workflows: [],
    errorCatalog: [],
    costProfile: { /* ... existing ... */ },
    nodePatterns: [],
    existingKnowledge: [],
    totalExecutionCount: 0,  // ← 新增
    totalSuccessCount: 0,    // ← 新增
    ...overrides,
  }
}
```

添加新测试：

```typescript
describe("computeStats — full count", () => {
  it("uses totalExecutionCount instead of sampled executions length", () => {
    const ctx = makeContext({
      totalExecutionCount: 100,
      totalSuccessCount: 80,
      executions: [
        makeExecution({ status: "completed", cost: 1.0, duration_s: 10 }),
        makeExecution({ status: "failed", cost: 0.5, duration_s: 5 }),
      ],
    })
    const stats = computeStats(ctx)
    expect(stats.execution_count).toBe(100)
    expect(stats.success_rate).toBe(80)
    // total_cost still from sampled data
    expect(stats.total_cost).toBe(1.5)
  })
})
```

- [ ] **步骤 5：运行测试**

运行：`cd packages/server && npx vitest run src/services/archive/__tests__/analysis-assembler.test.ts`
预期：所有测试 PASS

- [ ] **步骤 6：Commit**

```bash
git add packages/server/src/services/archive/context-builder.ts \
       packages/server/src/services/archive/analysis-assembler.ts \
       packages/server/src/services/archive/archive-service.ts \
       packages/server/src/services/archive/__tests__/analysis-assembler.test.ts
git commit -m "fix: unify stats computation — use full execution counts

- Add totalExecutionCount/totalSuccessCount to ArchiveContext
- computeStats uses full counts for execution_count and success_rate
- archiveWorkspace accepts stats from preview, removes N+1 queries"
```

---

## Batch 2: P1 核心架构

### 任务 3：archive_drafts 表 + DAO

**文件：**
- 修改：`packages/server/src/db/schema.sql`
- 创建：`packages/server/src/db/dao/archive-draft-dao.ts`
- 测试：`packages/server/src/db/dao/__tests__/archive-draft-dao.test.ts`

- [ ] **步骤 1：编写失败的测试**

创建 `packages/server/src/db/dao/__tests__/archive-draft-dao.test.ts`：

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import Database from "better-sqlite3"
import { ArchiveDraftDAO } from "../archive-draft-dao"

describe("ArchiveDraftDAO", () => {
  let db: Database.Database
  let dao: ArchiveDraftDAO

  beforeEach(() => {
    db = new Database(":memory:")
    db.exec(`
      CREATE TABLE IF NOT EXISTS archive_drafts (
        workspace_id TEXT PRIMARY KEY,
        org TEXT NOT NULL,
        analysis_report TEXT NOT NULL,
        experiences TEXT NOT NULL DEFAULT '[]',
        skills TEXT NOT NULL DEFAULT '[]',
        stats TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `)
    dao = new ArchiveDraftDAO(db)
  })

  afterEach(() => { db.close() })

  it("upsert creates new draft", () => {
    dao.upsert({
      workspace_id: "ws-1",
      org: "test-org",
      analysis_report: '{"summary":"test"}',
      experiences: "[]",
      skills: "[]",
      stats: "{}",
    })
    const draft = dao.findByWorkspaceId("ws-1")
    expect(draft).toBeDefined()
    expect(draft!.org).toBe("test-org")
    expect(draft!.analysis_report).toBe('{"summary":"test"}')
  })

  it("upsert overwrites existing draft", () => {
    dao.upsert({
      workspace_id: "ws-1", org: "test-org",
      analysis_report: '{"summary":"v1"}', experiences: "[]", skills: "[]", stats: "{}",
    })
    dao.upsert({
      workspace_id: "ws-1", org: "test-org",
      analysis_report: '{"summary":"v2"}', experiences: "[]", skills: "[]", stats: "{}",
    })
    const draft = dao.findByWorkspaceId("ws-1")
    expect(draft!.analysis_report).toBe('{"summary":"v2"}')
  })

  it("findByWorkspaceId returns undefined for missing", () => {
    expect(dao.findByWorkspaceId("nonexistent")).toBeUndefined()
  })

  it("delete removes draft", () => {
    dao.upsert({
      workspace_id: "ws-1", org: "test-org",
      analysis_report: "{}", experiences: "[]", skills: "[]", stats: "{}",
    })
    dao.delete("ws-1")
    expect(dao.findByWorkspaceId("ws-1")).toBeUndefined()
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd packages/server && npx vitest run src/db/dao/__tests__/archive-draft-dao.test.ts`
预期：FAIL — `Cannot find module '../archive-draft-dao'`

- [ ] **步骤 3：添加 schema.sql 表定义**

在 `packages/server/src/db/schema.sql` 末尾（workspace_archive 索引之后）添加：

```sql
-- archive_drafts: cached analysis results to avoid repeated LLM calls
CREATE TABLE IF NOT EXISTS archive_drafts (
  workspace_id TEXT PRIMARY KEY,
  org TEXT NOT NULL,
  analysis_report TEXT NOT NULL,
  experiences TEXT NOT NULL DEFAULT '[]',
  skills TEXT NOT NULL DEFAULT '[]',
  stats TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

- [ ] **步骤 4：实现 ArchiveDraftDAO**

创建 `packages/server/src/db/dao/archive-draft-dao.ts`：

```typescript
import type Database from "better-sqlite3"

export interface ArchiveDraftRow {
  workspace_id: string
  org: string
  analysis_report: string
  experiences: string
  skills: string
  stats: string
}

export class ArchiveDraftDAO {
  constructor(private db: Database.Database) {}

  private stmt(sql: string) {
    return this.db.prepare(sql)
  }

  findByWorkspaceId(workspaceId: string): ArchiveDraftRow | undefined {
    return this.stmt(
      "SELECT workspace_id, org, analysis_report, experiences, skills, stats, created_at, updated_at FROM archive_drafts WHERE workspace_id = ?"
    ).get(workspaceId) as ArchiveDraftRow | undefined
  }

  upsert(row: ArchiveDraftRow): void {
    this.stmt(`
      INSERT INTO archive_drafts (workspace_id, org, analysis_report, experiences, skills, stats, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
      ON CONFLICT(workspace_id) DO UPDATE SET
        org = excluded.org,
        analysis_report = excluded.analysis_report,
        experiences = excluded.experiences,
        skills = excluded.skills,
        stats = excluded.stats,
        updated_at = datetime('now')
    `).run(
      row.workspace_id, row.org, row.analysis_report,
      row.experiences, row.skills, row.stats,
    )
  }

  delete(workspaceId: string): void {
    this.stmt("DELETE FROM archive_drafts WHERE workspace_id = ?").run(workspaceId)
  }
}
```

- [ ] **步骤 5：运行测试验证通过**

运行：`cd packages/server && npx vitest run src/db/dao/__tests__/archive-draft-dao.test.ts`
预期：4 tests PASS

- [ ] **步骤 6：Commit**

```bash
git add packages/server/src/db/schema.sql \
       packages/server/src/db/dao/archive-draft-dao.ts \
       packages/server/src/db/dao/__tests__/archive-draft-dao.test.ts
git commit -m "feat: add archive_drafts table and DAO

- New table: archive_drafts (workspace_id PK, JSON columns)
- DAO: upsert/findByWorkspaceId/delete
- Used to cache analysis results across dialog sessions"
```

---

### 任务 4：Draft 服务端路由

**文件：**
- 修改：`packages/server/src/routes/archive.ts`

- [ ] **步骤 1：添加 draft 路由**

在 `packages/server/src/routes/archive.ts` 的 `createArchiveRoutes` 函数中添加两个新路由（在现有路由之后）：

```typescript
import { ArchiveDraftDAO } from "../db/dao/archive-draft-dao"

// 在 createArchiveRoutes 函数参数中添加 archiveDraftDAO
export function createArchiveRoutes(
  pendingReview: any,
  stateDir: string,
  archiveDAO: ArchiveDAO,
  archiveDraftDAO: ArchiveDraftDAO,  // ← 新增参数
): Hono {
  const app = new Hono()

  // ... existing routes ...

  // ── Draft routes ──────────────────────────────────────────

  app.get("/workspaces/:id/archive-draft", (c) => {
    const workspaceId = c.req.param("id")
    const draft = archiveDraftDAO.findByWorkspaceId(workspaceId)
    if (!draft) {
      return c.json({ error: "not_found" }, 404)
    }
    return c.json({
      workspace_id: draft.workspace_id,
      org: draft.org,
      analysis_report: JSON.parse(draft.analysis_report),
      experiences: JSON.parse(draft.experiences),
      skills: JSON.parse(draft.skills),
      stats: JSON.parse(draft.stats),
      created_at: (draft as any).created_at,
      updated_at: (draft as any).updated_at,
    })
  })

  app.delete("/workspaces/:id/archive-draft", (c) => {
    const workspaceId = c.req.param("id")
    archiveDraftDAO.delete(workspaceId)
    return c.json({ success: true })
  })

  return app
}
```

- [ ] **步骤 2：更新 server index.ts 路由注册**

在 `packages/server/src/index.ts` 中找到 `createArchiveRoutes` 调用，添加 `ArchiveDraftDAO` 实例化：

```typescript
// 在现有 DAO 初始化附近添加：
import { ArchiveDraftDAO } from "./db/dao/archive-draft-dao"
const archiveDraftDAO = new ArchiveDraftDAO(db)

// 修改 createArchiveRoutes 调用：
app.route("/api/archive", createArchiveRoutes(d.pendingReview, stateDir, d.archive, archiveDraftDAO))
```

- [ ] **步骤 3：构建验证**

运行：`cd packages/server && npx tsup`
预期：构建成功，无类型错误

- [ ] **步骤 4：Commit**

```bash
git add packages/server/src/routes/archive.ts packages/server/src/index.ts
git commit -m "feat: add archive draft GET/DELETE routes

- GET /workspaces/:id/archive-draft — load cached analysis (200/404)
- DELETE /workspaces/:id/archive-draft — clear draft"
```

---

### 任务 5：Preview API 集成 draft 自动保存

**文件：**
- 修改：`packages/server/src/services/agent/orchestrator-service.ts:558-596`

- [ ] **步骤 1：analyzeWorkspaceForArchive 添加 draft upsert**

在 `orchestrator-service.ts` 的 `analyzeWorkspaceForArchive` 方法中，Phase 3 之后、return 之前添加 draft 保存：

```typescript
async analyzeWorkspaceForArchive(workspaceId: string): Promise<ArchivePreview> {
  // Phase 1: Build context (unchanged)
  const { buildArchiveContext } = await import('../archive/context-builder')
  const { WorkspaceDAO } = await import('../../db/dao/workspace-dao')
  const { ExecutionDAO } = await import('../../db/dao/execution-dao')
  const { getDb } = await import('../../db')

  const db = getDb()
  const workspaceDAO = new WorkspaceDAO(db)
  const executionDAO = new ExecutionDAO(db)
  const ctx = await buildArchiveContext(workspaceId, workspaceDAO, executionDAO, db, this.org)

  if (!ctx) {
    return this.emptyPreview('Workspace not found')
  }

  // Phase 2: Parallel LLM analysis (unchanged)
  const { buildRetrospectivePrompt, buildExperiencePrompt, buildSkillDiscoveryPrompt } = await import('../archive/prompts')
  const { assembleAnalysis } = await import('../archive/analysis-assembler')

  const retrospectivePrompt = buildRetrospectivePrompt(ctx)
  const experiencePrompt = buildExperiencePrompt(ctx)
  const skillPrompt = buildSkillDiscoveryPrompt(ctx)

  const [reportResult, experienceResult, skillResult] = await Promise.allSettled([
    this.callArchiveLLM(retrospectivePrompt, 'You are an expert engineering analyst reviewing a completed workspace for archival.'),
    this.callArchiveLLM(experiencePrompt, 'You are a knowledge extraction engine. Respond with only the JSON array.'),
    this.callArchiveLLM(skillPrompt, 'You are a skill discovery agent. Respond with only the JSON array.'),
  ])

  const report = parseReport(reportResult)
  const experiences = parseExperiences(experienceResult)
  const skills = parseSkills(skillResult)

  // Phase 3: Assemble
  const preview = assembleAnalysis(ctx, report, experiences, skills)

  // ★ Draft: 先落库，再返回 — 即使客户端断开，draft 已安全
  try {
    const { ArchiveDraftDAO } = await import('../../db/dao/archive-draft-dao')
    const archiveDraftDAO = new ArchiveDraftDAO(db)
    archiveDraftDAO.upsert({
      workspace_id: workspaceId,
      org: this.org,
      analysis_report: JSON.stringify(preview.analysis),
      experiences: JSON.stringify(preview.experiences),
      skills: JSON.stringify(preview.skills),
      stats: JSON.stringify(preview.stats),
    })
  } catch (err) {
    console.warn('Failed to save archive draft:', err)
    // Non-fatal: preview still returns to client
  }

  return preview
}
```

- [ ] **步骤 2：构建验证**

运行：`cd packages/server && npx tsup`
预期：构建成功

- [ ] **步骤 3：Commit**

```bash
git add packages/server/src/services/agent/orchestrator-service.ts
git commit -m "feat: auto-save draft before returning preview

analyzeWorkspaceForArchive upserts to archive_drafts table
before returning HTTP response. Ensures data survives client disconnect."
```

---

### 任务 6：Draft 客户端 API + 前端集成

**文件：**
- 修改：`packages/web-app/lib/archive-api.ts`
- 修改：`packages/web-app/components/workspaces/archive-preview-dialog.tsx`

- [ ] **步骤 1：添加 draft 客户端 API**

在 `packages/web-app/lib/archive-api.ts` 末尾添加：

```typescript
// ── Draft API ────────────────────────────────────────────────

export interface ArchiveDraft {
  workspace_id: string
  org: string
  analysis_report: AnalysisReport
  experiences: ExperienceCandidate[]
  skills: SkillCandidate[]
  stats: WorkspaceStats
  created_at: string
  updated_at: string
}

export async function getArchiveDraft(workspaceId: string): Promise<ArchiveDraft | null> {
  const res = await apiFetch(`${getServerUrl()}/api/archive/workspaces/${workspaceId}/archive-draft`, {
    credentials: "include",
  })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`Failed to load draft: ${res.status}`)
  return res.json()
}

export async function deleteArchiveDraft(workspaceId: string): Promise<void> {
  await apiFetch(`${getServerUrl()}/api/archive/workspaces/${workspaceId}/archive-draft`, {
    method: "DELETE",
    credentials: "include",
  })
}
```

- [ ] **步骤 2：修改 archive-preview-dialog.tsx 添加 draft 加载逻辑**

在组件顶部添加状态和 draft 加载逻辑：

```tsx
// 新增状态（在现有 useState 声明区域）
const [draft, setDraft] = useState<ArchiveDraft | null>(null)
const [draftAge, setDraftAge] = useState<string | null>(null)

// 修改 loadPreview 函数：先检查 draft
const loadPreview = async () => {
  if (!workspace) return

  // 检查是否有 draft
  try {
    const existingDraft = await getArchiveDraft(workspace.id)
    if (existingDraft) {
      setDraft(existingDraft)
      setPreview({
        stats: existingDraft.stats,
        analysis: existingDraft.analysis_report,
        experiences: existingDraft.experiences,
        skills: existingDraft.skills,
      })
      const age = formatDraftAge(existingDraft.updated_at)
      setDraftAge(age)
      return
    }
  } catch {
    // Draft load failed — fall through to normal preview
  }

  // 无 draft，正常加载
  setLoading(true)
  try {
    const result = await previewArchive(workspace.id)
    setPreview(result)
    setDraft(null)
    setDraftAge(null)
  } catch (err) {
    toast.error(err instanceof Error ? err.message : "加载预览失败")
  } finally {
    setLoading(false)
  }
}

// 重新分析处理
const handleRegenerate = async () => {
  if (!workspace) return
  await deleteArchiveDraft(workspace.id)
  setDraft(null)
  setDraftAge(null)
  setPreview(null)
  loadPreview()
}

// Draft 年龄格式化辅助
function formatDraftAge(updatedAt: string): string {
  const diff = Date.now() - new Date(updatedAt).getTime()
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return "刚刚"
  if (minutes < 60) return `${minutes}分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}小时前`
  const days = Math.floor(hours / 24)
  return `${days}天前`
}
```

- [ ] **步骤 3：在弹窗头部显示 draft 状态**

在 DialogDescription 之后、stats cards 之前添加 draft 提示：

```tsx
{draft && draftAge && (
  <div className="flex items-center justify-between rounded-md bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 px-3 py-2 text-sm">
    <span className="text-amber-800 dark:text-amber-200">
      已加载上次分析结果（{draftAge}）
    </span>
    <Button variant="outline" size="sm" onClick={handleRegenerate}>
      重新分析
    </Button>
  </div>
)}
```

- [ ] **步骤 4：构建验证**

运行：`cd packages/web-app && npx next build` 或 dev server 验证
预期：打开归档弹窗，有 draft 时显示黄色提示条 + "重新分析"按钮

- [ ] **步骤 5：Commit**

```bash
git add packages/web-app/lib/archive-api.ts \
       packages/web-app/components/workspaces/archive-preview-dialog.tsx
git commit -m "feat: draft loading in archive preview dialog

- getArchiveDraft/deleteArchiveDraft client API
- Dialog checks for draft on open, loads if exists
- Shows age indicator + 'Regenerate' button when draft present"
```

---

### 任务 7：SSE StepEmitter 工具

**文件：**
- 创建：`packages/server/src/services/archive/step-emitter.ts`
- 测试：`packages/server/src/services/archive/__tests__/step-emitter.test.ts`

- [ ] **步骤 1：编写失败的测试**

创建 `packages/server/src/services/archive/__tests__/step-emitter.test.ts`：

```typescript
import { describe, it, expect, vi } from "vitest"
import { StepEmitter, createStepEmitter } from "../step-emitter"

describe("StepEmitter", () => {
  it("stepStart emits step event with running status", async () => {
    const events: Array<{ event: string; data: string }> = []
    const mockStream = {
      writeSSE: vi.fn((e: { event: string; data: string }) => { events.push(e) }),
    }
    const emitter = createStepEmitter(mockStream as any)
    await emitter.stepStart("archive_executions", "归档 12 条执行记录...")
    expect(events).toHaveLength(1)
    const parsed = JSON.parse(events[0].data)
    expect(parsed.step).toBe("archive_executions")
    expect(parsed.status).toBe("running")
    expect(parsed.detail).toBe("归档 12 条执行记录...")
  })

  it("stepDone emits step event with done status", async () => {
    const events: Array<{ event: string; data: string }> = []
    const mockStream = {
      writeSSE: vi.fn((e: { event: string; data: string }) => { events.push(e) }),
    }
    const emitter = createStepEmitter(mockStream as any)
    await emitter.stepDone("archive_executions", { count: 12 })
    const parsed = JSON.parse(events[0].data)
    expect(parsed.status).toBe("done")
    expect(parsed.data.count).toBe(12)
  })

  it("log emits log event", async () => {
    const events: Array<{ event: string; data: string }> = []
    const mockStream = {
      writeSSE: vi.fn((e: { event: string; data: string }) => { events.push(e) }),
    }
    const emitter = createStepEmitter(mockStream as any)
    await emitter.log("Archiving execution abc-123")
    expect(events[0].event).toBe("log")
    const parsed = JSON.parse(events[0].data)
    expect(parsed.message).toBe("Archiving execution abc-123")
  })

  it("complete emits complete event", async () => {
    const events: Array<{ event: string; data: string }> = []
    const mockStream = {
      writeSSE: vi.fn((e: { event: string; data: string }) => { events.push(e) }),
    }
    const emitter = createStepEmitter(mockStream as any)
    await emitter.complete({ success: true, archivedExecutions: 12, extractedExperiences: 5, installedSkills: 2, fileDeleted: true })
    expect(events[0].event).toBe("complete")
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd packages/server && npx vitest run src/services/archive/__tests__/step-emitter.test.ts`
预期：FAIL — `Cannot find module '../step-emitter'`

- [ ] **步骤 3：实现 StepEmitter**

创建 `packages/server/src/services/archive/step-emitter.ts`：

```typescript
import type { SSEStream } from "hono/streaming"

export interface StepEmitter {
  stepStart(step: string, detail: string): Promise<void>
  stepProgress(step: string, detail: string): Promise<void>
  stepDone(step: string, data?: Record<string, unknown>): Promise<void>
  stepError(step: string, message: string): Promise<void>
  log(message: string): Promise<void>
  complete(data: Record<string, unknown>): Promise<void>
}

export function createStepEmitter(stream: SSEStream): StepEmitter {
  const write = async (event: string, data: unknown) => {
    try {
      await stream.writeSSE({ event, data: JSON.stringify(data) })
    } catch {
      // Client disconnected — continue emitting (server-side work continues)
    }
  }

  return {
    async stepStart(step: string, detail: string) {
      await write("step", { step, status: "running", detail })
    },
    async stepProgress(step: string, detail: string) {
      await write("step", { step, status: "progress", detail })
    },
    async stepDone(step: string, data?: Record<string, unknown>) {
      await write("step", { step, status: "done", data })
    },
    async stepError(step: string, message: string) {
      await write("step", { step, status: "error", detail: message })
    },
    async log(message: string) {
      await write("log", { message })
    },
    async complete(data: Record<string, unknown>) {
      await write("complete", data)
    },
  }
}

/** No-op emitter for non-SSE contexts (backward compatibility) */
export function createNullEmitter(): StepEmitter {
  const noop = async () => {}
  return {
    stepStart: noop,
    stepProgress: noop,
    stepDone: noop,
    stepError: noop,
    log: noop,
    complete: noop,
  }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd packages/server && npx vitest run src/services/archive/__tests__/step-emitter.test.ts`
预期：4 tests PASS

- [ ] **步骤 5：Commit**

```bash
git add packages/server/src/services/archive/step-emitter.ts \
       packages/server/src/services/archive/__tests__/step-emitter.test.ts
git commit -m "feat: add StepEmitter for SSE progress streaming

- createStepEmitter wraps Hono SSEStream with step/log/complete methods
- createNullEmitter for backward-compatible non-SSE contexts
- All writes are error-safe (client disconnect doesn't crash server)"
```

---

### 任务 8：归档路由改 SSE + archiveWorkspace 集成 emitter

**文件：**
- 修改：`packages/server/src/routes/archive.ts`
- 修改：`packages/server/src/services/archive/archive-service.ts`

- [ ] **步骤 1：archiveWorkspace 方法签名添加 emitter 参数**

在 `archive-service.ts` 的 P2.4 `archiveWorkspace` 方法中添加 emitter 参数并在每步调用：

```typescript
import { StepEmitter, createNullEmitter } from "./step-emitter"

// 修改方法签名：
async archiveWorkspace(
  workspaceId: string,
  org: string,
  options: {
    extractExperiences: string[]
    installSkills: string[]
    analysisReport?: unknown
    stats?: { /* same as Task 2 */ }
  },
  emitter: StepEmitter = createNullEmitter(),  // ← 新增，默认 null emitter
): Promise<{ /* unchanged return type */ }>
```

在方法体内的每个步骤前添加 emitter 调用：

```typescript
// Step 2 前：
await emitter.stepStart("archive_executions", `归档 ${executions.length} 条执行记录...`)
// ... 现有 Step 2 循环 ...
// 循环内：
await emitter.log(`Archived execution ${exec.id}`)
// Step 2 后：
await emitter.stepDone("archive_executions", { count: archivedExecutions })

// Step 3 前：
await emitter.stepStart("create_record", "创建归档记录...")
// ... 现有 Step 3 ...
await emitter.stepDone("create_record")

// Step 4 前：
await emitter.stepStart("extract_experiences", `提取 ${options.extractExperiences.length} 条经验...`)
// ... 现有 Step 4 ...
await emitter.stepDone("extract_experiences", { count: extractedExperiences })

// Step 5 前：
await emitter.stepStart("install_skills", `安装 ${options.installSkills.length} 个 Skill...`)
// ... 现有 Step 5 ...
await emitter.stepDone("install_skills", { count: installedSkills })

// Step 6 前：
await emitter.stepStart("delete_files", "清理工作空间文件...")
// ... 现有 Step 6 ...
await emitter.stepDone("delete_files", { deleted: fileDeleted })

// Step 7 前：
await emitter.stepStart("update_stats", "更新统计...")
// ... 现有 Step 7 ...
await emitter.stepDone("update_stats")

// Step 8 前：
await emitter.stepStart("soft_archive", "软归档...")
// ... 现有 Step 8 ...
await emitter.stepDone("soft_archive")

// Draft cleanup (新增步骤)：
await emitter.stepStart("cleanup_draft", "清理草稿...")
try {
  const { ArchiveDraftDAO } = await import("../../db/dao/archive-draft-dao")
  const draftDAO = new ArchiveDraftDAO(this.db)
  draftDAO.delete(workspaceId)
} catch { /* non-fatal */ }
await emitter.stepDone("cleanup_draft")

// 在 return 前：
await emitter.complete({
  success: true,
  archivedExecutions,
  extractedExperiences,
  installedSkills,
  fileDeleted,
})
```

对于 catch 块中的错误处理，添加：

```typescript
} catch (err) {
  // 找到当前执行中的步骤并标记错误
  await emitter.stepError("unknown", err instanceof Error ? err.message : String(err))
  // ... existing error return ...
}
```

- [ ] **步骤 2：归档路由改为 SSE**

在 `packages/server/src/routes/archive.ts` 中，修改归档 POST 路由：

```typescript
import { streamSSE } from "hono/streaming"
import { createStepEmitter } from "../services/archive/step-emitter"

// 替换现有的 POST /workspaces/:id/archive 路由：
app.post("/workspaces/:id/archive", async (c) => {
  const workspaceId = c.req.param("id")
  const org = c.req.query("org") || "default"

  const body = await c.req.json<{
    extractExperiences?: string[]
    installSkills?: string[]
    analysisReport?: unknown
    stats?: Record<string, unknown>
  }>()

  return streamSSE(c, async (stream) => {
    const emitter = createStepEmitter(stream)

    const archiveService = getArchiveService()
    const result = await archiveService.archiveWorkspace(
      workspaceId,
      org,
      {
        extractExperiences: body.extractExperiences || [],
        installSkills: body.installSkills || [],
        analysisReport: body.analysisReport,
        stats: body.stats as any,
      },
      emitter,
    )

    // If archiveWorkspace returned error, emit error event
    if (!result.success) {
      await stream.writeSSE({
        event: "error",
        data: JSON.stringify({ message: result.error || "Archive failed" }),
      })
    }
  })
})
```

- [ ] **步骤 3：构建验证**

运行：`cd packages/server && npx tsup`
预期：构建成功

- [ ] **步骤 4：Commit**

```bash
git add packages/server/src/routes/archive.ts \
       packages/server/src/services/archive/archive-service.ts
git commit -m "feat: archive route uses SSE with StepEmitter progress

- POST /workspaces/:id/archive returns text/event-stream
- archiveWorkspace emits step events for each of 8 steps
- Added cleanup_draft step to remove draft after successful archive
- NullEmitter for backward compatibility with non-SSE callers"
```

---

### 任务 9：ArchiveProgress 组件 + SSE 客户端

**文件：**
- 修改：`packages/web-app/lib/archive-api.ts`
- 创建：`packages/web-app/components/workspaces/archive-progress.tsx`
- 修改：`packages/web-app/components/workspaces/archive-preview-dialog.tsx`

- [ ] **步骤 1：添加 SSE 客户端函数**

在 `packages/web-app/lib/archive-api.ts` 中添加：

```typescript
// ── SSE Archive ──────────────────────────────────────────────

export interface StepEvent {
  step: string
  status: "running" | "progress" | "done" | "error"
  detail?: string
  data?: Record<string, unknown>
}

export function archiveWorkspaceSSE(
  workspaceId: string,
  options: {
    extractExperiences?: string[]
    installSkills?: string[]
    analysisReport?: unknown
    stats?: Record<string, unknown>
  },
  onStep: (event: StepEvent) => void,
  onLog: (message: string) => void,
  onComplete: (result: ArchiveResult) => void,
  onError: (error: Error) => void,
): AbortController {
  const abort = new AbortController()
  const params = `?org=${encodeURIComponent("default")}`

  fetch(`${getServerUrl()}/api/archive/workspaces/${workspaceId}/archive${params}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(options),
    credentials: "include",
    signal: abort.signal,
  }).then(async (res) => {
    if (!res.ok || !res.body) {
      onError(new Error(`HTTP ${res.status}`))
      return
    }
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split("\n")
      buffer = lines.pop() || ""

      let currentEvent = ""
      for (const line of lines) {
        if (line.startsWith("event:")) {
          currentEvent = line.slice(6).trim()
        } else if (line.startsWith("data:")) {
          const raw = line.slice(5).trim()
          try {
            const data = JSON.parse(raw)
            if (currentEvent === "step") onStep(data as StepEvent)
            else if (currentEvent === "log") onLog(data.message)
            else if (currentEvent === "complete") onComplete(data as ArchiveResult)
            else if (currentEvent === "error") onError(new Error(data.message))
          } catch {
            // Skip malformed JSON
          }
          currentEvent = ""
        }
      }
    }
  }).catch((err) => {
    if (err.name !== "AbortError") onError(err)
  })

  return abort
}
```

- [ ] **步骤 2：创建 ArchiveProgress 组件**

创建 `packages/web-app/components/workspaces/archive-progress.tsx`。

使用规格文档 §2.2 中的完整组件代码（已在规格中定义），注意：

1. 从 `@/lib/archive-api` 导入 `archiveWorkspaceSSE`、`StepEvent`、`ArchiveResult`
2. 导入 `Button` 从 `@/components/ui/button`
3. 导入 `cn` 从 `@/lib/utils`
4. 导入 lucide-react 图标：`CheckCircle2, Circle, Loader2, XCircle, Pause, Terminal`

组件代码直接使用规格文档中的 `ArchiveProgress` 组件实现（约 230 行）。

- [ ] **步骤 3：集成到 archive-preview-dialog.tsx**

在 `archive-preview-dialog.tsx` 中：

```tsx
// 新增导入
import { ArchiveProgress } from "./archive-progress"

// 新增状态（在现有 state 区域）
const [archiving, setArchiving] = useState(false)

// 修改 handleArchive 函数为 handleStartArchive：
const handleStartArchive = () => {
  setArchiving(true)
}

// 修改 DialogFooter 的确认归档按钮：
<Button onClick={handleStartArchive} disabled={archiving || loading}>
  {archiving ? "归档中..." : "确认归档"}
</Button>

// 在 loading/preview 渲染逻辑中，添加 archiving 分支：
{loading ? (
  /* existing loading spinner */
) : archiving && preview ? (
  <ArchiveProgress
    workspaceId={workspace.id}
    options={{
      extractExperiences: selectedExperiences,
      installSkills: selectedSkills,
      stats: preview.stats as any,
    }}
    onComplete={(result) => {
      toast.success(`"${workspace.name}" 已归档`)
      onOpenChange(false)
      onArchived()
    }}
    onCancel={() => {
      setArchiving(false)
      onOpenChange(false)
    }}
  />
) : preview ? (
  /* existing preview tabs */
) : (
  /* existing error state */
)}
```

- [ ] **步骤 4：构建验证**

运行：`cd packages/web-app && npx next build`
预期：构建成功

- [ ] **步骤 5：Commit**

```bash
git add packages/web-app/lib/archive-api.ts \
       packages/web-app/components/workspaces/archive-progress.tsx \
       packages/web-app/components/workspaces/archive-preview-dialog.tsx
git commit -m "feat: ArchiveProgress component with SSE client

- archiveWorkspaceSSE: fetch + ReadableStream SSE consumer
- ArchiveProgress: Steps panel (280px) + Terminal log panel (flex-1)
- Dialog integration: switches to progress view on confirm
- Auto-scroll terminal, step status icons, error/complete states"
```

---

## Batch 3: P2 知识联动

### 任务 10：经验 Prompt 增强 — action 字段

**文件：**
- 修改：`packages/server/src/services/archive/prompts.ts`
- 修改：`packages/server/src/services/agent/orchestrator-service.ts`（parseExperiences）
- 修改：`packages/server/src/services/archive/analysis-assembler.ts`（ExperienceCandidate 类型）
- 修改：`packages/web-app/lib/archive-api.ts`（客户端类型）

- [ ] **步骤 1：更新 ExperienceCandidate 类型（服务端）**

在 `analysis-assembler.ts` 中修改 `ExperienceCandidate`：

```typescript
export interface ExperienceCandidate {
  id: string
  text: string
  scope: string
  target: string
  confidence: number
  evidence: string
  category: string
  conflicts: ConflictInfo[]
  // ★ 新增字段
  action: "add" | "update" | "delete"
  replaces_text?: string
}
```

- [ ] **步骤 2：更新客户端类型**

在 `packages/web-app/lib/archive-api.ts` 中更新 `ExperienceCandidate`：

```typescript
export interface ExperienceCandidate {
  id: string
  text: string
  scope: string
  confidence: number
  evidence?: string
  source?: string
  category?: string
  target?: string
  // ★ 新增字段
  action?: "add" | "update" | "delete"
  replaces_text?: string
}
```

- [ ] **步骤 3：修改 buildExperiencePrompt**

在 `prompts.ts` 的 `buildExperiencePrompt` 中修改 OUTPUT FORMAT 部分：

```typescript
// 替换 OUTPUT FORMAT 部分的 JSON 示例：
return `...（前面的内容不变）

═══════════════════════════════════════════════════════
OUTPUT FORMAT
═══════════════════════════════════════════════════════
Return ONLY a JSON array of experience objects (max 15):
[
  {
    "text": "Imperative sentence: a clear instruction or lesson",
    "action": "add|update|delete",
    "scope": "workflow|project|org",
    "target": "The workflow name, project name, or 'all'",
    "replaces_text": "For update/delete: the original text being replaced or removed. Null for add.",
    "confidence": 0.0-1.0,
    "evidence": "Brief description of what executions support this",
    "category": "error-prevention|cost-optimization|pattern-improvement|reliability|efficiency"
  }
]

ACTION RULES:
- "add": New experience not covered by existing knowledge.
- "update": Existing knowledge rule needs revision (provide replaces_text with the original).
- "delete": Existing knowledge rule is outdated or contradicted (provide replaces_text with the original).
- Compare against the EXISTING KNOWLEDGE RULES section above to determine action.
- If uncertain, prefer "add" over "update".

（后面的 RULES 部分不变）...`
```

- [ ] **步骤 4：修改 parseExperiences 处理新字段**

在 `orchestrator-service.ts` 的 `parseExperiences` 函数中添加新字段映射：

```typescript
function parseExperiences(result: PromiseSettledResult<string>): ExperienceCandidate[] {
  if (result.status !== 'fulfilled' || !result.value) return []
  try {
    const cleaned = result.value.replace(/```json?\n?/g, '').replace(/```/g, '').trim()
    const arr = JSON.parse(cleaned)
    if (!Array.isArray(arr)) return []
    return arr.map((e: any, i: number) => ({
      id: e.id || `exp-${i}`,
      text: e.text || '',
      scope: e.scope || 'project',
      target: e.target || '',
      confidence: typeof e.confidence === 'number' ? e.confidence : 0.5,
      evidence: e.evidence || '',
      category: e.category || 'reliability',
      conflicts: [],
      // ★ 新增字段
      action: (['add', 'update', 'delete'].includes(e.action) ? e.action : 'add') as 'add' | 'update' | 'delete',
      replaces_text: e.replaces_text || undefined,
    }))
  } catch {
    return []
  }
}
```

- [ ] **步骤 5：构建验证**

运行：`cd packages/server && npx tsup`
预期：构建成功

- [ ] **步骤 6：Commit**

```bash
git add packages/server/src/services/archive/prompts.ts \
       packages/server/src/services/agent/orchestrator-service.ts \
       packages/server/src/services/archive/analysis-assembler.ts \
       packages/web-app/lib/archive-api.ts
git commit -m "feat: experience prompt adds action/replaces_text fields

- LLM outputs action (add/update/delete) per experience
- replaces_text for update/delete identifies the original rule
- parseExperiences maps new fields with safe defaults
- Client ExperienceCandidate type updated"
```

---

### 任务 11：ExperienceMerger — Agent 批量 merge

**文件：**
- 创建：`packages/server/src/services/archive/experience-merger.ts`
- 修改：`packages/server/src/services/archive/archive-service.ts`

- [ ] **步骤 1：实现 ExperienceMerger**

创建 `packages/server/src/services/archive/experience-merger.ts`：

```typescript
import path from "path"
import fs from "fs"
import type { StepEmitter } from "./step-emitter"
import { getProvider } from "@octopus/providers"
import {
  getKnowledgeDir,
  getProjectKnowledgeDir,
  getWorkflowKnowledgeDir,
  readKnowledgeFile,
  writeKnowledgeFile,
} from "../knowledge/file-ops"

interface ExperienceAction {
  id: string
  text: string
  action: "add" | "update" | "delete"
  replaces_text?: string
  confidence: number
  category: string
}

interface MergeGroup {
  scope: string
  target: string
  filePath: string
  experiences: ExperienceAction[]
}

export class ExperienceMerger {
  async merge(
    org: string,
    selectedExperiences: ExperienceAction[],
    emitter: StepEmitter,
  ): Promise<{ added: number; updated: number; deleted: number }> {
    if (selectedExperiences.length === 0) {
      return { added: 0, updated: 0, deleted: 0 }
    }

    // Group by (scope, target)
    const groups = this.groupByTarget(selectedExperiences, org)

    let added = 0, updated = 0, deleted = 0

    for (const group of groups) {
      await emitter.log(`Loading ${group.filePath}...`)

      const currentContent = readKnowledgeFile(group.filePath)

      const mergePrompt = this.buildMergePrompt(group, currentContent)
      const mergedContent = await this.callMergeAgent(mergePrompt)

      if (mergedContent) {
        writeKnowledgeFile(group.filePath, mergedContent)
        await emitter.log(`✓ ${path.basename(group.filePath)} updated`)
      } else {
        await emitter.log(`✗ ${path.basename(group.filePath)} merge failed, skipping`)
        continue
      }

      for (const exp of group.experiences) {
        if (exp.action === "add") added++
        else if (exp.action === "update") updated++
        else if (exp.action === "delete") deleted++
      }
    }

    return { added, updated, deleted }
  }

  private groupByTarget(experiences: ExperienceAction[], org: string): MergeGroup[] {
    const map = new Map<string, MergeGroup>()

    for (const exp of experiences) {
      const key = `${exp.action === "add" ? "org" : (exp as any).scope ?? "org"}:${(exp as any).target ?? "all"}`
      const scope = (exp as any).scope ?? "org"
      const target = (exp as any).target ?? "all"

      let filePath: string
      if (scope === "workflow") {
        filePath = path.join(getWorkflowKnowledgeDir(org), `${target}.md`)
      } else if (scope === "project") {
        filePath = path.join(getProjectKnowledgeDir(org), `${target}.md`)
      } else {
        filePath = path.join(getKnowledgeDir(org), "index.md")
      }

      if (!map.has(key)) {
        map.set(key, { scope, target, filePath, experiences: [] })
      }
      map.get(key)!.experiences.push(exp)
    }

    return Array.from(map.values())
  }

  private buildMergePrompt(group: MergeGroup, currentContent: string): string {
    const changes = group.experiences.map((exp, i) => {
      const actionLabel = exp.action.toUpperCase()
      const replaces = exp.replaces_text
        ? `\n   Replaces: "${exp.replaces_text}"`
        : ""
      return `${i + 1}. [${actionLabel}] "${exp.text}"${replaces}`
    }).join("\n\n")

    return `You are a knowledge management agent. Merge the following experience changes into the existing knowledge document.

FILE: ${group.scope}/${group.target}.md
CURRENT CONTENT:
---
${currentContent || "(empty file)"}
---

CHANGES TO APPLY:
${changes}

OUTPUT: Return the complete updated file content. Preserve the document structure and formatting. Only apply the specified changes. For ADD operations, append new entries as bullet points. For UPDATE operations, find and replace the matching text. For DELETE operations, remove the matching entry entirely.`
  }

  private async callMergeAgent(prompt: string): Promise<string | null> {
    try {
      const provider = getProvider("claude")
      const chunks: string[] = []
      const stream = provider.sendQuery(prompt, process.cwd(), undefined, {
        systemPrompt: "You are a precise document merge agent. Return only the complete file content, no explanations.",
      })
      for await (const chunk of stream) {
        if (chunk.type === "text_delta") chunks.push(chunk.content)
      }
      const raw = chunks.join("").trim()
      // Strip markdown code fences if present
      return raw.replace(/^```(?:markdown|md)?\n?/, "").replace(/\n?```$/, "").trim() || null
    } catch {
      return null
    }
  }
}
```

- [ ] **步骤 2：archive-service.ts 替换 extractExperiences 为 merger**

在 `archive-service.ts` 的 P2.4 `archiveWorkspace` 方法中，替换 Step 4：

```typescript
// 删除旧的 Step 4 代码块（extractExperiences 调用）
// 替换为：

// Step 4: Merge experiences via Agent
let extractedExperiences = 0
if (options.extractExperiences.length > 0) {
  try {
    const { ExperienceMerger } = await import("./experience-merger")
    const merger = new ExperienceMerger()

    // Parse selected experiences from the options
    // options.extractExperiences is string[] of IDs — need to match with full objects
    // The full experience objects come from the draft/preview
    const experienceActions = (options as any).experienceActions as ExperienceAction[] | undefined
    if (experienceActions && experienceActions.length > 0) {
      const result = await merger.merge(org, experienceActions, emitter)
      extractedExperiences = result.added + result.updated + result.deleted
      await emitter.stepDone("extract_experiences", {
        added: result.added,
        updated: result.updated,
        deleted: result.deleted,
      })
    } else {
      await emitter.stepDone("extract_experiences", { count: 0 })
    }
  } catch (err) {
    await emitter.stepError("extract_experiences", err instanceof Error ? err.message : String(err))
    throw err
  }
} else {
  await emitter.stepDone("extract_experiences", { count: 0 })
}
```

同时在 options 类型中添加 `experienceActions`：

```typescript
options: {
  extractExperiences: string[]
  installSkills: string[]
  analysisReport?: unknown
  stats?: { /* ... */ }
  experienceActions?: Array<{  // ← 新增
    id: string
    text: string
    action: "add" | "update" | "delete"
    replaces_text?: string
    confidence: number
    category: string
    scope?: string
    target?: string
  }>
}
```

- [ ] **步骤 3：构建验证**

运行：`cd packages/server && npx tsup`
预期：构建成功

- [ ] **步骤 4：Commit**

```bash
git add packages/server/src/services/archive/experience-merger.ts \
       packages/server/src/services/archive/archive-service.ts
git commit -m "feat: ExperienceMerger — Agent-based knowledge merge

- Groups experiences by (scope, target) for batch merge
- Reads existing knowledge file, builds merge prompt, calls Claude
- Writes merged content back to knowledge file
- archive-service Step 4 uses merger instead of pending_review"
```

---

### 任务 12：经验前端分组展示

**文件：**
- 修改：`packages/web-app/components/workspaces/archive-preview-dialog.tsx`

- [ ] **步骤 1：经验 Tab 按 action 分组**

替换经验 Tab 内容（TabsContent value="experiences"）为分组显示：

```tsx
<TabsContent value="experiences">
  {preview.experiences.length === 0 ? (
    <div className="text-center py-8 text-muted-foreground">
      未检测到可提取的经验
    </div>
  ) : (
    <div className="space-y-4">
      {/* 全选/统计栏 */}
      <div className="flex items-center justify-between mb-4">
        <p className="text-sm text-muted-foreground">
          选择要合并到知识库的经验（已选 {selectedExperiences.length}）
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            setSelectedExperiences(
              selectedExperiences.length === preview.experiences.length
                ? []
                : preview.experiences.map((e) => e.id)
            )
          }
        >
          {selectedExperiences.length === preview.experiences.length ? "取消全选" : "全选"}
        </Button>
      </div>

      {/* 按 action 分组 */}
      {(["add", "update", "delete"] as const).map((action) => {
        const group = preview.experiences.filter((e) => (e.action ?? "add") === action)
        if (group.length === 0) return null

        const label = action === "add" ? "新增" : action === "update" ? "修改" : "删除"
        const icon = action === "add" ? "🟢" : action === "update" ? "🟡" : "🔴"

        return (
          <div key={action}>
            <h4 className="text-sm font-medium mb-2">
              {icon} {label} ({group.length})
            </h4>
            <div className="space-y-2">
              {group.map((exp) => (
                <Card key={exp.id}>
                  <CardContent className="pt-4">
                    <div className="flex items-start gap-3">
                      <Checkbox
                        checked={selectedExperiences.includes(exp.id)}
                        onCheckedChange={() => toggleExperience(exp.id)}
                      />
                      <div className="flex-1">
                        <p className="text-sm">{exp.text}</p>
                        {exp.replaces_text && (
                          <p className="text-xs text-muted-foreground mt-1 italic">
                            原文: &ldquo;{exp.replaces_text}&rdquo;
                          </p>
                        )}
                        <div className="flex items-center gap-2 mt-2">
                          <Badge variant="outline" className="text-xs">
                            {exp.scope ?? "org"}: {exp.target ?? "all"}
                          </Badge>
                          <Badge variant="secondary" className="text-xs">
                            置信度: {((exp.confidence ?? 0.5) * 100).toFixed(0)}%
                          </Badge>
                        </div>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )}
</TabsContent>
```

- [ ] **步骤 2：构建验证**

运行：`cd packages/web-app && npx next build`
预期：构建成功

- [ ] **步骤 3：Commit**

```bash
git add packages/web-app/components/workspaces/archive-preview-dialog.tsx
git commit -m "feat: experience tab groups by action (add/update/delete)

- 🟢 New, 🟡 Update, 🔴 Delete sections
- Shows replaces_text for update/delete entries
- Scope:target badge + confidence percentage"
```

---

### 任务 13：Skill 组列表 API

**文件：**
- 修改：`packages/server/src/routes/archive.ts`（或新建 resources 路由）

- [ ] **步骤 1：添加 skill-groups 路由**

在 `archive.ts` 的 `createArchiveRoutes` 中添加（或创建独立路由文件）：

```typescript
import os from "os"
import path from "path"
import fs from "fs"

// 在 createArchiveRoutes 函数内添加：
app.get("/skill-groups", (c) => {
  const org = c.req.query("org") || "default"
  const base = path.join(os.homedir(), ".octopus", "orgs", org, "resources", "installed", "skills")
  let groups: string[] = []
  try {
    if (fs.existsSync(base)) {
      groups = fs.readdirSync(base).filter((f) => {
        const stat = fs.statSync(path.join(base, f))
        return stat.isDirectory()
      })
    }
  } catch {
    // Directory doesn't exist yet
  }
  // Ensure default group always present
  if (!groups.includes("archive-extracted")) {
    groups.push("archive-extracted")
  }
  return c.json({ groups: groups.sort() })
})
```

- [ ] **步骤 2：构建验证**

运行：`cd packages/server && npx tsup`
预期：构建成功

- [ ] **步骤 3：Commit**

```bash
git add packages/server/src/routes/archive.ts
git commit -m "feat: add GET /skill-groups API for skill group listing

- Reads installed skill directories from org resources path
- Always includes 'archive-extracted' as default group
- Returns sorted group names"
```

---

### 任务 14：Skill 组选择器 + 安装集成

**文件：**
- 修改：`packages/web-app/lib/archive-api.ts`
- 修改：`packages/web-app/components/workspaces/archive-preview-dialog.tsx`
- 修改：`packages/server/src/services/archive/archive-service.ts`

- [ ] **步骤 1：客户端 API 更新**

在 `archive-api.ts` 中添加：

```typescript
// Skill 安装选项（带组）
export interface SkillInstallOption {
  name: string
  group: string
}

// 获取 skill 组列表
export async function getSkillGroups(org?: string): Promise<string[]> {
  const params = org ? `?org=${encodeURIComponent(org)}` : ""
  const res = await apiFetch(`${getServerUrl()}/api/archive/skill-groups${params}`, {
    credentials: "include",
  })
  if (!res.ok) return ["archive-extracted"]
  const data = await res.json()
  return data.groups || ["archive-extracted"]
}
```

- [ ] **步骤 2：Skills Tab 添加组选择器**

在 `archive-preview-dialog.tsx` 中：

```tsx
// 新增状态
const [skillGroups, setSkillGroups] = useState<Record<string, string>>({})
const [availableGroups, setAvailableGroups] = useState<string[]>(["archive-extracted"])

// 在 useEffect 中加载组列表
useEffect(() => {
  if (open && workspace) {
    getSkillGroups(workspace.org).then(setAvailableGroups)
  }
}, [open, workspace])

// 当 preview 加载后，为每个 skill 设置默认组
useEffect(() => {
  if (preview?.skills) {
    const defaults: Record<string, string> = {}
    for (const skill of preview.skills) {
      defaults[skill.name] = skillGroups[skill.name] ?? "archive-extracted"
    }
    setSkillGroups(defaults)
  }
}, [preview?.skills])

// 替换 Skills Tab 内容：
<TabsContent value="skills">
  {preview.skills.length === 0 ? (
    <div className="text-center py-8 text-muted-foreground">
      未检测到可提取的 Skill
    </div>
  ) : (
    <div className="space-y-2">
      <div className="flex items-center justify-between mb-4">
        <p className="text-sm text-muted-foreground">
          选择要安装到资源库的 Skill（已选 {selectedSkills.length}）
        </p>
        <Button variant="outline" size="sm" onClick={() =>
          setSelectedSkills(
            selectedSkills.length === preview.skills.length
              ? [] : preview.skills.map((s) => s.name)
          )
        }>
          {selectedSkills.length === preview.skills.length ? "取消全选" : "全选"}
        </Button>
      </div>
      {preview.skills.map((skill) => (
        <Card key={skill.name}>
          <CardContent className="pt-4">
            <div className="flex items-start gap-3">
              <Checkbox
                checked={selectedSkills.includes(skill.name)}
                onCheckedChange={() => toggleSkill(skill.name)}
              />
              <div className="flex-1">
                <div className="flex items-center gap-2 mb-1">
                  <Package className="h-4 w-4" />
                  <h4 className="font-semibold">{skill.name}</h4>
                </div>
                <p className="text-sm text-muted-foreground mb-2">
                  {skill.description}
                </p>
                <p className="text-xs text-muted-foreground mb-2">
                  <strong>提取原因:</strong> {skill.reason}
                </p>
                {/* ★ 组选择器 */}
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">安装到组:</span>
                  <Select
                    value={skillGroups[skill.name] ?? "archive-extracted"}
                    onValueChange={(v) => setSkillGroups(prev => ({ ...prev, [skill.name]: v }))}
                  >
                    <SelectTrigger className="h-7 w-[180px] text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {availableGroups.map((g) => (
                        <SelectItem key={g} value={g}>{g}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  )}
</TabsContent>
```

- [ ] **步骤 3：handleArchive 传递 skill groups**

修改 handleArchive/handleStartArchive 函数，将 skillGroups 传给 API：

```tsx
const handleStartArchive = () => {
  // 构建 SkillInstallOption[]
  const installSkills: SkillInstallOption[] = selectedSkills.map(name => ({
    name,
    group: skillGroups[name] ?? "archive-extracted",
  }))

  setArchiving(true)
  // Pass installSkills to ArchiveProgress via options
}
```

- [ ] **步骤 4：服务端 installSkills 使用 group**

在 `archive-service.ts` 中修改 `installSkills` 方法：

```typescript
private async installSkills(
  org: string,
  skills: Array<{ name: string; group: string }>,
  emitter: StepEmitter,
): Promise<number> {
  const { getResourceManager } = await import("../resource-manager")
  const resourceManager = getResourceManager(org)
  let installedCount = 0

  for (const skill of skills) {
    try {
      await emitter.stepProgress?.("install_skills", `安装 ${skill.name} → ${skill.group}`)
      await resourceManager.install({
        ref: `builtin:${skill.name}`,
        type: "skill",
        group: skill.group,
      })
      installedCount++
    } catch (err) {
      await emitter.log(`✗ Failed to install ${skill.name}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return installedCount
}
```

- [ ] **步骤 5：构建验证**

运行：`pnpm build`
预期：全部构建成功

- [ ] **步骤 6：Commit**

```bash
git add packages/web-app/lib/archive-api.ts \
       packages/web-app/components/workspaces/archive-preview-dialog.tsx \
       packages/server/src/services/archive/archive-service.ts
git commit -m "feat: skill group selector and grouped installation

- getSkillGroups API fetches available groups
- Skills tab shows per-skill group dropdown
- installSkills passes group to resourceManager.install()
- Default group: archive-extracted"
```

---

## 实现依赖图

```
Batch 1 (独立):
  Task 1 (弹窗尺寸) ─── 无依赖
  Task 2 (统计BUG) ─── 无依赖

Batch 2 (顺序):
  Task 3 (Draft表+DAO) → Task 4 (Draft路由) → Task 5 (Preview集成draft)
                                              → Task 6 (Draft前端)
  Task 7 (StepEmitter) → Task 8 (SSE路由+service) → Task 9 (Progress组件+SSE客户端)

Batch 3 (顺序):
  Task 10 (Prompt增强) → Task 11 (Merger) → Task 12 (前端分组)
  Task 13 (组列表API) → Task 14 (组选择器+安装)
```

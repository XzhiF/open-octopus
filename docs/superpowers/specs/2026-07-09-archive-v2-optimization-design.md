# Archive V2 优化设计规格

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 优化归档系统 — 弹窗尺寸、长任务进度反馈、Draft 副本机制、统计 BUG 修复、经验 Agent 直接执行、Skill 分组安装

**架构：** 6 个独立优化方向，可分阶段实现。核心变化：归档 API 改为 SSE 流式返回进度；新增 archive_drafts 表缓存分析结果；经验提取从 pending_review 审核改为 Agent 直接 merge knowledge 文档；Skill 安装支持用户选组。

**技术栈：** TypeScript, Hono SSE, SQLite, React, Agent (Claude SDK)

---

## 方向 1：弹窗尺寸

**现状：** `ArchivePreviewDialog` 使用 `max-w-4xl`（896px），无显式 max-h。

**目标：** `max-w-[960px]` + `max-h-[90vh]`，参考 scheduler-form 的 `max-w-[860px] max-h-[85vh]`。

### 变更

**文件：** `packages/web-app/components/workspaces/archive-preview-dialog.tsx`

```tsx
// 修改 DialogContent className
<DialogContent className="max-h-[90vh] w-full max-w-[960px] overflow-y-auto">
```

---

## 方向 2：长任务进度反馈 (SSE)

**现状：** 点击"确认归档"后 spinner + "归档中..." 文字，无细分进度。

**目标：** Steps 列表 + Terminal 日志双区布局，实时更新每步状态。

### 2.1 服务端 SSE 改造

**文件：** `packages/server/src/routes/archive.ts`

归档 API 改为 SSE 流：

```typescript
// POST /workspaces/:id/archive → text/event-stream
app.post("/workspaces/:id/archive", async (c) => {
  // ... validation ...

  return streamSSE(c, async (stream) => {
    const emitter = createStepEmitter(stream)
    await archiveService.archiveWorkspace(id, org, options, emitter)
  })
})
```

**StepEmitter 接口：**

```typescript
interface StepEmitter {
  stepStart(step: string, detail: string): Promise<void>
  stepProgress(step: string, detail: string): Promise<void>
  stepDone(step: string, data?: Record<string, unknown>): Promise<void>
  stepError(step: string, message: string): Promise<void>
  log(message: string): Promise<void>
  complete(data: ArchiveResult): Promise<void>
}
```

**归档步骤定义（8步）：**

| step key | 显示名 | 说明 |
|----------|--------|------|
| `archive_executions` | 归档执行记录 | 逐条写入 execution_archive |
| `create_record` | 创建归档记录 | 写入 workspace_archive |
| `extract_experiences` | 提取经验 | Agent merge knowledge 文档 |
| `install_skills` | 安装 Skill | ResourceManager.install |
| `delete_files` | 清理文件 | fs.rm workspace 目录 |
| `update_stats` | 更新统计 | 写入 extraction stats |
| `soft_archive` | 软归档 | SET status='archived' |
| `cleanup_draft` | 清理草稿 | 删除 archive_drafts 记录 |

**SSE 事件格式：**

```
event: step
data: {"step":"archive_executions","status":"running","detail":"归档 12 条执行记录..."}

event: step
data: {"step":"archive_executions","status":"progress","detail":"6/12"}

event: log
data: {"message":"Archived execution abc-123"}

event: step
data: {"step":"archive_executions","status":"done","data":{"count":12}}

event: complete
data: {"success":true,"archivedExecutions":12,"extractedExperiences":5,"installedSkills":2}
```

### 2.2 前端进度组件

**文件：** `packages/web-app/components/workspaces/archive-progress.tsx`（新建）

```tsx
interface ArchiveStep {
  key: string
  label: string
  status: 'pending' | 'running' | 'done' | 'error'
  detail?: string
}

interface ArchiveProgressProps {
  steps: ArchiveStep[]
  logs: string[]
  onComplete?: (result: ArchiveResult) => void
}
```

布局：左侧 Steps 列表（图标 + 名称 + 状态），右侧 Terminal 日志区（滚动显示）。

**文件：** `packages/web-app/components/workspaces/archive-preview-dialog.tsx`

"归档操作" Tab 内容替换为 `ArchiveProgress` 组件。确认归档按钮点击后：
1. 切换 Tab 到"归档操作"
2. 建立 SSE 连接
3. 实时更新 Steps + Logs
4. complete 事件后显示成功状态

### 2.3 客户端 SSE 消费

**文件：** `packages/web-app/lib/archive-api.ts`

```typescript
export function archiveWorkspaceSSE(
  workspaceId: string,
  options: ArchiveOptions,
  onStep: (step: StepEvent) => void,
  onLog: (message: string) => void,
  onComplete: (result: ArchiveResult) => void,
  onError: (error: Error) => void,
): AbortController
```

使用 `fetch` + `ReadableStream` 消费 SSE，返回 `AbortController` 以支持取消。

---

## 方向 3：Draft 副本机制

**现状：** 分析结果仅在内存，关闭弹窗即丢失。

**目标：** 分析完成自动存 DB，下次打开同一 workspace 加载副本。

### 3.1 DB 表

**文件：** `packages/server/src/db/schema.ts`

```sql
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

### 3.2 DAO

**文件：** `packages/server/src/db/dao/archive-draft-dao.ts`（新建）

```typescript
interface ArchiveDraftRow {
  workspace_id: string
  org: string
  analysis_report: string  // JSON
  experiences: string      // JSON
  skills: string           // JSON
  stats: string            // JSON
  created_at: string
  updated_at: string
}

class ArchiveDraftDAO {
  findByWorkspaceId(workspaceId: string): ArchiveDraftRow | undefined
  upsert(row: ArchiveDraftRow): void
  delete(workspaceId: string): void
}
```

### 3.3 服务端 API

**新增路由：**

| 路由 | 方法 | 说明 |
|------|------|------|
| `/workspaces/:id/archive-draft` | GET | 获取 draft（200 有 / 404 无） |
| `/workspaces/:id/archive-draft` | DELETE | 删除 draft |

**preview API 改造：** 分析完成后自动调用 `archiveDraftDAO.upsert()` 保存结果。

### 3.4 前端流程

**文件：** `packages/web-app/components/workspaces/archive-preview-dialog.tsx`

```
打开弹窗
  │
  ├─ GET /archive-draft → 200 → 加载 draft 数据
  │   → 显示 "已加载上次分析结果 (2小时前)"
  │   → 按钮: [重新分析] [确认归档]
  │
  └─ GET /archive-draft → 404 → 正常调 preview API
      → 分析完成后自动存 draft
      → 按钮: [确认归档]

点击 [重新分析]
  → DELETE /archive-draft
  → 重新调 preview API
  → 分析完成后覆盖 draft

确认归档完成
  → 自动 DELETE /archive-draft
```

---

## 方向 4：统计数据 BUG 修复

**现状：**
- P2.4 `archiveWorkspace` 用 N+1 查询（逐个 `findByExecutionId`）算 total_cost/total_duration_ms
- preview 阶段 `computeStats(ctx)` 从 executions 表实时算
- 两条路径数据可能不一致

**目标：** 统一用 `computeStats(ctx)` 计算，归档时直接写入。

### 4.1 提取 computeStats 为共享函数

**文件：** `packages/server/src/services/archive/analysis-assembler.ts`

```typescript
// 已有 computeStats，确保导出
export function computeStats(ctx: ArchiveContext): ArchiveStats {
  // ... 现有逻辑 ...
}
```

### 4.2 archiveWorkspace 使用 stats

**文件：** `packages/server/src/services/archive/archive-service.ts`

P2.4 `archiveWorkspace` 方法修改：

```typescript
// 删除 N+1 循环 (L297-305)
// 改为接收 stats 参数或从 preview 传入

async archiveWorkspace(
  workspaceId: string,
  org: string,
  options: {
    extractExperiences: string[]
    installSkills: SkillInstallOption[]
    analysisReport?: unknown
    stats?: ArchiveStats  // ← 新增：从 preview 传入
  }
): Promise<ArchiveResult>
```

如果 `options.stats` 存在则直接使用，否则从 ctx 重新计算。

### 4.3 success_rate 修复

**根因分析：** preview 的 `computeStats` 从 `ctx.executions` 算 success_rate（completed / total），但 `ctx.executions` 是采样后的（最多 50 条），不是全量。

**修复：** `computeStats` 的 success_rate 应基于全量 execution 计数，而非采样。在 `buildArchiveContext` 中增加 `totalExecutionCount` 和 `totalSuccessCount` 字段（从 DB COUNT 查询）。

---

## 方向 5：经验 Agent 直接执行

**现状：** 经验提取后写入 `pending_review` 表待人工审核。

**目标：** Agent 直接 merge 到 knowledge markdown 文件，不走审核队列。

### 5.1 Prompt 增强

**文件：** `packages/server/src/services/archive/prompts.ts`

`buildExperiencePrompt` 输出格式增加字段：

```json
[
  {
    "text": "部署前必须验证配置文件格式",
    "action": "add",
    "scope": "workflow",
    "target": "deploy-flow",
    "replaces_text": null,
    "confidence": 0.85,
    "evidence": "3次部署失败均因配置错误",
    "category": "error-prevention"
  },
  {
    "text": "数据库迁移前必须先备份生产数据",
    "action": "update",
    "scope": "workflow",
    "target": "db-migrate",
    "replaces_text": "迁移前检查schema兼容性",
    "confidence": 0.9,
    "evidence": "2次迁移失败因缺少备份",
    "category": "error-prevention"
  },
  {
    "text": "手动清理临时文件",
    "action": "delete",
    "scope": "project",
    "target": "my-project",
    "replaces_text": "每次构建后手动清理 /tmp 下的临时文件",
    "confidence": 0.7,
    "evidence": "工作流已包含自动清理步骤",
    "category": "efficiency"
  }
]
```

**Prompt 新增指令：**
- 加载已有 knowledge 文件内容作为上下文
- 每条经验输出 `action`：`add`（新增）/ `update`（修改已有条目）/ `delete`（删除已过时条目）
- `update`/`delete` 时提供 `replaces_text`（被替换/删除的原文，用于 Agent 定位）
- `scope` 映射：`workflow` → `workflows/{target}.md`，`project` → `projects/{target}.md`，`org` → `index.md`

### 5.2 前端分类展示

**文件：** `packages/web-app/components/workspaces/archive-preview-dialog.tsx`

经验 Tab 按 action 分组显示：

```
经验 (5)
├─ 🟢 新增 (3)
│   ☑ 部署前必须验证配置文件 [workflow: deploy-flow] 85%
│   ☑ API 测试需覆盖 401 场景 [workflow: api-test] 80%
│   ☑ 大文件处理使用流式读取 [project: my-project] 75%
├─ 🟡 修改 (1)
│   ☑ 数据库迁移前先备份生产数据 [workflow: db-migrate] 90%
│     └─ 原文: "迁移前检查schema兼容性"
└─ 🔴 删除 (1)
    ☐ 手动清理临时文件 [project: my-project] 70%
      └─ 原文: "每次构建后手动清理 /tmp 下的临时文件"
```

### 5.3 Agent Merge 执行

**文件：** `packages/server/src/services/archive/experience-merger.ts`（新建）

```typescript
interface MergeGroup {
  scope: string       // "workflow" | "project" | "org"
  target: string      // workflow name / project name / "org"
  filePath: string    // resolved knowledge file path
  experiences: ExperienceAction[]
}

interface ExperienceAction {
  id: string
  text: string
  action: 'add' | 'update' | 'delete'
  replaces_text?: string
  confidence: number
  category: string
}

class ExperienceMerger {
  async merge(
    org: string,
    selectedExperiences: ExperienceAction[],
    emitter: StepEmitter,
  ): Promise<{ added: number; updated: number; deleted: number }>
}
```

**执行流程：**

```
1. 按 (scope, target) 分组 experiences
2. 对每个分组：
   a. 读取目标 knowledge 文件（不存在则创建空文件）
   b. 构建 merge prompt：
      - 当前文件内容
      - 该文件的所有操作列表（add/update/delete）
      - 指令：智能合并，保持文档结构
   c. 调用 LLM agent (Claude) 执行 merge
   d. 将 agent 输出写回文件
   e. emitter.log() 报告结果
3. 调用 rebuild-index 更新索引
```

**Merge Prompt 模板：**

```
You are a knowledge management agent. Merge the following experience
changes into the existing knowledge document.

FILE: workflows/deploy-flow.md
CURRENT CONTENT:
---
# deploy-flow 经验

- 部署前检查环境变量配置
- 迁移前检查schema兼容性
---

CHANGES TO APPLY:
1. [UPDATE] "数据库迁移前先备份生产数据"
   Replaces: "迁移前检查schema兼容性"

2. [ADD] "部署失败后检查日志中的端口冲突"

OUTPUT: Return the complete updated file content. Preserve the document
structure and formatting. Only apply the specified changes.
```

### 5.4 归档服务集成

**文件：** `packages/server/src/services/archive/archive-service.ts`

Step 4 替换：

```typescript
// 旧: this.extractExperiences(workspaceId, org, selectedIds)
// 新:
const merger = new ExperienceMerger()
const mergeResult = await merger.merge(org, selectedExperiences, emitter)
```

---

## 方向 6：Skill 分组安装

**现状：** `installSkills()` 调用 `resourceManager.install({ type: "skill", name, source: "builtin" })`，无 group 参数。

**目标：** 用户在弹窗内为每个 Skill 选择安装组。

### 6.1 前端改造

**文件：** `packages/web-app/components/workspaces/archive-preview-dialog.tsx`

Skills Tab 每个 Skill 卡片增加组选择器：

```tsx
<SkillCard skill={skill}>
  <GroupSelector
    value={skillGroups[skill.name]}
    onChange={(group) => setSkillGroups(prev => ({ ...prev, [skill.name]: group }))}
    groups={availableGroups}
    onCreateGroup={handleCreateGroup}
  />
</SkillCard>
```

**获取现有组列表：** 新增 API `GET /api/resources/skill-groups` 返回已安装的 skill 组。

### 6.2 API 变更

**文件：** `packages/web-app/lib/archive-api.ts`

```typescript
export interface SkillInstallOption {
  name: string
  group: string  // 用户选择的组
}

export interface ArchiveOptions {
  extractExperiences?: ExperienceAction[]  // 带 action 字段
  installSkills?: SkillInstallOption[]     // 带 group 字段
}
```

### 6.3 服务端安装

**文件：** `packages/server/src/services/archive/archive-service.ts`

```typescript
private async installSkills(
  org: string,
  skills: SkillInstallOption[],
  emitter: StepEmitter,
): Promise<number> {
  const resourceManager = getResourceManager(org)
  let installed = 0

  for (const skill of skills) {
    await emitter.stepProgress('install_skills', `安装 ${skill.name} → ${skill.group}`)
    await resourceManager.install({
      ref: `builtin:${skill.name}`,
      type: 'skill',
      group: skill.group,
    })
    installed++
  }

  return installed
}
```

### 6.4 组列表 API

**文件：** `packages/server/src/routes/resources.ts`（新增或在现有路由扩展）

```typescript
// GET /api/resources/skill-groups?org=xzf
app.get("/skill-groups", (c) => {
  const org = c.req.query("org")
  const base = path.join(os.homedir(), ".octopus", "orgs", org, "resources", "installed", "skills")
  const groups = fs.existsSync(base) ? fs.readdirSync(base) : []
  return c.json({ groups: [...groups, "archive-extracted"] })
})
```

---

## 实现优先级

| 优先级 | 方向 | 复杂度 | 依赖 |
|--------|------|--------|------|
| P0 | 4. 统计 BUG | 低 | 无 |
| P0 | 1. 弹窗尺寸 | 低 | 无 |
| P1 | 3. Draft 机制 | 中 | 无 |
| P1 | 2. SSE 进度 | 高 | 方向 5、6 的 emitter 接口 |
| P2 | 5. 经验 Agent | 高 | 方向 2（SSE） |
| P2 | 6. Skill 分组 | 中 | 方向 2（SSE） |

建议分 3 批实现：
1. **Batch 1** (P0): 弹窗尺寸 + 统计 BUG — 快速修复
2. **Batch 2** (P1): Draft + SSE 进度 — 核心架构改造
3. **Batch 3** (P2): 经验 Agent + Skill 分组 — 知识联动

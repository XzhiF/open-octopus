# 01 — Experience Schema Evolution

Type: research
Status: resolved
Blocked by: None

## Question

如何演进 `experiences` 表 schema 以支持多消费者（agent/workflow/harness/global scope）？

需要考虑：
- 当前 schema: `id, skill_name, content, source_session_id, org, created_at`
- 需要增加 scope 维度
- FTS5 索引需要对应更新
- 与 `harness_events` 的关系（harness_events 存储原始事件，experiences 存储提炼后的经验）
- 是否需要 outcome/effectiveness 字段
- 迁移策略（已有数据如何处理）

## Answer

### 1. 现状分析

#### 当前 `experiences` 表 (table #25)

```sql
CREATE TABLE IF NOT EXISTS experiences (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  skill_name TEXT NOT NULL,
  content TEXT NOT NULL,
  source_session_id TEXT,
  org TEXT NOT NULL,
  created_at TEXT NOT NULL
);
```

**索引**: `idx_experiences_skill(skill_name)`, `idx_experiences_org(org)`

#### 当前 `experiences_fts` FTS5

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS experiences_fts USING fts5(
  skill_name,
  content
);
```

**FTS 同步**: 在 `insertExperience()` / `insertExperienceWithFts()` 中以 non-fatal try/catch 手动写入。
没有触发器自动同步（区别于 `session_memory_fts` 有 `messages_after_insert` 触发器）。

#### 当前 DAO 方法 (EvolutionDAO)

| 方法 | 类型 | 用途 |
|------|------|------|
| `listExperiences(org, skillName?)` | 读 | 按 org 列出，可选 skill 过滤 |
| `findRecentExperiences(org, daysAgo, limit)` | 读 | 按时间窗口查最近经验 |
| `findExperiencesWithFailurePattern(org)` | 读 | LIKE 搜 '%失败%'/'%error%' 等关键词 |
| `searchExperiences(query, limit)` | 读 | FTS5 MATCH 全文搜索，fallback LIKE |
| `insertExperience(row)` | 写 | 插入 + FTS 同步 |
| `insertExperienceWithFts(row)` | 写 | 同上（重复方法，migration 遗留） |
| `findRecentExperiencesForReflection(org, limit)` | 读 | 7天内最近经验，用于 reflect() |

#### 当前写入路径

1. **EvolutionService.recordExperience()** → `dao.insertExperienceWithFts()` — 主写入路径
2. **SubsystemAdapter.writeExperience()** — 文件系统并行存储（`~/.octopus/orgs/{org}/experiences/*.md`）
3. **EvolutionService.processUnprocessedMarks()** — 批量处理 insight_marks 时写入

#### 当前读取路径

1. **EvolutionService.reflect()** — 用 `findExperiencesWithFailurePattern()` 和 `findRecentExperiencesForReflection()`
2. **SubsystemAdapter.searchExperiences()** — 文件系统全文搜索
3. **EvolutionService.listExperiences()** — 直通 DAO

#### `harness_events` 表 (table #31)

```sql
CREATE TABLE IF NOT EXISTS harness_events (
  id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL,
  node_id TEXT,
  timestamp INTEGER NOT NULL,
  event_type TEXT NOT NULL,     -- detector_diagnosis | strategy_intervention | agent_delegation | blocked
  detector TEXT,
  severity TEXT,
  report_json TEXT,
  action_json TEXT,
  result_json TEXT,
  token_usage_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### 2. 提出的 Schema 演进

#### 2.1 ALTER TABLE 语句

```sql
-- Migration: experiences_v2 — multi-scope support
-- Schema version bump: 34 → 35

-- 1. 添加 scope 列（四值枚举：agent / workflow / harness / global）
ALTER TABLE experiences ADD COLUMN scope TEXT NOT NULL DEFAULT 'agent';

-- 2. 添加 scope_ref — 作用域内的引用标识
--    agent scope  → skill_name（冗余但便于查询）
--    workflow scope → workflow_ref
--    harness scope → detector name
--    global scope → NULL 或 topic tag
ALTER TABLE experiences ADD COLUMN scope_ref TEXT DEFAULT NULL;

-- 3. 添加 pattern_tags — 跨切分分类（JSON array）
--    例如: ["timeout", "retry", "token-limit", "error-handling"]
ALTER TABLE experiences ADD COLUMN pattern_tags TEXT DEFAULT '[]';

-- 4. 添加 outcome — 效果评估（JSON object）
--    例如: {"label": "helpful", "success_rate": 0.85, "usage_count": 12, "last_applied": "..."}
ALTER TABLE experiences ADD COLUMN outcome TEXT DEFAULT NULL;

-- 5. 添加 source_type — 区分经验来源
--    'session' | 'harness' | 'workflow' | 'manual' | 'reflection'
ALTER TABLE experiences ADD COLUMN source_type TEXT NOT NULL DEFAULT 'session';

-- 6. 添加 execution_id — 关联到触发该经验的执行（可选）
ALTER TABLE experiences ADD COLUMN execution_id TEXT DEFAULT NULL;
```

#### 2.2 更新后的 `experiences` 表结构

```
experiences (v2)
├── id                    INTEGER PK AUTOINCREMENT
├── skill_name            TEXT NOT NULL          -- 保留（向后兼容）
├── content               TEXT NOT NULL
├── source_session_id     TEXT
├── org                   TEXT NOT NULL
├── created_at            TEXT NOT NULL
├── scope                 TEXT NOT NULL DEFAULT 'agent'     -- NEW
├── scope_ref             TEXT DEFAULT NULL                 -- NEW
├── pattern_tags          TEXT DEFAULT '[]'                 -- NEW (JSON)
├── outcome               TEXT DEFAULT NULL                 -- NEW (JSON)
├── source_type           TEXT NOT NULL DEFAULT 'session'   -- NEW
└── execution_id          TEXT DEFAULT NULL                 -- NEW
```

#### 2.3 更新后的 FTS5 定义

FTS5 virtual table 不支持 `ALTER TABLE`。需要 drop-recreate-rebuild：

```sql
-- Step 1: Drop old FTS table
DROP TABLE IF EXISTS experiences_fts;

-- Step 2: Recreate with additional searchable columns
CREATE VIRTUAL TABLE IF NOT EXISTS experiences_fts USING fts5(
  skill_name,
  content,
  scope,
  scope_ref,
  pattern_tags,
  content='experiences',
  content_rowid='id'
);

-- Step 3: Backfill from main table
INSERT INTO experiences_fts (rowid, skill_name, content, scope, scope_ref, pattern_tags)
  SELECT id, skill_name, content, scope, scope_ref, pattern_tags FROM experiences;
```

**注意**: 使用 `content='experiences'` 和 `content_rowid='id'` 启用 content-sync 模式，
这样 FTS 表成为主表的"索引视图"而非独立存储，减少数据不一致风险。

#### 2.4 新增索引

```sql
-- 跨 scope 查询（最常见的过滤维度）
CREATE INDEX IF NOT EXISTS idx_experiences_scope ON experiences(scope);

-- scope + scope_ref 组合索引（精确查找特定 agent/workflow/detector 的经验）
CREATE INDEX IF NOT EXISTS idx_experiences_scope_ref ON experiences(scope, scope_ref);

-- source_type 索引（区分 harness 自动经验 vs 人工经验）
CREATE INDEX IF NOT EXISTS idx_experiences_source_type ON experiences(source_type);

-- execution_id 索引（追溯经验到具体执行，partial index 排除 NULL）
CREATE INDEX IF NOT EXISTS idx_experiences_execution ON experiences(execution_id)
  WHERE execution_id IS NOT NULL;

-- 复合索引：org + scope + created_at（按 org 和 scope 列最近经验）
CREATE INDEX IF NOT EXISTS idx_experiences_org_scope_time
  ON experiences(org, scope, created_at DESC);

-- 表达式索引：pattern_tags JSON 首元素（SQLite 3.38+）
CREATE INDEX IF NOT EXISTS idx_experiences_pattern_first
  ON experiences(json_extract(pattern_tags, '$[0]'))
  WHERE pattern_tags != '[]';
```

### 3. 新增 DAO 方法

```typescript
// ── 新增 ExperienceRowV2 类型 ──────────────────────────────────

export interface ExperienceRowV2 {
  id: number
  skill_name: string
  content: string
  source_session_id: string | null
  org: string
  created_at: string
  scope: 'agent' | 'workflow' | 'harness' | 'global'
  scope_ref: string | null
  pattern_tags: string   // JSON array
  outcome: string | null // JSON object
  source_type: 'session' | 'harness' | 'workflow' | 'manual' | 'reflection'
  execution_id: string | null
}

// ── 新增 DAO 方法 ───────────────────────────────────────────

interface EvolutionDAOV2Extensions {
  // --- 现存的（保持向后兼容）---
  listExperiences(org, skillName?): ExperienceRow[]
  findRecentExperiences(org, daysAgo, limit): ExperienceRow[]
  searchExperiences(query, limit): Array<{skill_name, content}>
  insertExperience(row): RunResult
  insertExperienceWithFts(row): RunResult

  // --- 新增：scope-aware 查询 ---

  /** 按 scope 列出经验 */
  listByScope(
    org: string,
    scope: 'agent' | 'workflow' | 'harness' | 'global',
    options?: { scope_ref?: string; limit?: number }
  ): ExperienceRowV2[]

  /** 跨 scope 搜索（FTS5 + scope 过滤） */
  searchByScope(
    query: string,
    scope?: string,
    limit?: number
  ): ExperienceRowV2[]

  /** 按 pattern_tags 查找（至少匹配一个 tag） */
  findByPatternTag(
    org: string,
    tag: string,
    scope?: string,
    limit?: number
  ): ExperienceRowV2[]

  /** 插入 v2 经验（带所有新字段 + FTS 同步） */
  insertExperienceV2(row: Omit<ExperienceRowV2, 'id'>): RunResult

  /** 更新 outcome（经验被应用后回写效果） */
  updateOutcome(
    id: number,
    outcome: { label: string; success_rate?: number; usage_count?: number }
  ): RunResult

  /** 获取 harness 经验统计（聚合 dashboard 用） */
  getHarnessStats(
    org: string,
    daysAgo?: number
  ): { total: number; by_detector: Record<string, number>; avg_success_rate: number }

  /** 查找与特定执行相关的所有经验（跨 scope） */
  findByExecution(executionId: string): ExperienceRowV2[]

  /** 批量插入 harness 经验 */
  bulkInsertHarnessExperiences(
    rows: Array<Omit<ExperienceRowV2, 'id' | 'scope'>>
  ): RunResult[]
}
```

### 4. 迁移 SQL（完整迁移脚本）

```sql
-- =============================================================================
-- Migration: experiences_v2
-- Schema version: 34 → 35
-- Description: Multi-scope experience support for harness learning platform
-- =============================================================================

-- Phase 1: Schema extension (backward compatible)
-- ──────────────────────────────────────────────────

ALTER TABLE experiences ADD COLUMN scope TEXT NOT NULL DEFAULT 'agent';
ALTER TABLE experiences ADD COLUMN scope_ref TEXT DEFAULT NULL;
ALTER TABLE experiences ADD COLUMN pattern_tags TEXT DEFAULT '[]';
ALTER TABLE experiences ADD COLUMN outcome TEXT DEFAULT NULL;
ALTER TABLE experiences ADD COLUMN source_type TEXT NOT NULL DEFAULT 'session';
ALTER TABLE experiences ADD COLUMN execution_id TEXT DEFAULT NULL;

-- Phase 2: Backfill scope_ref for existing data
-- agent scope → scope_ref = skill_name
UPDATE experiences SET scope_ref = skill_name WHERE scope = 'agent';

-- Phase 3: Rebuild FTS5 with new columns
-- ──────────────────────────────────────────────────

DROP TABLE IF EXISTS experiences_fts;

CREATE VIRTUAL TABLE IF NOT EXISTS experiences_fts USING fts5(
  skill_name,
  content,
  scope,
  scope_ref,
  pattern_tags,
  content='experiences',
  content_rowid='id'
);

INSERT INTO experiences_fts (rowid, skill_name, content, scope, scope_ref, pattern_tags)
  SELECT id, skill_name, content, scope, scope_ref, pattern_tags FROM experiences;

-- Phase 4: New indexes
-- ──────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_experiences_scope ON experiences(scope);
CREATE INDEX IF NOT EXISTS idx_experiences_scope_ref ON experiences(scope, scope_ref);
CREATE INDEX IF NOT EXISTS idx_experiences_source_type ON experiences(source_type);
CREATE INDEX IF NOT EXISTS idx_experiences_execution ON experiences(execution_id)
  WHERE execution_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_experiences_org_scope_time
  ON experiences(org, scope, created_at DESC);

-- Phase 5: Update scheduler_state schema version
UPDATE scheduler_state SET schema_version = 35 WHERE id = 1;
```

### 5. `harness_events` ↔ `experiences` 数据流设计

#### 5.1 设计决策：双写 + 可选 ETL

**结论**: Harness 应写入 BOTH tables，但不是简单的重复写入——
它们存储不同抽象层级的数据，各有不可替代的价值。

```
                    ┌─────────────────────────────────────────┐
                    │         Workflow Execution               │
                    │   (Agent nodes + Harness monitors)       │
                    └──────────┬──────────────────┬────────────┘
                               │                  │
                    ┌──────────▼──────────┐ ┌─────▼──────────────────┐
                    │   harness_events    │ │    agent_events         │
                    │   (raw events)      │ │    (turn-level trace)   │
                    │                     │ │                          │
                    │ • detector_diagnosis│ │ • tool calls             │
                    │ • strategy_interven │ │ • LLM responses          │
                    │ • agent_delegation  │ │ • error messages         │
                    │ • blocked           │ │                          │
                    └──────────┬──────────┘ └─────────────────────────┘
                               │
                    ┌──────────▼──────────────────────────────┐
                    │   HarnessExperienceExtractor             │
                    │   (called at session end / periodic)     │
                    │                                          │
                    │ 1. Group events by detector + pattern    │
                    │ 2. Evaluate outcome (resolved/blocked)   │
                    │ 3. Extract reusable lesson               │
                    │ 4. Tag with pattern_tags                 │
                    └──────────┬──────────────────────────────┘
                               │
                    ┌──────────▼──────────────────────────────┐
                    │   experiences (scope='harness')          │
                    │                                          │
                    │ • scope: 'harness'                       │
                    │ • scope_ref: detector name               │
                    │ • pattern_tags: ["timeout","retry",...]  │
                    │ • outcome: {label, success_rate, ...}    │
                    │ • source_type: 'harness'                 │
                    │ • execution_id: source execution         │
                    └──────────┬──────────────────────────────┘
                               │
                    ┌──────────▼──────────────────────────────┐
                    │   EvolutionService.reflect()             │
                    │                                          │
                    │ • Consumes harness + agent experiences   │
                    │ • Identifies cross-scope patterns        │
                    │ • Proposes skill improvements            │
                    │ • Records to evolution_log               │
                    └─────────────────────────────────────────┘
```

#### 5.2 各表职责划分

| 维度 | `harness_events` | `experiences` (scope=harness) |
|------|-------------------|-------------------------------|
| 抽象层级 | 原始事件流 | 提炼后的经验教训 |
| 粒度 | 每个干预动作一行 | 每个可复用模式一行 |
| 生命周期 | 短期（90天归档） | 长期保留 |
| 查询模式 | 按 execution_id 追溯 | 按 scope/pattern_tag 搜索 |
| 消费者 | 调试、审计、统计 | Agent 决策、workflow 优化 |
| 写入时机 | 执行中实时写入 | 执行后提炼写入 |
| 数据量 | 高（每次干预） | 低（仅可复用模式） |

#### 5.3 数据生命周期

```
harness_events:
  创建 → 实时写入 → 30天活跃查询 → 90天归档 → 180天删除

experiences (scope=harness):
  创建 → 提炼写入 → 长期保留 → 定期评估 outcome → 低价值经验降级

experiences (scope=agent):
  创建 → session/reflection → 长期保留 → skill evolution 后归档

experiences (scope=workflow):
  创建 → workflow 完成后提炼 → 长期保留 → pattern 积累后 consolidation

experiences (scope=global):
  创建 → 跨 scope 模式识别 → 永久保留 → 手动管理
```

### 6. 向后兼容性

#### 6.1 现有代码无需修改

所有新增列都有 DEFAULT 值，因此：
- `INSERT INTO experiences (skill_name, content, source_session_id, org, created_at) VALUES (...)` 仍然有效
- 新列自动填充：`scope='agent'`, `scope_ref=NULL`, `pattern_tags='[]'`, `source_type='session'`
- `ExperienceRow` TypeScript 类型保持兼容（新字段可选）

#### 6.2 渐进式迁移路径

```
Phase 1 (本 ticket): Schema migration + DAO v2 methods
Phase 2: HarnessExperienceExtractor 使用 insertExperienceV2()
Phase 3: EvolutionService.reflect() 升级为 scope-aware
Phase 4: 文件系统 store (SubsystemAdapter) 统一迁移到 DB
Phase 5: Web UI 展示跨 scope 经验 dashboard
```

### 7. 对 SubsystemAdapter 文件系统存储的建议

当前 `SubsystemAdapter.writeExperience()` 在 `~/.octopus/orgs/{org}/experiences/` 写 `.md` 文件。
建议 Phase 4 统一到 DB，理由：
- FTS5 全文搜索比文件系统 `grep` 快 100x+
- scope/pattern_tags/outcome 等元数据无法在 `.md` 文件中结构化查询
- 避免双写导致的不一致

过渡期：保留 `SubsystemAdapter.writeExperience()` 作为 offline fallback，
但主路径改为 `EvolutionService.recordExperience()` → DB。

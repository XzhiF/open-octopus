# Harness Learning Platform — 统一学习平台层架构归档

> **日期**: 2026-08-11
> **分支**: feat/harness-learning-platform + feat/experience-injection
> **PR**: [#46](https://github.com/XzhiF/open-octopus/pull/46) (平台层) + [#47](https://github.com/XzhiF/open-octopus/pull/47) (经验注入)
> **变更**: +6,402 / -134 lines (PR #46) + ~2,400 lines (PR #47)
> **测试**: 122 tests (PR #46) + 150 tests (PR #47) = 272 total

## 1. 系统架构图

```
┌─────────────────────── 统一学习平台层 ───────────────────────┐
│                                                               │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │  Experience Store (experiences 表 + FTS5)               │ │
│  │                                                         │ │
│  │  scope: agent │ workflow │ harness │ global             │ │
│  │  scope_ref: 检测器名 │ 技能名 │ 工作流名               │ │
│  │  pattern_tags: ["fix_and_retry", "syntax_error", ...]  │ │
│  │  outcome: {"label":"success","success_rate":0.87,...}   │ │
│  │  source_type: session │ harness │ reflection │ manual   │ │
│  │  execution_id + node_id (可追溯到具体执行)              │ │
│  └─────────────────────┬───────────────────────────────────┘ │
│                        │                                      │
│  ┌─────────────────────▼───────────────────────────────────┐ │
│  │  Unified Prompt Assembler (Adapter Pattern)             │ │
│  │                                                         │ │
│  │  assembleForAgent(cloneName?, opts) → 统一入口          │ │
│  │    ├── ChatPromptAdapter (主 Agent, SystemPromptAsm.)   │ │
│  │    ├── ClonePromptAdapter (Clone 聊天, CloneRuntime)    │ │
│  │    └── HarnessPromptAdapter (干预 + 历史注入)           │ │
│  │          ├── persona.md (harness-agent 人格)            │ │
│  │          ├── clone long-term memory                     │ │
│  │          ├── FTS5 检索相似历史案例 (top 5)              │ │
│  │          ├── 成功率统计注入 (≥5 数据点)                 │ │
│  │          └── 当前诊断报告 + 执行上下文                  │ │
│  └─────────────────────┬───────────────────────────────────┘ │
│                        │                                      │
│  ┌─────────────────────▼───────────────────────────────────┐ │
│  │  Evolution Engine (reflect + scope)                     │ │
│  │                                                         │ │
│  │  reflect({scope: 'harness'})                            │ │
│  │    ├── 分析 decision × pattern 成功率                   │ │
│  │    ├── 识别低成功率模式                                 │ │
│  │    ├── 生成可操作建议                                   │ │
│  │    └── 写入 reflection experiences (可被 FTS5 检索)     │ │
│  └─────────────────────────────────────────────────────────┘ │
│                                                               │
└──────────────────────────┬────────────────────────────────────┘
                           │
            ┌──────────────┼──────────────┐
            │              │              │
     干预开始          干预结束        定期反思
     ──────────       ──────────      ──────────
     FTS5 检索        记录经验        分析成功率
     历史案例         追踪效果        写反思经验
     注入 prompt      更新 outcome    可被下次检索
```

## 2. 核心设计决策

### D1: Experience Schema 演进策略

**决策**: 在现有 `experiences` 表上加 7 列（全部带 DEFAULT 值），而非创建新表。

**理由**:
- 向后兼容：现有 `insertExperience()` 调用无需修改
- FTS5 已存在：只需重建索引，不需新建搜索引擎
- 零数据迁移：DEFAULT 值确保旧数据自动适配

**7 个新列**:

| 列名 | 类型 | DEFAULT | 用途 |
|------|------|---------|------|
| `scope` | TEXT | `'agent'` | 四值隔离：agent / workflow / harness / global |
| `scope_ref` | TEXT | NULL | 作用域内引用（检测器名 / 技能名） |
| `pattern_tags` | TEXT | `'[]'` | JSON 标签数组，支持多维分类 |
| `outcome` | TEXT | NULL | JSON 效果评估 {label, success_rate, usage_count} |
| `source_type` | TEXT | `'session'` | 经验来源：session / harness / reflection |
| `execution_id` | TEXT | NULL | 关联到触发经验的具体执行 |
| `node_id` | TEXT | NULL | 关联到具体节点 |

### D2: FTS5 蓝绿迁移

**决策**: 使用蓝绿策略（create `_v2` → populate → atomic swap），而非直接 DROP + CREATE。

**理由**:
- FTS5 不支持 ALTER TABLE，必须重建
- 直接 DROP 在 CREATE 失败时会导致数据丢失
- 蓝绿策略保证旧索引在迁移失败时仍然可用

```sql
-- 1. 创建新表（不影响现有服务）
CREATE VIRTUAL TABLE experiences_fts_v2 USING fts5(...)

-- 2. 填充数据
INSERT INTO experiences_fts_v2 SELECT ... FROM experiences

-- 3. 原子交换（一步完成）
DROP TABLE experiences_fts
ALTER TABLE experiences_fts_v2 RENAME TO experiences_fts
```

### D3: Adapter 模式统一三套 Prompt 系统

**决策**: 不直接合并三个系统，而是用 Adapter 模式包装，通过统一接口路由。

**理由**:
- 现有三套系统（SystemPromptAssembler / CloneRuntime / buildDelegationPrompt）各有复杂的内部逻辑
- 直接合并风险大、回归测试困难
- Adapter 模式保持各系统独立演进，统一接口层薄且稳定

**路由逻辑**:
```
assembleForAgent(cloneName?, opts):
  opts.type === 'harness'  → HarnessPromptAdapter
  cloneName === 'harness-agent' → HarnessPromptAdapter
  opts.type === 'clone'    → ClonePromptAdapter
  cloneName (非 harness)   → ChatPromptAdapter (assembleForClone)
  无 cloneName             → ChatPromptAdapter (assemble)
```

### D4: 执行级效果追踪（而非节点级）

**决策**: 在 `onExecutionEnd()` 批量更新 outcome，而非在 `onNodeEnd()` 逐个追踪。

**理由**:
- `onNodeEnd` 时序陷阱：`DetectorPipeline.pendingActions.delete()` 在 outcome 追踪之前清理上下文
- 执行级追踪更简单：执行成功 → 所有干预成功；执行失败 → 最后失败节点的干预标记失败
- 避免在 Proxy handler 中插入额外逻辑

### D5: 冷启动保护

**决策**: 成功率统计需要 ≥ 5 数据点才注入 prompt。

**理由**:
- 少量数据点的统计不可靠（1 次成功 = 100% 成功率 → 误导决策）
- 冷启动期间显示"经验积累中..."，避免 Harness Agent 基于不可靠数据做决策

### D6: 双存储统一到 DB

**决策**: 废弃 `SubsystemAdapter.writeExperience()` 文件存储，统一到 DB。

**理由**:
- 文件存储是死代码（0 文件，无调用方）
- DB + FTS5 已有完整的搜索、索引、事务支持
- 消除双写技术债

## 3. 学习闭环触发条件

### 3.1 经验记录触发

| 触发点 | 条件 | 产出 |
|--------|------|------|
| `HarnessController.onExecutionEnd()` | 执行结束且有干预记录 | experience 行 (scope=harness, outcome=pending) |
| `HarnessAgentSession.close()` | 会话关闭 | interventions 列表传递给 Controller |

**记录内容**:
```
## Harness Intervention: {detector}
- Pattern: {pattern}
- Severity: {severity}
- Node: {node_id} ({node_type})
- Decision: {decision}
- Reasoning: {reasoning}
- Evidence: {evidence summary}
```

### 3.2 效果追踪触发

| 触发点 | 条件 | 产出 |
|--------|------|------|
| `ExecutionLifecycle` — 执行成功 | `status: completed` | 所有 pending → `{label: 'success'}` |
| `ExecutionLifecycle` — 执行失败 | `status: failed` | 最后失败节点 → `failed`，其余 → `success` |
| `ExecutionLifecycle` — 执行取消 | `status: cancelled` | 不更新（保持 pending） |
| `ExecutionLifecycle` — 重试完成 | retry/interaction/autoResume 路径 | 同上规则 |

**覆盖的所有调用路径** (9 处):
1. 主执行成功路径
2. 主执行失败路径
3. 主执行取消路径
4. 重试成功路径
5. 重试失败路径
6. 交互完成成功路径
7. 交互完成失败路径
8. 自动恢复成功路径
9. 自动恢复失败路径

### 3.3 反思触发

| 触发点 | 条件 | 产出 |
|--------|------|------|
| `EvolutionService.reflect({scope})` | 手动调用或定时任务 | reflection experience 行 (source_type=reflection) |
| 定时任务 | 待配置（建议每天一次） | 自动分析过去 7 天经验 |

## 4. 数据流详解

### 4.1 干预 → 经验记录 → 效果追踪

```
工作流节点失败
    │
    ▼
检测器触发 DiagnosisReport
    │
    ▼
AgentDelegationService.delegate()
    ├── FTS5 搜索: searchByScope(query, 'harness', 5)
    ├── 成功率: getSuccessStats(org, 'harness', detectorName)
    ├── Prompt 组装: HarnessPromptAdapter
    │     ├── persona.md
    │     ├── clone memory
    │     ├── 历史案例 + 成功率
    │     └── 诊断报告
    └── LLM 返回 DelegationResult (fix_and_retry / guide_and_retry / ...)
    │
    ▼
HarnessAgentSession 记录干预
    ├── appendIntervention(report, state)
    └── recordDecision(nodeId, decision, reason)
    │
    ▼
执行结束 → HarnessController.onExecutionEnd(id, opts)
    ├── recordSessionExperiences()
    │     └── for each intervention → insertExperienceV2({
    │           scope: 'harness',
    │           scope_ref: detector,
    │           node_id, pattern_tags, outcome: {label:'pending'},
    │           source_type: 'harness', execution_id
    │         })
    ├── updateExperienceOutcomes(opts)
    │     └── listByExecutionId(id, {outcomeLabel:'pending'})
    │         → updateOutcome(experienceId, {label:'success'|'failed'})
    └── writeCloneDailyMemory()
          └── MemoryService.recordDaily(org, summary, cloneDir)
```

### 4.2 反思 → 洞察 → 注入

```
定时触发 reflect({scope: 'harness'})
    │
    ├── findExperiencesWithFailurePatternByScope(org, 'harness')
    │     → 识别高频失败模式
    │
    ├── findRecentExperiencesForReflectionByScope(org, 'harness')
    │     → 分析最近 7 天经验
    │
    ├── getSuccessStats(org, 'harness')
    │     → 统计各 decision 成功率
    │
    ├── 生成洞察:
    │     "timeout_cascade + agent_takeover 成功率仅 30%，建议优先 guide_and_retry"
    │
    └── insertExperienceV2({
          scope: 'harness',
          source_type: 'reflection',
          content: 洞察文本,
          scope_ref: 相关检测器,
          pattern_tags: [相关标签]
        })
          │
          ▼
    下次干预时 FTS5 检索到该洞察 → 注入 prompt
```

## 5. 使用方法

### 5.1 查询 Harness 经验

```bash
# 查看所有 harness 经验
sqlite3 ~/.octopus/db/octopus.db \
  "SELECT scope_ref, pattern_tags, outcome, 
   substr(content, 1, 100) as preview
   FROM experiences WHERE scope='harness' 
   ORDER BY created_at DESC LIMIT 20"

# 按检测器过滤
sqlite3 ~/.octopus/db/octopus.db \
  "SELECT * FROM experiences 
   WHERE scope='harness' AND scope_ref='deterministic_error'
   ORDER BY created_at DESC"
```

### 5.2 FTS5 全文搜索

```bash
# 搜索包含关键词的经验
sqlite3 ~/.octopus/db/octopus.db \
  "SELECT id, scope_ref, content FROM experiences_fts 
   WHERE experiences_fts MATCH 'syntax_error AND fix_and_retry'
   LIMIT 10"

# 搜索特定检测器的经验
sqlite3 ~/.octopus/db/octopus.db \
  "SELECT id, content FROM experiences_fts 
   WHERE experiences_fts MATCH 'timeout_cascade'
   LIMIT 10"
```

### 5.3 查看成功率统计

```bash
# 按 decision × detector 统计
sqlite3 ~/.octopus/db/octopus.db \
  "SELECT 
     json_extract(pattern_tags, '$[0]') as decision,
     scope_ref as detector,
     json_extract(outcome, '$.label') as result,
     COUNT(*) as count
   FROM experiences 
   WHERE scope='harness' AND outcome IS NOT NULL 
     AND outcome != '{\"label\":\"pending\"}'
   GROUP BY decision, detector, result
   ORDER BY detector, decision"
```

### 5.4 查看 Clone Daily Memory

```bash
# 查看 harness-agent 今日记忆
cat ~/.octopus/agent/built-in/harness-agent/memory/daily/$(date +%Y-%m-%d).md

# 查看所有 harness 记忆文件
ls -la ~/.octopus/agent/built-in/harness-agent/memory/daily/
```

### 5.5 手动触发反思

```bash
# 通过 API 触发（如果端点已配置）
curl -X POST http://localhost:3001/api/evolution/reflect \
  -H "Content-Type: application/json" \
  -d '{"org": "default", "scope": "harness"}'

# 查看反思产出
sqlite3 ~/.octopus/db/octopus.db \
  "SELECT content, created_at FROM experiences 
   WHERE source_type='reflection' AND scope='harness'
   ORDER BY created_at DESC LIMIT 5"
```

### 5.6 验证学习闭环

多次执行后，验证 prompt 中是否注入了历史数据：

```bash
# 查看 harness 日志（干预时的 prompt 内容）
grep "历史相似案例" ~/.octopus/logs/server.log | tail -5

# 或在 Web UI 的 Harness 浮动面板中查看 Agent 的 reasoning
# 应该包含类似: "基于历史经验, fix_and_retry 对此类错误成功率 87%"
```

## 6. 文件清单

### 新增文件

| 文件 | 用途 | 行数 |
|------|------|------|
| `packages/server/src/services/agent/prompt-assembler.ts` | Unified Prompt Assembler (3 adapters) | ~367 |
| `packages/server/src/services/harness/effectiveness-tracker.ts` | 冷启动保护 + 成功率格式化 | ~130 |
| `packages/server/src/__tests__/schema-migration.test.ts` | Schema 迁移测试 (15 tests) | ~268 |
| `packages/server/src/__tests__/evolution-dao-v2.test.ts` | DAO V2 方法测试 (33 tests) | ~456 |
| `packages/server/src/__tests__/prompt-assembler.test.ts` | Prompt Assembler 测试 (27 tests) | ~570 |
| `packages/server/src/__tests__/effectiveness-tracker.test.ts` | 效果追踪测试 (12 tests) | ~441 |
| `packages/server/src/__tests__/evolution-reflect-scope.test.ts` | Reflect + Scope 测试 (20 tests) | ~521 |
| `packages/server/src/services/harness/__tests__/harness-experience-recording.test.ts` | 经验记录测试 (9 tests) | ~489 |
| `packages/server/src/services/agent/__tests__/subsystem-adapter.test.ts` | 存储清理测试 (6 tests) | ~118 |

### 修改文件

| 文件 | 变更 |
|------|------|
| `packages/server/src/db/schema.sql` | +7 列, FTS5 重建, +5 索引 |
| `packages/server/src/db/schema.ts` | SCHEMA_VERSION 34→35, 蓝绿迁移函数 |
| `packages/server/src/db/types.ts` | +ExperienceRowV2 接口 |
| `packages/server/src/db/dao/evolution-dao.ts` | +4 DAO 方法, +insertExperienceV2 |
| `packages/server/src/services/harness/harness-controller.ts` | +经验记录, +效果追踪 |
| `packages/server/src/services/harness/harness-agent-session.ts` | +pendingReports Map |
| `packages/server/src/services/harness/agent-delegation.ts` | +成功率注入 |
| `packages/server/src/services/agent/evolution-service.ts` | +reflect({scope}) |
| `packages/server/src/services/agent/subsystem-adapter.ts` | 废弃 writeExperience |
| `packages/server/src/services/agent/init-service.ts` | 移除 experiences 目录创建 |
| `packages/server/src/services/execution/ExecutionLifecycle.ts` | +9 处 opts 传递 |
| `packages/web-app/components/workspace/workflow-nodes/status-shell.tsx` | +isDone 修复 (status-shell bug) |

## 7. 与现有系统的关系

### 7.1 已有记忆系统对比

| 系统 | 存储 | 消费者 | 本次变更 |
|------|------|--------|---------|
| `experiences` + FTS5 | SQLite | 主 Agent, Evolution | **+scope, +outcome, +FTS5 扩展** |
| `session_memory_fts` | SQLite FTS5 | 主 Agent, Clones | 无变更 |
| Knowledge files | 文件系统 | Workflow Agent Nodes | 无变更 |
| `harness_events` | SQLite | Harness Dashboard | 无变更（保持原始事件流） |
| Clone memory files | 文件系统 | 各 Clone | **harness-agent 开始写入** |

### 7.2 数据层级关系

```
harness_events (原始事件流 — 高频, 短期)
    │
    ├── 每个检测/干预/委托的完整记录
    ├── 用于实时 Dashboard 和审计
    └── 不做聚合分析
         │
         ▼ (onExecutionEnd 提炼)
         
experiences (scope=harness — 提炼经验, 长期)
    │
    ├── 每次干预一条记录（结构化摘要）
    ├── FTS5 全文索引
    ├── outcome 效果追踪
    └── 用于历史检索 + 成功率统计
         │
         ▼ (reflect 分析)
         
experiences (source_type=reflection — 反思洞察, 长期)
    │
    ├── 定期分析产出的洞察
    ├── FTS5 全文索引
    └── 下次干预时被检索注入 prompt
```

## 8. 性能考量

| 操作 | 预期延迟 | 频率 | 影响 |
|------|---------|------|------|
| FTS5 searchByScope | < 50ms | 每次干预 1 次 | 干预路径上，需快速 |
| getSuccessStats | < 100ms | 每次干预 1 次 | 聚合查询，有索引支持 |
| insertExperienceV2 | < 10ms | 每次干预 1 次 | 单次 INSERT |
| updateOutcome (批量) | < 200ms | 每次执行结束 1 次 | 按 execution_id 批量更新 |
| reflect({scope}) | 1-5s | 定时任务 | 离线分析，不影响实时路径 |

**索引支持**:
- `idx_experiences_scope` — scope 过滤
- `idx_experiences_scope_ref` — scope + scope_ref 组合
- `idx_experiences_execution` — execution_id 查找（partial index）
- `idx_experiences_org_scope_time` — org + scope + 时间排序

## 9. 已知限制与后续演进

### 当前限制

1. **org 硬编码为 "default"** — Harness Agent 目前只在 default org 运行
2. **无定时反思触发** — reflect({scope:'harness'}) 需手动调用或通过 processUnprocessedMarks 间接触发
3. **无前端 Analytics Dashboard** — 成功率统计只能通过 SQL 或 API 查看
4. **pattern_tags[0] 约定** — 第一个标签必须是 decision 类型（文档约定，无强制校验）

### 后续演进方向

1. **定时反思任务** — 通过 Scheduler 配置每日自动 reflect
2. **前端 Dashboard** — 可视化成功率趋势、高频模式、反思历史
3. **多 org 支持** — 从 execution workspace 传递 org 到 harness
4. **向量搜索** — 当 FTS5 关键词匹配不够时，引入 embedding + cosine similarity
5. **自动策略调优** — 基于成功率自动调整 detector 阈值或 strategy 权重

## 10. ContextEnricher 智能富化层 (PR #47)

PR #46 建了经验写入和存储基础设施，但 **读取注入** 全部断链。PR #47 创建了 `ContextEnricher` — 统一的智能富化层，让所有 Agent 类型在 prompt 组装时自动检索相关历史经验。

### 10.1 核心架构

```
ContextEnricher (packages/server/src/services/agent/context-enricher.ts)
│
├── enrichSync(params) / enrich(params)  ← 统一入口
│     scope: 'agent' | 'harness' | 'workflow'
│     query: string (搜索关键词)
│     org: string
│     budget: number (token 预算, 默认 1200)
│     forceSearch?: boolean (跳过关键词检测)
│
├── 关键词检测 (agent scope 专用)
│     触发词: 之前/上次/历史/经验/怎么解决的/遇到过/
│             error/failed/bug/fix/remember/last time
│     命中 → 搜索; 未命中 → segment=null (不搜索)
│
├── Scope 可见性规则
│     agent   → sees: [agent, global]
│     harness → sees: [harness, global]
│     workflow → sees: [workflow, global]
│
├── 预算截断
│     超预算时: 5条 → 3条 → 1条
│
└── 格式化输出
      ## 📚 相关历史经验 (3条)
      1. **[2026-08-10] deterministic_error:syntax_error**
         决策: fix_and_retry ✅ 成功
         摘要: bash 节点语法错误，修复了缺少引号的问题
```

### 10.2 各 Agent 接入点

| Agent 类型 | 接入文件 | 触发方式 | 预算 |
|-----------|---------|---------|------|
| Main Agent | `system-prompt-assembler.ts` `buildExperienceSegment()` | 关键词触发 | 1200t, P3.5 |
| Clone | `clone-runtime.ts` `assembleContextWithExperience()` | 关键词触发 | 800t |
| Harness | `prompt-assembler.ts` `HarnessPromptAdapter.loadExperienceContextAsync()` | always-on | 1200t |
| Workflow Node | `experience-precompute.ts` → VarPool → `agent.ts` `buildPrompt()` | always-on | 1000t |

## 11. 经验读写全景数据流

```
                        ┌── experiences 表 ──┐
                        │   + experiences_fts │
                        └────────┬───────────┘
                                 │
         ┌───────────────────────┼───────────────────────┐
         │                       │                       │
    写入者                    搜索层                   读取者
    ─────                    ─────                   ─────

 Harness 干预结束       searchByScopes()         Main Agent (关键词触发)
 → scope=harness        FTS5 MATCH               → sees: agent + global
 → outcome 追踪         + scope IN 过滤          Clone (关键词触发)
                        + 预算截断                → sees: agent + global
 Main Agent 对话                                  Harness (always-on)
 → scope=agent          enrichSync()              → sees: harness + global
 → create_experience    关键词检测                 Workflow (VarPool 桥接)
                        格式化 markdown            → sees: workflow + global
 Workflow 知识提取
 → scope=workflow
 → source_type=workflow

 Reflection 反思
 → scope=同输入
 → source_type=reflection
```

## 12. 用户故事 — 各场景详解

### 故事 1: Harness Agent — 最完整的闭环

**写入**: 工作流节点失败 → 检测器触发 → Agent 干预 → 执行结束 → `HarnessController.onExecutionEnd()` → `recordSessionExperiences()` 将每次干预写入 experiences 表（scope=harness, outcome=pending）。随后 `updateExperienceOutcomes()` 根据执行最终状态批量更新 outcome（success/failed）。

**读取**: 下次干预时 → `AgentDelegationService.buildPromptWithHistory()` → `HarnessPromptAdapter` 组装完整 prompt：
1. `persona.md` — harness-agent 人格
2. `long-term.md` — 长期记忆
3. `daily/YYYY-MM-DD.md` — 今日记忆（500t 预算）
4. `ContextEnricher.enrich()` — FTS5 搜索相似历史案例（forceSearch=true）
5. `buildDelegationPrompt()` — 诊断报告 + 成功率统计

**闭环效果**: 第 1 次遇到 syntax_error → 无历史案例；第 5 次 → prompt 注入 "历史 4 次 fix_and_retry，成功率 100%"。

### 故事 2: Main Agent 聊天 — 智能触发

**写入**: 对话中 Agent 调用 `create_experience` 工具 → `EvolutionService.recordExperience()` → `insertExperienceWithFts()` (scope=agent, source_type=session)。

**读取**: 用户发送 "上次那个 API 超时问题怎么解决的？" → `SystemPromptAssembler.assemble({ userMessage })` → `buildExperienceSegment()` 检测到关键词 "上次" → `ContextEnricher.enrichSync({ scope:'agent' })` → FTS5 搜索 → 返回 2 条相关经验 → 注入 prompt P3.5 位置。

**不触发**: 用户发送 "帮我创建一个新文件" → 无关键词匹配 → segment=null → 不搜索不注入 → 节省 token。

### 故事 3: Clone 聊天 — 经验附加

**读取**: 用户 "@@workspace 部署流程是怎样的？" → `CloneRuntime.chat()` → `assembleContextWithExperience()` → `ContextEnricher.enrich({ scope:'agent', budget:800 })` → 搜索 agent+global scope 经验 → 追加到 baseContext 后面。

**写入**: 与 Main Agent 共享同一写入路径（`create_experience` 工具）。

### 故事 4: 工作流 Agent 节点 — VarPool 桥接

**写入**: 工作流执行完成后，`KnowledgeService` 知识提取路径中的 `proposeRulesForReview()` 将提取的规则写入 workflow scope 经验（scope=workflow, source_type=workflow）。

**读取**: Server 端 `precomputeExperience()` → `ContextEnricher.enrichSync({ scope:'workflow', forceSearch:true })` → 写入 VarPool `__experience_segment` → Engine 端 `AgentExecutor.buildPrompt()` 读取 VarPool → prepend 到 prompt 前。

**跨包解耦**: Engine 不依赖 Server 包，通过 VarPool 传递经验 segment。

### 故事 5: 反思进化 — 经验的二次提炼

**触发**: `POST /api/agent/self-check/evolve` 或 `processUnprocessedMarks()` 自动触发。

**流程**: `EvolutionService.reflect({ scope:'harness' })` → `reflectWithScope()` → 分析最近 7 天 harness 经验 → `getSuccessStats()` 统计成功率 → 识别低成功率决策 (< 50%) → 生成洞察 "timeout_cascade + agent_takeover 成功率仅 30%，建议优先 guide_and_retry" → `writeReflectionExperience()` 写入（source_type='reflection'）。

**效果**: 反思经验在下次干预时被 FTS5 搜索到，Agent 看到建议 → 改变决策。

## 13. 关键 SQL 操作速查

| 操作 | SQL 概要 | 代码位置 |
|------|---------|---------|
| 插入 V2 经验 | `INSERT INTO experiences (..., scope, scope_ref, pattern_tags, outcome, source_type, execution_id, node_id)` | `evolution-dao.ts:176` |
| 插入 FTS 索引 | `INSERT INTO experiences_fts (rowid, skill_name, content, scope, scope_ref, pattern_tags)` | `evolution-dao.ts:187` |
| 更新 outcome | `UPDATE experiences SET outcome = ? WHERE id = ?` | `evolution-dao.ts:329` |
| 多 scope FTS 搜索 | `SELECT ... FROM experiences_fts MATCH ? WHERE scope IN (...)` | `evolution-dao.ts:298` |
| LIKE 降级搜索 | `SELECT ... FROM experiences WHERE content LIKE ? AND scope IN (...)` | `evolution-dao.ts:315` |
| 按执行查找 | `SELECT ... WHERE execution_id = ? AND json_extract(outcome,'$.label') = ?` | `evolution-dao.ts:341` |
| 成功率统计 | `SELECT pattern_tags, outcome FROM experiences WHERE scope=?` | `evolution-dao.ts:368` |
| 失败模式查找 | `SELECT COUNT(*), skill_name ... WHERE content LIKE '%失败%' GROUP BY ... HAVING count >= 3` | `evolution-dao.ts:142` |

## 14. 总结

### 核心价值

所有 Agent 类型从"每次从零开始"变成"越用越聪明"：
- **经验积累**: Harness 干预自动记录，Main Agent/Clone 主动记录，工作流知识提取写入
- **效果反馈**: 自动追踪干预结果，统计 decision × pattern 成功率
- **智能注入**: ContextEnricher 统一富化层，按 scope 隔离，智能触发
- **反思进化**: 定期分析模式，生成可操作建议，写入反思经验

### 两个 PR 的分工

| | PR #46 (平台层) | PR #47 (经验注入) |
|---|---|---|
| **核心** | 经验写入 + 存储 + 效果追踪 | 经验读取 + 注入 + 闭环 |
| **新增** | 7 列 schema, FTS5, 4 DAO 方法, 效果追踪, 反思 | ContextEnricher, 5 个 Agent 接入, VarPool 桥接 |
| **测试** | 122 tests | 150 tests |
| **断链修复** | — | 6 个 CRITICAL 断链 (C1-C6) + 2 个缺口 |

### 架构原则

1. **统一平台层** — 所有 Agent 类型通过 ContextEnricher 同一接口学习
2. **Scope 隔离** — agent / workflow / harness / global 互不干扰
3. **Adapter 模式** — 包装而非重写，最小化回归风险
4. **智能触发** — Chat 场景关键词检测，不浪费 token；Harness/Workflow always-on
5. **VarPool 桥接** — Server 和 Engine 跨包零耦合
6. **冷启动保护** — 数据不足时不误导决策

### 完整闭环验证

```
写入 ───→ 存储 ───→ 检索 ───→ 注入 ───→ 追踪 ───→ 反思
  │          │          │          │          │          │
  ✅         ✅         ✅         ✅         ✅         ✅
Harness    experiences  FTS5      prompt    outcome    reflect
Agent      + FTS5      searchBy   segment   success/   写入反思
Main       索引         Scopes    (P3.5)    failed     经验
Workflow   蓝绿迁移    多scope    VarPool   批量更新
Reflection             可见性    桥接
```

### 数据规模预估

| 场景 | 每日经验量 | 30 天累计 | FTS5 索引大小 |
|------|-----------|-----------|--------------|
| 低使用（5 次执行/天） | ~10 条 | ~300 条 | < 1MB |
| 中使用（50 次执行/天） | ~100 条 | ~3,000 条 | < 5MB |
| 高使用（500 次执行/天） | ~1,000 条 | ~30,000 条 | < 50MB |

SQLite + FTS5 在这个规模下性能充足（< 50ms 搜索延迟）。

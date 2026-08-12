# Spec: Harness Learning Platform — 统一学习平台层

## Problem Statement

Harness Agent 是系统内置分身（built-in clone），负责工作流执行中的异常检测和智能干预。但当前：
1. **无跨执行记忆** — 每次执行创建全新 HarnessAgentSession，干预经验执行完即丢
2. **旁路 Clone 基础设施** — 虽注册为 clone 但不用 persona.md、不写 memory、不走 SystemPromptAssembler
3. **三套并行管道** — Chat Agent（experiences + memory）、Workflow（knowledge rules）、Harness（harness_events）各不相连
4. **无效果反馈** — 不知道干预是否有效，无法从经验中学习

结果：Harness Agent 永远是"新手"，无法越用越聪明。

## Solution

提取**统一学习平台层**，所有 Agent 类型通过标准化接口消费记忆和学习能力：
- **Experience Store**: experiences 表 + FTS5 + scope 维度（agent/workflow/harness/global）
- **Unified Prompt Assembler**: 合并 SystemPromptAssembler + CloneRuntime 为一个接口
- **Effectiveness Tracker**: 自动追踪干预结果，统计 decision × pattern 成功率
- **Evolution Engine**: 复用 EvolutionService.reflect() 实现经验反思

## Projects Involved
- [ ] server (核心：schema、DAO、services、prompt assembler)
- [ ] shared (类型定义、schema migration)
- [ ] engine (KnowledgeInjector 接口适配)
- [ ] web-app (无变更，本特性为后端架构)

## Feature Scope
**Do:**
- experiences 表 schema 演进（6 新列：scope, scope_ref, pattern_tags, outcome, source_type, execution_id）
- FTS5 重建为 content-sync 模式
- 废弃文件存储（SubsystemAdapter.writeExperience）
- Harness Agent 接入 clone memory（读 persona + long-term memory + FTS 历史案例）
- 干预结束后持久化经验到 experiences 表（scope=harness）+ clone daily memory
- 干预效果自动追踪（outcome: pending → success/failed）
- 定期 reflect 统计 decision × pattern 成功率
- 统一 SystemPromptAssembler + CloneRuntime 为一个接口
- EvolutionService.reflect() 增加 scope 过滤参数

**Don't:**
- 不加向量 embedding / 语义搜索
- 不改 Scheduled AgentExecutor
- 不做前端 Analytics Dashboard（独立特性）
- 不改现有 knowledge rules 的 scope 模型（已有良好设计）
- 不回填历史 harness_events 数据

## Key Decisions
| # | Decision | Conclusion | Reason |
|---|---------|-----------|--------|
| 1 | Experience Schema | 7 新列（含 node_id）+ FTS5 content-sync | scope 隔离 + 效果追踪 + 节点级关联 |
| 2 | 双存储统一 | 统一到 DB，废弃文件存储 | 文件存储是死代码（0 文件，无调用方） |
| 3 | Harness Clone 集成 | 混合集成：统一 context + 专用对话 + 统一持久化 | 保留 harness 特有能力的同时复用平台层 |
| 4 | Prompt Assembler | Adapter 模式统一三套系统 | 三套（非两套）：SysPromptAssembler + CloneRuntime + buildDelegationPrompt |
| 5 | 效果反馈 | onExecutionEnd() 执行级追踪 + 统计反馈 | 避免 onNodeEnd 时序陷阱，简化实现 |
| 6 | Evolution 集成 | 复用 reflect() + scope 参数 + experience 输出路径 | reflect 需写入 experiences（非仅 SKILL.md diff） |
| 7 | FTS5 迁移 | 蓝绿迁移：新建 → 填充 → 交换 | 防止 DROP+CREATE 数据丢失 |
| 8 | 冷启动策略 | < 5 数据点时跳过成功率注入 | 防止统计不可靠误导决策 |

## Decision Map Summary
| # | Ticket | Type | Decision |
|---|--------|------|----------|
| 01 | Experience Schema Evolution | research | 6 列 + FTS5 content-sync + 5 新索引 |
| 02 | Dual Store Unification | grilling | 统一到 DB |
| 03 | Harness Clone Runtime | grilling | 混合集成 |
| 04 | Unified Prompt Assembler | grilling | 全部统一 |
| 05 | Effectiveness Feedback | grilling | 自动追踪 + 统计 |
| 06 | Evolution Integration | grilling | 复用 reflect() |
Map: [map.md](./map.md)

## User Stories
1. As a **Harness Agent**, I want 干预时能检索历史相似案例，so that 决策更有据可依
2. As a **Harness Agent**, I want 干预结束后持久化经验，so that 下次执行能利用本次教训
3. As a **系统**, I want 自动追踪干预效果，so that 能统计哪些 decision 对哪些 pattern 最有效
4. As a **Harness Agent**, I want 干预 prompt 中包含成功率数据，so that 能优先推荐高成功率方案
5. As a **开发者**, I want 统一的 Prompt Assembler 接口，so that 新增 Agent 类型时不需重复实现
6. As a **系统**, I want experiences 表支持 scope 隔离，so that 不同 Agent 类型的经验互不干扰
7. As a **开发者**, I want EvolutionService.reflect() 能按 scope 分析，so that 各 Agent 类型独立进化
8. As a **系统**, I want 废弃文件存储统一为 DB，so that 消除双写技术债

## Implementation Decisions

### A. Experience Store Schema（packages/server + shared）

**表结构演进**:
```sql
ALTER TABLE experiences ADD COLUMN scope TEXT NOT NULL DEFAULT 'agent';
ALTER TABLE experiences ADD COLUMN scope_ref TEXT DEFAULT NULL;
ALTER TABLE experiences ADD COLUMN pattern_tags TEXT DEFAULT '[]';
ALTER TABLE experiences ADD COLUMN outcome TEXT DEFAULT NULL;
ALTER TABLE experiences ADD COLUMN source_type TEXT NOT NULL DEFAULT 'session';
ALTER TABLE experiences ADD COLUMN execution_id TEXT DEFAULT NULL;
ALTER TABLE experiences ADD COLUMN node_id TEXT DEFAULT NULL;
```

**FTS5 蓝绿迁移**（防数据丢失）:
```sql
-- Step 1: 创建新 FTS 表（不删旧的）
CREATE VIRTUAL TABLE IF NOT EXISTS experiences_fts_v2 USING fts5(
  skill_name, content, scope, scope_ref, pattern_tags,
  content='experiences', content_rowid='id'
);
-- Step 2: 填充数据
INSERT INTO experiences_fts_v2 (rowid, skill_name, content, scope, scope_ref, pattern_tags)
  SELECT id, skill_name, content, scope, scope_ref, pattern_tags FROM experiences;
-- Step 3: 原子交换
DROP TABLE IF EXISTS experiences_fts;
ALTER TABLE experiences_fts_v2 RENAME TO experiences_fts;
```

**新增 DAO 方法**:
- `listByScope(org, scope, {scopeRef?, limit?})` — 按 scope 查询
- `searchByScope(query, scope?, limit?)` — scope-aware FTS5 搜索
- `updateOutcome(id, outcome)` — 更新干预效果
- `getSuccessStats(org, scope, scopeRef?)` — 聚合成功率统计

### B. Unified Prompt Assembler（packages/server）

**Adapter 模式统一三套系统**:
- 现有三套 prompt 系统：`SystemPromptAssembler`、`CloneRuntime.assembleContext()`、`buildDelegationPrompt()`
- 提取 `PromptAssembler` 统一接口，现有系统作为 adapter 实现
- `assembleForAgent(cloneName?, opts)` — 统一入口
- 内部根据 cloneName + opts.type 路由到对应的 adapter
- 保留 priority-based budget truncation 逻辑
- **加 E2E 快照测试**：对比统一前后各 Agent 类型的 prompt 输出不变

**Harness 专用 context 组装**:
```
buildHarnessContext(diagnosisReport):
  1. persona.md (harness-agent) — 从 clone 目录加载
  2. clone long-term memory — 从 clone memory 目录加载
  3. FTS5 搜索相似历史案例 (top 5, scope=harness)
  4. 成功率统计注入（≥5 数据点时）
  5. 当前诊断报告 + 执行上下文
```

### C. Effectiveness Tracker（packages/server）

**追踪流程（执行级，避免 onNodeEnd 时序陷阱）**:
1. 干预发生时：`HarnessController` 在内存中记录 pending interventions（不立即写 DB）
2. 执行结束时：`HarnessController.onExecutionEnd()` 批量写入所有干预经验：
   ```
   for each intervention in session:
     EvolutionDAO.insertExperience({
       scope: 'harness', scope_ref: detector, node_id,
       content: summarizeIntervention(report, decision),
       pattern_tags: [pattern, nodeType, severity],
       outcome: {label: 'pending'},
       source_type: 'harness', execution_id
     })
   ```
3. 结果更新：同一 `onExecutionEnd()` 中，根据执行最终状态批量更新 outcome：
   - 执行 completed → 所有干预 outcome = success
   - 执行 failed → 查找最后失败节点的干预，标记 failed
4. 定期 reflect：`EvolutionService.reflect({scope:'harness'})` → 统计 decision × pattern 成功率
5. 注入 prompt：`searchByScope(query, 'harness')` 返回结果包含 outcome 统计
   - **冷启动保护**：数据点 < 5 时跳过注入，显示 "经验积累中..."

**关联机制**:
- experience 行存储 `execution_id` + `node_id`（新增列）
- `onExecutionEnd()` 可一次性查找本次执行所有 pending experiences 并批量更新
- outcome JSON：`{label: 'success'|'failed'|'pending', success_rate, usage_count, last_applied}`

### D. Harness Agent Session Lifecycle（packages/server）

**干预开始**:
```
AgentDelegationService.delegate():
  1. 加载 persona: readClonePersona('harness-agent')
  2. 加载 memory: MemoryService.readMemory(org, 'long-term', cloneDir)
  3. FTS5 搜索: EvolutionDAO.searchByScope(diagnosisQuery, 'harness', 5)
  4. 成功率: EvolutionDAO.getSuccessStats(org, 'harness', detectorName)
  5. 组装 prompt: UnifiedAssembler.assembleForAgent('harness-agent', {context, history})
  6. 创建 HarnessAgentSession（保留现有对话管理）
```

**干预结束**:
```
HarnessAgentSession.close():
  1. 写 experience: EvolutionService.recordExperience(org, {
       scope: 'harness',
       scope_ref: detector,
       content: summarizeIntervention(report, decision, outcome),
       pattern_tags: [pattern, nodeType, severity],
       outcome: {label: 'pending'},
       source_type: 'harness',
       execution_id
     })
  2. 写 daily memory: MemoryService.recordDaily(org, summary, cloneDir)
  3. 写 summary: executions.harness_summary (保持现有行为)
```

### E. Dual Store Cleanup（packages/server）

- 删除 `SubsystemAdapter.writeExperience()` 方法
- 删除 `~/.octopus/agent/evolution/experiences/` 目录创建逻辑（InitService）
- `SubsystemAdapter.searchExperiences()` 委托给 `EvolutionDAO.searchByScope()`
- 更新 `AgentService.getExperiences()` 使用新 DAO 方法

### F. Evolution Integration（packages/server）

- `EvolutionService.reflect()` 增加可选 `scope` 参数
- 按 scope 分组分析经验模式
- Harness scope 的 reflect 重点分析：decision 成功率、detector 准确度、pattern 频率
- **新增 experience 输出路径**：reflect 产出的 insights 写入 experiences 表（`source_type:'reflection'`），
  使其可被 FTS5 检索并在下次干预时注入 prompt。不再仅产出 SKILL.md diff。
- 不创建独立的 HarnessEvolutionService

## Data Model Changes
| Table | Operation | Details |
|-------|-----------|---------|
| `experiences` | ALTER | +6 columns: scope, scope_ref, pattern_tags, outcome, source_type, execution_id |
| `experiences_fts` | DROP + CREATE | 重建为 content-sync 模式，+3 searchable columns |
| New indexes | CREATE | 5 新索引（scope, scope+ref, source_type, execution_id, org+scope+time） |

## API Contracts
| Method | Path | Side | Params | Response | Notes |
|--------|------|------|--------|----------|-------|
| GET | `/evolution/experiences` | server | `?scope=&scope_ref=&q=` | `ExperienceRowV2[]` | scope-aware 列表/搜索 |
| GET | `/evolution/experiences/stats` | server | `?scope=&scope_ref=` | `{decisionStats, patternStats}` | 成功率统计 |
| POST | `/memory/rebuild-fts` | server | — | `{rebuilt: number}` | 已有，FTS 重建 |

## Verification Strategy

### Verification Environment
| Item | Value |
|------|-------|
| Environment | local dev: `pnpm dev` |
| API prefix | `/api/` |
| Database | SQLite: `~/.octopus/db/octopus.db` |
| Admin UI | `http://localhost:3000` |

### AC to Verification Method Mapping
| US# | User Story | AC | Verification Level | Method |
|-----|-----------|-----|-------------------|--------|
| 1 | 检索历史案例 | AC-1: FTS5 搜索返回 scope=harness 的相似案例 | Unit + Integration | DAO test + API test |
| 2 | 持久化经验 | AC-2: 干预结束后 experiences 表有新行 (scope=harness) | Integration | DB assertion |
| 3 | 效果追踪 | AC-3: 节点重试成功后 outcome 更新为 success | Integration | DB assertion |
| 4 | 成功率注入 | AC-4: 干预 prompt 中包含成功率数据 | Unit | Mock + assertion |
| 5 | 统一 Assembler | AC-5: 主 Agent + Clone + Harness 使用同一 assembler | Unit | Interface test |
| 6 | Scope 隔离 | AC-6: scope=agent 查询不返回 scope=harness 数据 | Unit | DAO test |
| 7 | Reflect scope | AC-7: reflect({scope:'harness'}) 只分析 harness 经验 | Unit | Service test |
| 8 | 废弃文件存储 | AC-8: SubsystemAdapter 无 writeExperience 方法 | Unit | Code assertion |
| — | Schema migration | AC-9: 现有 experiences 数据不受影响（DEFAULT 值） | Integration | Migration test |
| — | FTS5 重建 | AC-10: FTS5 搜索在新 schema 上正常工作 | Integration | FTS query test |
| — | 效果统计 | AC-11: getSuccessStats 返回正确的成功率 | Unit | DAO test |
| — | Persona 加载 | AC-12: Harness Agent 干预时加载 persona.md | Integration | Prompt assertion |

### Verification Methods Detail

#### Unit Tests
- `EvolutionDAO`: listByScope, searchByScope, updateOutcome, getSuccessStats
- `EvolutionService`: reflect with scope parameter
- `UnifiedPromptAssembler`: assembleForAgent for main, clone, harness
- `HarnessExperienceExtractor`: summarizeIntervention output format

#### Integration Tests
- Schema migration: ALTER TABLE + FTS5 rebuild + data integrity
- Harness intervention lifecycle: delegate → intervene → record experience → track outcome
- FTS5 search: insert harness experience → search by scope → verify results
- Prompt assembly: full harness context assembly with persona + memory + FTS results

#### Manual Checklist
- Verify clone memory directory structure after harness intervention
- Verify persona.md is loaded in delegation prompt
- Verify existing clone behavior unchanged after assembler unification

## Risks & Notes
- R1: Unified Prompt Assembler 统一可能影响现有 Clone 行为 — 需充分 E2E 测试
- R2: FTS5 搜索在干预路径上的延迟 — 目标 < 200ms，需性能测试
- R3: Schema migration 兼容性 — 所有新列用 DEFAULT 值，现有代码不受影响
- R4: 效果追踪依赖 onNodeEnd 回调时序 — 需确保 experience 写入先于 outcome 更新

## Glossary
| Term | Meaning |
|------|---------|
| **scope** | experiences 表的作用域维度：agent / workflow / harness / global |
| **scope_ref** | 作用域内引用标识（skill_name / workflow_ref / detector name） |
| **outcome** | 干预效果评估 JSON：{label, success_rate, usage_count, last_applied} |
| **Unified Prompt Assembler** | 合并后的统一 prompt 组装器，替代 SystemPromptAssembler + CloneRuntime |
| **HarnessExperienceExtractor** | 从 harness 干预结果中提取结构化经验的组件 |
| **content-sync FTS5** | FTS5 的 content 同步模式，FTS 表作为主表的索引视图 |

## Appendix: Core User Stories（闭环验证）

### Story 1: Harness Agent 检索历史案例
```
[Exec] 工作流执行 → 节点失败 → 检测器触发
[Exec] AgentDelegationService.delegate() 开始
[API]  读取 persona.md (harness-agent)
[Data] 读取 clone long-term memory
[Data] EvolutionDAO.searchByScope("deterministic_error syntax_error", "harness", 5)
[Data] → 返回 3 条历史案例，含 outcome 统计
[Exec] UnifiedAssembler 组装 prompt（persona + memory + 历史案例 + 成功率 + 诊断报告）
[Exec] HarnessAgentSession 发送 prompt → LLM 返回 decision
[Event] SSE harness_delegation → 前端更新
```

### Story 2: 干预经验持久化 + 效果追踪
```
[Exec] Harness Agent 返回 fix_and_retry decision
[Data] EvolutionService.recordExperience({scope:'harness', outcome:{label:'pending'}, ...})
[Exec] 引擎用 harness hint 重试节点
[Exec] 节点重试成功 → onNodeEnd 回调
[Data] 查找 pending experience (execution_id + node_id)
[Data] updateOutcome(id, {label:'success', success_rate: computed})
[Data] MemoryService.recordDaily(org, summary, cloneDir)
```

### Story 3: 成功率统计注入
```
[Exec] 新的干预请求（同一 detector + pattern）
[Data] EvolutionDAO.getSuccessStats(org, 'harness', 'deterministic_error')
[Data] → {fix_and_retry: 87%, guide_and_retry: 65%, agent_takeover: 45%}
[Exec] 统计注入 prompt: "历史相似案例: fix_and_retry 成功率 87%"
[Exec] Harness Agent 优先选择 fix_and_retry
```

### Story 4: 定期反思进化
```
[Exec] 定时任务触发 EvolutionService.reflect({scope:'harness'})
[Data] 分析最近 7 天 harness 经验
[Data] 发现: timeout_cascade + agent_takeover 成功率仅 30%
[Data] 生成 insight: "timeout_cascade 场景建议优先 guide_and_retry"
[Data] 写入 experiences (scope:'harness', source_type:'reflection')
[Exec] 下次 timeout_cascade 干预时，insight 被 FTS5 检索注入 prompt
```

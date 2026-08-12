# Spec: Experience Injection — ContextEnricher 智能富化层

## Problem Statement

experiences 表 + FTS5 基础设施已建成，但 5 个 Agent 类型中**没有任何一个在 prompt 组装时搜索和注入经验**。数据写进去了但没被读出来，学习闭环在"注入"这一环全部断链。

当前状态：
- Main Agent: 有文件记忆但无 FTS5 经验搜索
- Clone: 有文件记忆但无 FTS5 经验搜索
- Harness: 有成功率统计但无 FTS5 历史案例搜索 + 缺 daily memory
- Workflow Agent Node: 有知识规则但无经验搜索
- Scheduled Agent: 零上下文（本次不改造，ROI 太低）

## Solution

创建 **ContextEnricher** 服务 — 一个统一的智能富化层，每个 Prompt Assembler 调用它来获取相关历史经验。它根据 agent 类型（scope）、当前上下文和 token 预算，智能决定搜索什么、返回多少、如何格式化。

## Projects Involved
- [ ] server (核心：ContextEnricher + 各 Assembler 接入)
- [ ] engine (Workflow Agent Node 接入)

## Feature Scope
**Do:**
- 创建 ContextEnricher 服务（搜索策略 + 可见性规则 + 预算分配 + 格式化）
- Main Agent 接入：SystemPromptAssembler 增加 experience segment
- Clone 接入：CloneRuntime.assembleContext() 增加 experience 加载
- Harness Agent 接入：HarnessPromptAdapter 增加 FTS5 搜索 + daily memory
- Workflow Agent Node 接入：AgentExecutor.buildPrompt() 增加经验注入
- 智能触发：chat 场景关键词检测，harness/workflow always-on
- 严格 scope 隔离：每个 agent 只看 own scope + global
- 优先级预算：经验 segment P3.5，800-1200 tokens（3-5 条）

**Don't:**
- 不改造 Scheduled Agent
- 不改知识规则注入（已工作）
- 不加向量搜索（保持 FTS5）
- 不做前端 UI 展示
- 不做经验自动清理/过期

## Key Decisions
| # | Decision | Conclusion | Reason |
|---|---------|-----------|--------|
| D1 | 架构模式 | ContextEnricher 统一富化层 | 避免 5 处重复代码，统一策略 |
| D2 | 搜索触发 | 智能触发（chat 关键词检测，harness/workflow always-on） | 平衡成本和智能 |
| D3 | Scope 可见性 | 严格隔离（own + global） | 最干净，避免噪声 |
| D4 | Scheduled Agent | 跳过 | ROI 太低，定时任务通常简单重复 |
| D5 | 预算分配 | P3.5 优先级，800-1200 tokens，top 3-5 条 | 经验是辅助信息，不应挤占核心段 |
| D6 | 注入格式 | 结构化 markdown（日期 + 模式 + 决策 + 结果标记） | LLM 最易理解的格式 |
| D7 | Harness daily memory | 补上 HarnessPromptAdapter 的 daily memory 加载 | 修复遗漏 |
| D8 | UnifiedPromptAssembler | 本特性将其真正接入生产代码 | 上特性建了但未接入，本次是核心任务 |
| D9 | 多 scope 搜索 | 新增 `searchByScopes(query, scopes[], limit)` DAO | 支持 ['agent','global'] 可见性 |
| D10 | Engine 跨包 | VarPool 桥接模式（server 预计算 → VarPool → engine 读取） | engine 不能直接依赖 server |
| D11 | 用户消息传递 | AssembleOptions 增加 `userMessage` 字段 | 智能触发需要用户消息作为关键词检测输入 |

## User Stories
1. As a **主 Agent**, I want 用户问历史问题时自动搜索相关经验，so that 回答更有历史依据
2. As a **Clone**, I want 看到同 scope 的历史经验，so that 同类任务做得更好
3. As a **Harness Agent**, I want 干预时看到过去类似案例的详细 reasoning，so that 决策更有据可依
4. As a **Workflow Agent Node**, I want 执行前看到类似任务的历史经验，so that 避免重复犯错
5. As a **系统**, I want scope 严格隔离，so that 不同 agent 类型的经验互不干扰
6. As a **系统**, I want 智能触发而非 always-on，so that 不浪费 token 在无需要的场景
7. As a **Harness Agent**, I want 加载 daily memory，so that 能感知今天已做过的干预
8. As a **开发者**, I want 统一 ContextEnricher 接口，so that 新增 agent 类型时只需声明 scope

## Implementation Decisions

### A. ContextEnricher 服务（packages/server 新增）

**文件**: `packages/server/src/services/agent/context-enricher.ts`

**接口设计**:
```typescript
interface ContextEnricher {
  enrich(params: EnrichParams): Promise<EnrichResult>
}

interface EnrichParams {
  scope: 'agent' | 'harness' | 'workflow'
  query: string
  org: string
  budget: number        // 最大 token 数（默认 1200）
  forceSearch?: boolean // 跳过关键词检测，直接搜索
}

interface EnrichResult {
  segment: string | null  // null = 不需要注入
  count: number
  tokensUsed: number
}
```

**搜索策略**（按 scope）:
| Scope | 查询来源 | 触发条件 |
|-------|---------|---------|
| agent | 用户消息关键词提取 | 关键词匹配 → forceSearch=true |
| harness | 诊断报告 pattern + detector | forceSearch=true（always-on） |
| workflow | 任务描述 + node_type | forceSearch=true（always-on） |

**关键词检测**（agent scope）:
```
触发词: "之前"、"上次"、"历史"、"经验"、"怎么解决的"、"遇到过"、
       "error"、"failed"、"bug"、"fix"、"remember"、"last time"
检测: 正则匹配 userMessage，命中则搜索，未命中则 segment=null
```

**可见性规则**:
```typescript
const SCOPE_VISIBILITY: Record<string, string[]> = {
  agent:    ['agent', 'global'],
  harness:  ['harness', 'global'],
  workflow: ['workflow', 'global'],
}
```

**格式化输出**:
```markdown
## 📚 相关历史经验 (3条)

1. **[2026-08-10] deterministic_error:syntax_error**
   决策: fix_and_retry ✅ 成功
   摘要: bash 节点语法错误，修复了缺少引号的问题

2. **[2026-08-09] timeout_cascade**
   决策: agent_takeover ❌ 失败
   摘要: 3 个连续超时，agent takeover 也超时了
```

### B. DAO 扩展（EvolutionDAO）

**新增 `searchByScopes` 方法**:
```typescript
searchByScopes(query: string, scopes: string[], limit: number = 5): ExperienceRowV2[]
// FTS5 MATCH + WHERE scope IN (...)
// LIKE fallback with escaped wildcards
```

### C. 各 Assembler 接入点（生产接入 — 修复 C1/C2/C3）

| Assembler | 接入方式 | 关键修复 |
|-----------|---------|---------|
| SystemPromptAssembler | 新增 `buildExperienceSegment(userMessage)` | **C3**: AssembleOptions 增加 `userMessage` 字段，chat routes 传入 |
| CloneRuntime | assembleContext() 追加 experience loading | 复用 ContextEnricher |
| **AgentDelegationService** | **C2**: `buildPromptWithHistory()` 中接入 HarnessPromptAdapter | persona + memory + FTS5 + daily + stats 全部通过 adapter |
| AgentExecutor.buildPrompt() | **C5**: VarPool 桥接 — server 预计算写入 VarPool，engine 读取 | 跨包解耦 |

### D. VarPool 桥接模式（Engine — 修复 C5）

**Server 端**（precompute hook）:
```typescript
// packages/server/src/services/knowledge/precompute.ts
async precomputeExperienceContext(executionId, nodePrompt, org):
  enricher.enrich({scope:'workflow', query:nodePrompt, org, forceSearch:true})
  → VarPool['__experience_segment'] = result.segment
```

**Engine 端**（AgentExecutor.buildPrompt）:
```typescript
// packages/engine/src/executors/agent.ts
const expSegment = varPool.get('__experience_segment')
if (expSegment) prompt = expSegment + '\n\n---\n\n' + prompt
```

### E. Harness Agent 完整修复（修复 C2 + D7）

**AgentDelegationService.buildPromptWithHistory()** 改造:
1. 使用 HarnessPromptAdapter 组装基础 prompt（persona + long-term + daily）
2. 调用 ContextEnricher 获取历史案例
3. 保留现有的 stats 注入（从 AgentDelegationService 移到 adapter 中）
4. 保留现有的 session history 累积

**HarnessPromptAdapter 新增**:
- `loadDailyMemory()` — 读取 `daily/YYYY-MM-DD.md`（500t 预算）
- `loadExperienceContext(report)` — 调用 ContextEnricher
- 将 stats 注入从 AgentDelegationService 移入此 adapter

## Data Model Changes
无 schema 变更。使用现有 experiences 表 + FTS5 索引。

## API Contracts
| Method | Path | Side | Params | Response | Notes |
|--------|------|------|--------|----------|-------|
| GET | `/api/agent/experiences/search` | server | `?q=&scope=&limit=` | `EnrichResult` | 已有端点，ContextEnricher 内部复用 |

## Verification Strategy

### Verification Environment
| Item | Value |
|------|-------|
| Environment | local dev: `pnpm dev` |
| API prefix | `/api/` |
| Database | SQLite: `~/.octopus/db/octopus.db` |

### AC to Verification Method Mapping
| US# | AC | Verification |
|-----|-----|-------------|
| 1 | Main Agent 关键词触发时注入经验 | Unit: mock enrich → assert segment in prompt |
| 2 | Clone 注入同 scope 经验 | Unit: clone enrich → assert scope filter |
| 3 | Harness FTS5 搜索 + daily memory | Unit: harness enrich → assert FTS5 + daily |
| 4 | Workflow Agent Node 注入经验 | Unit: buildPrompt → assert experience segment |
| 5 | Scope 隔离 | Unit: agent query → assert no harness results |
| 6 | 智能触发 | Unit: non-trigger message → assert null segment |
| 7 | Harness daily memory | Unit: assert daily file content in prompt |
| 8 | 统一接口 | Unit: all 4 scopes via same enrich() method |
| — | 预算截断 | Unit: over-budget → assert truncation |
| — | 向后兼容 | Integration: existing prompt tests unchanged |

## Risks & Notes
- R1: FTS5 搜索延迟 < 100ms（已验证，searchByScope 有索引支持）
- R2: 关键词检测可能有 false positive（宁可多搜不少搜）
- R3: SystemPromptAssembler 优先级调整需快照测试回归

## Glossary
| Term | Meaning |
|------|---------|
| **ContextEnricher** | 统一经验富化服务，根据 scope/context/budget 智能搜索和格式化历史经验 |
| **智能触发** | 基于关键词检测决定是否搜索经验，避免无谓的 token 消耗 |
| **Scope 隔离** | 每种 agent 类型只能看到自己 scope + global 的经验 |

## Appendix: Core User Stories（闭环验证）

### Story 1: Main Agent 经验注入
```
[UI] 用户发送: "上次部署失败是怎么解决的？"
[API] POST /api/agent/chat
[Exec] SystemPromptAssembler.assemble()
[Exec]   → buildExperienceSegment() 检测到关键词 "上次" + "失败"
[Exec]   → ContextEnricher.enrich({scope:'agent', query:'部署失败', budget:1200})
[Data]   → EvolutionDAO.searchByScope('部署失败', ['agent','global'], 5)
[Data]   → 返回 2 条相关经验
[Exec]   → 格式化为 markdown segment (P3.5)
[Exec] System prompt 包含经验段 → LLM 生成回答时参考历史
```

### Story 2: Harness Agent FTS5 + Daily Memory
```
[Exec] 工作流节点失败 → 检测器触发
[Exec] AgentDelegationService.delegate()
[Exec]   → HarnessPromptAdapter.assemble()
[Exec]   → loadPersona() → persona.md
[Exec]   → loadLongTermMemory() → long-term.md
[Exec]   → ★ loadDailyMemory() → daily/YYYY-MM-DD.md (新增)
[Exec]   → ★ ContextEnricher.enrich({scope:'harness', query:'syntax_error', alwaysOn:true})
[Data]   → searchByScope('syntax_error', ['harness','global'], 5)
[Data]   → 返回 3 条历史案例
[Exec]   → getSuccessStats() → 成功率数据
[Exec]   → 完整 prompt: persona + memory + daily + 历史案例 + 成功率 + 诊断报告
```

### Story 3: Workflow Agent Node 经验注入
```
[Exec] 工作流 agent 节点开始执行
[Exec] AgentExecutor.buildPrompt()
[Exec]   → KnowledgeInjector.getInjectedPrompts() → 知识规则
[Exec]   → ★ ContextEnricher.enrich({scope:'workflow', query:nodePrompt, alwaysOn:true})
[Data]   → searchByScope(query, ['workflow','global'], 5)
[Data]   → 返回相关经验
[Exec]   → prompt = 知识规则 + 经验 + 原始 prompt
```

### Story 4: 智能触发 — 不需要时不注入
```
[UI] 用户发送: "帮我创建一个新文件"
[API] POST /api/agent/chat
[Exec] SystemPromptAssembler.assemble()
[Exec]   → buildExperienceSegment() 检测关键词 → 无匹配
[Exec]   → segment = null（不搜索，不注入）
[Exec] System prompt 无经验段 → 节省 token
```

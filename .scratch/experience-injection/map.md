# Wayfinder Map — Experience Injection Paths

## Destination

所有 Agent 类型在 prompt 组装时能智能检索和注入相关历史经验，形成"写入→检索→注入→验证"的完整闭环。不是无脑注入所有经验，而是根据上下文智能匹配最相关的经验。

## Notes

### 当前状态（来自上一特性 harness-learning-platform）
- ✅ experiences 表 + FTS5 索引已就绪
- ✅ EvolutionDAO.searchByScope() 已实现
- ✅ EvolutionDAO.getSuccessStats() 已实现
- ✅ MemoryService.searchMemory() 已实现（FTS5 + 文件搜索）
- ❌ 5 个 Agent 类型中，仅 Harness 有成功率注入，FTS5 搜索全部断链

### 断链清单
| Agent 类型 | 缺失的注入 |
|-----------|-----------|
| Main Agent Chat | FTS5 experiences, FTS5 session memory |
| Clone Chat | FTS5 experiences, FTS5 session memory |
| Harness Agent | FTS5 历史案例搜索, daily memory |
| Workflow Agent Node | FTS5 experiences, memory |
| Scheduled Agent | 几乎全部（最穷的 Agent） |

### 已有基础设施（不需要重建）
- `EvolutionDAO.searchByScope(query, scope?, limit)` — FTS5 + scope 过滤
- `EvolutionDAO.getSuccessStats(org, scope, scopeRef?)` — 成功率统计
- `MemoryService.searchMemory(org, query, topK, source?)` — session memory FTS5
- `KnowledgeInjector` — 工作流知识规则注入（已工作）
- `SystemPromptAssembler` — 优先级截断系统（已工作）

## Decisions so far

_None yet — starting breadth-first grill._

## Not yet specified (Fog of War)

- 注入的 token 预算如何分配？ experiences vs memory vs skills 的优先级？
- 搜索触发的时机：每条消息都搜？还是有选择性？
- 跨 scope 可见性规则：main agent 能看 harness 经验吗？
- 经验质量衰减：旧经验是否降低权重？
- 定时 Agent 是否值得注入经验？（可能 ROI 太低）
- 经验格式化为 prompt segment 的模板设计

## Out of scope

- 向量 embedding / 语义搜索（保持 FTS5 BM25）
- 知识规则注入的改造（已工作，不动）
- 前端 UI 展示经验注入情况
- 经验的自动清理/过期机制

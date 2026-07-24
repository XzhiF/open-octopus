## Agent Clone System Refactor — 4 内置分身 + CloneRuntime + OrchestratorService 拆解

重构 Agent 模块：建立 4 个内置分身（Workspace / Scheduler / Archive / Resource）的统一体系，消除散落的聊天实现和硬编码编排逻辑。

### 核心变更

- **4 Built-in Clones**: workspace, scheduler, archive, resource — 各有独立 persona + 专属 skills
- **CloneRuntime**: 新的基础设施层（上下文组装 + Provider 封装 + 错误恢复），替代 OrchestratorService
- **Session 统一**: 扩展 MessageRow (type + metadata) + SessionRow (scope_id + provider_session_id)
- **Provider 统一**: 所有分身走 Claude Code SDK + resume + append
- **双路径 API**: 统一入口 `/api/agent/chat` (Main Agent tool-calling) + 直接入口 `/api/clones/:name/sessions/*`
- **OrchestratorService 删除**: -1,114 行，意图分类/工作流选择被 LLM 取代

### E2E Verification

| AC | Condition | Status |
|----|-----------|--------|
| AC-01 | Workspace clone responds with context | ✅ PASS |
| AC-02 | Scheduler clone handles scheduling | ✅ PASS |
| AC-03 | Main Agent delegates to correct clone | ✅ PASS |
| AC-04 | Archive clone accesses history | ✅ PASS |
| AC-05 | Resource clone installs resources | ✅ PASS |
| AC-06 | Messages support thinking/tool_call types | ✅ PASS |
| AC-07 | Claude SDK resume infrastructure | ✅ PASS |
| AC-08 | GET /api/clones returns 4 built-in | ✅ PASS |
| AC-09 | Memory write isolation | ✅ PASS |
| AC-10 | OrchestratorService deleted | ✅ PASS |

### Changed Files

```
 packages/shared/src/types/agent.ts                    — CloneDef, CloneSession, CloneMessage
 packages/server/src/db/types.ts, schema.sql, schema.ts — Schema v27 migration
 packages/server/src/db/dao/agent-session-dao.ts       — Extended methods
 packages/server/src/services/agent/clone-runtime.ts    — NEW: infrastructure layer
 packages/server/src/services/agent/builtin-clones.ts   — NEW: 4 clone definitions
 packages/server/src/services/agent/clone-init-service.ts — NEW: auto-initialization
 packages/server/src/services/archive/archive-analysis-service.ts — NEW: extracted
 packages/server/src/routes/clone/index.ts              — NEW: direct entry API
 packages/server/src/routes/agent/main-agent-route.ts   — NEW: unified entry
 packages/server/src/services/agent/orchestrator-service.ts — DELETED (-1,114 lines)
```

### Remaining

- T8 (Frontend API switch) deferred to follow-up
- Pre-existing test failures (archive-routes, config-manager) — unrelated to this refactor

<!-- MANUAL-START -->
<!-- MANUAL-END -->

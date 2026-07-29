# Requirement Brief

## Overview
将 clone 分身的记忆系统对齐 main agent 的完整记忆管线，使长期培养的专业分身拥有同等的记忆写入、归档、精炼、搜索和预算截断能力。

## Projects Involved
- [x] server (memory-service, clone-runtime, archive-scheduler, system-prompt-assembler, main-agent-route)
- [x] web-app (不改，clone 记忆通过文件树管理)

## Feature Scope
**Do:**
- Clone 获得 `record_daily` tool（复用 main agent 的，handler 按 clone context 路由路径）
- Clone daily 文件自动归档（scheduler 扫描所有 clone 目录，每个 clone 独立 `archive/`）
- Clone 记忆纳入 FTS 统一索引（`source` 字段区分 main / clone-name）
- Clone 记忆走 SystemPromptAssembler（恢复 `assembleForClone()`，获得预算截断）
- Clone long-term memory 支持 refine（归档时触发去重+截断+备份）
- Clone memory 写入加 mtime 冲突检测

**Don't:**
- 不改前端 Memory Tab（clone 记忆通过分身文件树管理）
- 不给 clone 进化工具（evolution tools 仅 main agent）
- 不改 clone 的 memoryScope 设计（shared/isolated 保持不变）

## Key Decisions
| # | Decision | Conclusion | Reason |
|---|---------|-----------|--------|
| 1 | Clone 归档方式 | 每个 clone 独立 `archive/`，scheduler 扫描所有 clone 目录 | 符合现有隔离设计，实现简单 |
| 2 | record_daily tool | 复用 main agent 的 tool + handler 按 clone context 路由 | 统一写入格式，减少重复代码 |
| 3 | FTS 索引策略 | 统一索引，`source` 字段区分来源 | 默认搜索全部，可按来源过滤 |
| 4 | 预算截断 | Clone 走 SystemPromptAssembler（恢复 `assembleForClone()`） | 完整优先级截断，长期分身必须 |
| 5 | Refine | 覆盖 clone，scheduler 归档时触发 | 长期分身需要记忆精炼 |
| 6 | 冲突检测 | `writeIsolatedMemory()` 加 mtime 冲突检测 | 防止并发覆盖 |
| 7 | 前端 UI | 不改 Memory Tab | clone 文件树已覆盖 |

## Data Model Changes
| Table | Operation | Details |
|-------|-----------|---------|
| session_memory_fts | 新增 source 列 | 区分 main / clone-name，支持按来源过滤 |

## API Contracts
| Method | Path | Side | Params | Response | Notes |
|--------|------|------|--------|----------|-------|
| GET | /memory/search | Server | q, top_k, source? | {results, degraded} | 新增可选 source 过滤参数 |
| (internal) | record_daily tool | Server | content | {ok, token_count} | handler 按 clone context 路由写入路径 |

## Acceptance Criteria
| # | User Story | AC | Verification Method |
|---|-----------|----|-------------------|
| AC1 | 分身可以记录每日记忆 | Clone 调用 record_daily → 文件写入 `{cloneDir}/memory/daily/YYYY-MM-DD.md`，FTS 插入且 source=clone-name | E2E curl + Vitest |
| AC2 | 分身记忆不写错位置 | Clone 的 record_daily 不写入 main agent 的 `memory/daily/` | E2E curl: 检查 main agent daily 目录无 clone 写入 |
| AC3 | 分身 daily 自动归档 | Scheduler 运行后，clone 过期 daily 文件移入 `{cloneDir}/memory/daily/archive/` | E2E curl + Vitest |
| AC4 | 归档触发 clone refine | Clone 归档后自动触发 refineLongTerm，生成 .bak 备份 | E2E curl |
| AC5 | Clone 记忆可搜索 | GET /memory/search 返回 clone 写入的记录，source 字段正确 | E2E curl + Vitest |
| AC6 | Clone 记忆有预算截断 | SystemPromptAssembler.assembleForClone() 对超长记忆截断，不超出 token 预算 | Vitest 单元测试 |
| AC7 | Clone 写入有冲突检测 | writeIsolatedMemory() 传过期 mtime 返回 MEMORY_CONFLICT | Vitest 单元测试 |
| AC8 | FTS source 过滤 | GET /memory/search?source=clone-name 只返回该 clone 的记录 | E2E curl |

## Verification Strategy

### Global Config
- Environment: local dev (port 3001)
- Test clone: `E2E_TEST_clone` (创建后清理)
- Data prefix: `E2E_TEST_`

### Per-layer Methods
#### Unit Tests (Vitest)
- `MemoryService.recordDaily(cloneDir, content)` — 路径路由 + FTS source 字段
- `MemoryService.writeIsolatedMemory()` — mtime 冲突检测
- `ArchiveService.archiveMemoryBatch()` — clone 目录扫描
- `SystemPromptAssembler.assembleForClone()` — 预算截断行为
- `MemoryService.searchMemory()` — source 字段过滤

#### Integration Tests (curl E2E)
- 01: 创建 clone → record_daily → 验证文件路径 + FTS
- 02: 修改文件 mtime → 触发归档 → 验证 archive/ 存在 + refine .bak
- 03: GET /memory/search → 验证 source 字段 + 过滤
- 04: writeIsolatedMemory 冲突检测 → 验证 MEMORY_CONFLICT

### Prerequisites
- [x] Server running on port 3001
- [x] Main agent memory pipeline already working (已交付)

## Risks & Notes
- R1: `assembleForClone()` 被标记为 deprecated，恢复需要重新设计参数接口
- R2: FTS schema 变更（加 source 列）需要 rebuild index，已有数据需要迁移
- R3: Scheduler 扫描 clone 目录数量随 clone 增长，性能需观察
- R4: 写入路径路由是核心正确性要求，实现时需严格校验 clone context

## Glossary (new domain terms)
| Term | Meaning |
|------|---------|
| clone context | 标识当前请求来自哪个 clone 的上下文信息（clone name + memory dir path） |
| source field | FTS 索引中区分记忆来源的字段（main / clone-name） |
| assembleForClone | SystemPromptAssembler 的 clone 专用组装方法，从 deprecated 恢复 |

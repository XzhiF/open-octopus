# Requirement Brief — Main Agent Optimization

## Overview

将 Main Agent 从半成品升级为完整的自主 Agent 工作台：Skill 可管理、进化管道自动运行、记忆系统完整可用。

## Projects Involved

- [x] `packages/server` — 后端：进化工具注册、batch processor、bug 修复
- [x] `packages/engine` — 引擎：evolution tool 定义、insight 标记存储
- [x] `packages/web-app` — 前端：Skill 详情子页面、Memory 编辑、移除 Tasks tab
- [ ] `packages/core-pack` — 更新 octo-agent-evolution skill 定义（可选）

## Feature Scope

**Do:**

- Skill 详情子页面（查看内容、编辑、diff 对比）
- 进化管道接通：Agent tool 集 + 批量处理器
- Memory 日记编辑 + refine 接服务端
- 移除 Tasks tab
- 修复 DiffViewer、经验搜索等现有 bug

**Don't:**

- 不碰 Knowledge tab（属于工作流引擎）
- 不整合两套经验系统
- 不优化 Clone 系统（上个 PR 已完成）
- 不改 Workflow Engine

## Key Decisions

| # | Decision | Conclusion | Reason |
|---|---------|-----------|--------|
| 1 | 产品方向 | 完整自主 Agent 工作台 | 用户明确要 B 方案 |
| 2 | 进化触发 | 混合：即时标记 + 批量处理 | 成本低、即时性强、批量时有候选项 |
| 3 | Skill UI | 详情子页面 | 用户希望清晰看到结构 |
| 4 | 经验系统 | 保持两套独立 | DB 给 Main Agent，文件系统给 skill-creator |
| 5 | Knowledge tab | 不碰 | 属于 Workspace 工作流引擎 |
| 6 | Tasks tab | 移除 | 与 Scheduler 重复 |
| 7 | 日记记忆 | 支持编辑 | 用户希望灵活 |
| 8 | 交付方式 | 全部拆 issue 一次交付 | 改动互相关联 |
| 9 | Agent 工具 | 注册进化工具集 | mark_insight / evolve_skill / create_experience / merge_skills / archive_skill |

## Decision Map Summary

| # | Ticket | Type | Decision |
|---|--------|------|----------|
| 01 | direction | grilling | 完整自主 Agent 工作台 |
| 02 | evolution-trigger | grilling | 混合触发 |
| 03 | skill-ui | grilling | 详情子页面 |
| 04 | experience-systems | grilling | 保持独立 |
| 05 | knowledge-tab | grilling | 不碰 |
| 06 | tasks-tab | grilling | 移除 |
| 07 | daily-memory | grilling | 支持编辑 |
| 08 | priority | grilling | 全部一次交付 |
| 09 | agent-tools | grilling | 注册工具集 |

Map: [map.md](./map.md)

## Data Model Changes

| Table | Operation | Details |
|-------|-----------|---------|
| `evolution_log` | 无变更 | 已有完整 schema，接通写入即可 |
| `experiences` | 无变更 | 已有完整 schema + FTS |
| `insight_marks` | **新建** | 存储即时标记：`{ id, skill_name, insight_text, session_id, marked_at, processed }` |

## API Contracts

| Method | Path | Side | Params | Response | Notes |
|--------|------|------|--------|----------|-------|
| `POST` | `/api/agent/evolution/mark-insight` | server | `{ skill_name, insight, session_id }` | `{ id }` | 即时标记 |
| `POST` | `/api/agent/evolution/process-marks` | server | `{ session_id? }` | `{ processed: number, results: [...] }` | 批量处理标记 |
| `GET` | `/api/agent/skills/:name` | server | — | `{ name, source, content, token_count }` | **已存在，前端需调用** |
| `PUT` | `/api/agent/skills/:name` | server | `{ content }` | `{ ok, token_count }` | **新建**：保存 skill 内容 |
| `GET` | `/api/agent/skills/:name/diff-builtin` | server | — | `{ has_diff, diff: string }` | **修复**：返回实际 diff 文本 |
| `POST` | `/api/agent/memory` | server | `{ layer: 'daily', content }` | `{ ok, token_count }` | **已存在**，前端需调用 |
| `POST` | `/api/agent/memory/refine` | server | `{ layer, content }` | `{ refined, token_count }` | **已存在**，前端需调用 |
| `GET` | `/api/agent/evolution/experiences?q=` | server | `q` | `{ experiences: [...] }` | **修复**：接通 FTS 搜索 |

## Design Specs

- Figma link: none
- Fidelity: 参考 Clone 详情子页面的布局风格

## Acceptance Criteria

| # | User Story | AC | Verification Method |
|---|-----------|----|-------------------|
| AC-1 | 作为用户，我想查看 skill 的完整内容 | 点击 skill → 进入详情页，显示 Markdown 渲染内容 | Browser E2E |
| AC-2 | 作为用户，我想编辑 skill 内容 | 详情页切换到编辑模式，保存后内容持久化 | Browser E2E + curl |
| AC-3 | 作为用户，我想看 skill 与内置版的 diff | DiffViewer 显示红/绿着色的 diff 文本 | Browser E2E |
| AC-4 | 作为用户，我想看进化日志有真实数据 | Agent 在对话中标记洞察后，进化日志 tab 显示记录 | Integration + Browser |
| AC-5 | 作为用户，我想 Agent 能自主进化 skill | Agent 调用 `evolve_skill` 后，SKILL.md 被修改，evolution_log 有记录 | Integration |
| AC-6 | 作为用户，我想编辑日记记忆 | DailyBrowser 有编辑按钮，可追加/修改内容 | Browser E2E |
| AC-7 | 作为用户，我想 Memory refine 可用 | 点击 refine 调用服务端端点，显示 before/after diff | Browser E2E |
| AC-8 | 作为用户，我不想在 Main Agent 看到 Tasks tab | Tasks tab 从导航中移除 | Manual check |
| AC-9 | 作为用户，我想搜索经验库 | 经验库搜索框输入关键词，返回 FTS 匹配结果 | Browser E2E + curl |
| AC-10 | 作为用户，我想 Agent 能批量处理标记 | 会话结束/定时触发后，所有未处理标记被批量进化 | Integration |

## Verification Strategy

### Global Config

- Environment: local dev (`pnpm dev`)
- Test user: default agent (no auth required for local)
- Data prefix: `E2E_TEST_` for test skills/memories

### Per-layer Methods

#### Unit Tests

- `EvolutionService.processMarks()` — 标记处理逻辑
- `insight_marks` 表 CRUD
- Skill save endpoint — 内容写入 + token 计算
- Diff generation — 确保返回真实 diff 文本

#### Integration Tests

- `POST /evolution/mark-insight` → `GET /evolution/marks` → `POST /evolution/process-marks` 全链路
- `PUT /skills/:name` → `GET /skills/:name` 验证内容持久化
- `POST /memory` (layer=daily) → `GET /memory/daily` 验证写入读取
- Agent tool 注册验证 — tool 列表中包含 mark_insight 等

#### Browser E2E

- Skill 详情页：列表 → 点击进入 → 查看内容 → 编辑 → 保存 → 返回列表
- DiffViewer：点击 diff 按钮 → 显示着色 diff
- DailyBrowser：点击日期 → 查看内容 → 点击编辑 → 修改 → 保存
- 进化日志：触发进化后 → 切换到进化日志 tab → 看到新记录
- Tasks tab 已移除验证

#### Manual Checklist

- [ ] Agent 在对话中能调用 `mark_insight` tool
- [ ] 批量处理后 evolution_log 有记录
- [ ] Skill 详情页三栏布局可拖拽
- [ ] 经验库搜索返回相关结果

### Prerequisites

- [ ] `pnpm build` 成功
- [ ] Dev server 运行正常
- [ ] 至少有 2 个内置 skill 可用于测试

## Risks & Notes

- R1: Agent tool 注册可能需要改动 Claude SDK plugin 机制，需确认当前 plugin 是否支持自定义 tool 注入
- R2: 批量处理的 prompt 设计需要仔细调优，避免 Agent 过度进化（每轮都改 skill）
- R3: `insight_marks` 表需要清理策略（处理完的标记是否保留历史）
- R4: Skill 详情页的 Markdown 渲染需要处理大文件性能

## Glossary

| Term | Meaning |
|------|---------|
| 进化 (Evolution) | Agent 自主发现 skill 可改进之处并执行修改的过程 |
| 经验 (Experience) | Agent 从会话中提取的有价值知识，存入 experiences 表 |
| 即时标记 (Insight Mark) | Agent 在对话中轻量记录的「这个值得进化」的信号 |
| 批量处理 (Batch Process) | 会话结束或定时时，统一处理所有未处理的 insight marks |
| Skill 进化版 (local_evolved) | 用户/Agent 修改过的本地 skill，优先于内置版加载 |

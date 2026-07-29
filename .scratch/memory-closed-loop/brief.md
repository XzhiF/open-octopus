# Requirement Brief — Memory 闭环系统

## Overview
让 Main Agent 的记忆系统（daily / long-term / session）形成完整闭环：Agent 自主判断写入有价值的 daily 记忆，联动 session 摘要，通过 archive → refine 蒸馏到 long-term，定时自动归档。

## Projects Involved
- [x] server (memory-service / main-agent-route / scheduler seed / system prompt)
- [x] web-app (MemoryTab UI 微调)
- [x] shared (类型定义)

## Feature Scope
**Do:**
- `record_daily` tool：Agent 自主调用，写入 daily memory + session 摘要
- System prompt 加入 `record_daily` 工具定义 + 正反例写入指引
- Scheduler auto-seed：server 启动时自动创建 daily-archive 定时任务（每天凌晨 3 点）
- Archive 后自动触发 refine（.bak 备份可回退）
- Agent 归档提醒：prompt assembly 检查未归档天数 > 3 天时提醒
- 删除旧 daily 测试数据（已完成）

**Don't:**
- 不做"系统任务管理"子系统（只做一条 seed）
- 不给 Agent `record_longterm` 工具（long-term 只通过蒸馏链路）
- 不改 clone memory 隔离模型（read-shared / write-isolated 保持不变）
- 不改 session compression 逻辑（复用 `record_daily` 联动写入）

## Key Decisions
| # | Decision | Conclusion | Reason |
|---|---------|-----------|--------|
| 1 | Daily 写入时机 | Agent 自主判断 + `record_daily` tool | "不是为了写而写"，只有 Agent 能判断价值 |
| 2 | Long-term 写入 | 只通过 daily → archive → refine 蒸馏 | 质量比速度重要，有过滤层保证 |
| 3 | Session 摘要写入 | `record_daily` 联动（daily + session 同时写） | 复用 Agent 判断，省额外 LLM 调用 |
| 4 | Archive 触发 | Scheduler 定时（B）+ Agent 提醒兜底（C） | 全自动 + 有人提醒 |
| 5 | Tool 参数 | `{ content: string }` 极简 | Agent 知道怎么写好 markdown |
| 6 | Prompt 写入指引 | 正反例型（✅/❌ 示例） | 最直观，给出边界感但不限制判断 |
| 7 | Refine 触发 | Archive 后自动 refine + .bak 备份 | 全自动闭环，备份可回退 |
| 8 | E2E 验证 | 自动化脚本，准备对话场景验证全链路 | 不依赖手动测试 |

## Data Model Changes
| Table | Operation | Details |
|-------|-----------|---------|
| `scheduled_tasks` | INSERT (seed) | server 启动时插入 `system:daily-archive` 任务（如不存在） |
| `messages` | INSERT | `record_daily` 联动写入 session 摘要（`is_summary=1`） |
| `daily/*.md` | WRITE | `record_daily` 追加内容到当天文件 |

## API Contracts
| Method | Path | Side | Params | Response | Notes |
|--------|------|------|--------|----------|-------|
| Tool | `record_daily` | Agent | `{ content: string }` | `{ ok: true, date: string }` | Agent tool，写 daily + session |
| POST | `/memory/archive` | Server | `{ date?: string }` | `{ ok: true, archived: bool }` | 已有，增加 archive 后自动 refine |

## Acceptance Criteria
| # | User Story | AC | Verification Method |
|---|-----------|----|-------------------|
| 1 | Agent 在对话中产生有价值的结论 | Agent 自主调用 `record_daily`，daily 文件出现新内容 | E2E: 发送有意义的对话 → 检查 daily 文件 |
| 2 | Agent 遇到简单问答 | Agent 不调用 `record_daily`，daily 文件无变化 | E2E: 发送简单问候 → 检查 daily 文件无新增 |
| 3 | `record_daily` 被调用 | session_memory_fts 出现对应摘要 | E2E: curl 搜索 session memory 验证 |
| 4 | Server 首次启动 | `scheduled_tasks` 表存在 `system:daily-archive` | Integration: curl GET /scheduler/tasks 验证 |
| 5 | Archive 执行 | long-term.md 包含从 daily 提取的内容，.bak 存在 | E2E: 手动触发 archive → 检查 long-term + .bak |
| 6 | 未归档 > 3 天 | Agent 回复开头包含归档提醒 | E2E: 模拟旧 daily 文件 → 发送对话 → 检查回复 |
| 7 | Daily memory UI | 工作记忆页面显示日期列表 + 内容 | E2E: 浏览器访问 /agent?tab=memory 验证 |

## Verification Strategy

### Global Config
- Environment: local dev (server:3001, web:3000)
- Branch: feat/main-agent-optimization
- DB: ~/.octopus/db/octopus.db

### Per-layer Methods

#### Unit Tests
- `memory-service.test.ts`: 新增 `recordDaily()` 写文件 + 写 session 逻辑测试
- `scheduler seed` 测试：验证首次启动插入、重复启动不重复插入

#### Integration Tests
- curl `POST /chat` 触发 Agent 对话 → 验证 `record_daily` tool call
- curl `GET /memory/daily` → 验证返回数组带日期
- curl `POST /memory/archive` → 验证 archive + refine 联动
- curl `GET /scheduler/tasks` → 验证 seed 任务存在

#### Automated E2E
准备对话场景脚本（`e2e-scripts/`），覆盖：
1. 有价值对话 → 期望 Agent 调用 `record_daily`
2. 简单问答 → 期望 Agent 不调用
3. Archive 全链路 → 验证 long-term 更新
4. Scheduler seed → 验证任务存在
5. 未归档提醒 → 验证 Agent 提醒

### Prerequisites
- [x] 旧 daily 数据已删除
- [ ] Server 可正常启动（port 3001）
- [ ] Claude SDK 可用（Agent 需要 LLM 能力来自主判断）

## Risks & Notes
- R1: Claude SDK 不可用时 `record_daily` 无法触发（fallback 模式下 Agent 没有 tool calling 能力）
- R2: Archive 自动 refine 可能误删有价值内容（.bak 备份兜底）
- R3: Agent 可能过于频繁调用 `record_daily`（正反例指引需要足够清晰）

## Glossary (new domain terms)
| Term | Meaning |
|------|---------|
| record_daily | Agent tool，写入 daily memory + session 摘要，Agent 自主判断调用时机 |
| 蒸馏链路 | daily → archive → refine → long-term 的单向信息提纯流程 |
| system seed task | Server 启动时自动插入的定时任务，非用户创建 |
| 归档提醒 | Agent 检测到未归档天数 > 3 时在回复开头提醒用户 |

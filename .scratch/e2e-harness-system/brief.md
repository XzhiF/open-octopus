# Requirement Brief — E2E Harness System

## Overview

将 `.scratch/` 中每次 feature 开发时重复编写的 E2E 测试脚本固化为可复用的 Hybrid Skill（代码库 + 方法指南），配合 `index.md` 索引和 STABLE/DRAFT 进化协议，让 E2E 测试从"每次从零写脚本"变为"组合稳定模块 + 只写业务断言"。

## Projects Involved

- [ ] `@octopus/web-app` — 添加 `data-testid` 属性到关键组件
- [ ] `.claude/skills/e2e-harness/` — 新建 Skill（lib/ + patterns/ + recipes/ + baselines/）
- [ ] `.claude/agents/matt-e2e-tester.md` — 修改 Agent 定义，加入 harness 自动加载

## Feature Scope

**Do:**
- 从 `.scratch/` 现有脚本中提取 6 个核心 lib/ 模块
- 为每个模块编写 self-test 和 API 文档
- 编写 3-5 个 pattern/ 指南（workspace 创建、工作流执行、弹窗交互、Tab 切换、文件树操作）
- 给 web-app 关键交互组件添加 `data-testid` 属性
- 编写 SKILL.md 使用指南 + index.md 索引
- 修改 matt-e2e-tester.md 加入 harness 检查步骤
- 编写 1 个 recipe/ 完整生命周期模板
- 编写 1 个 integration-test.mjs 全流程验证
- 实现 STABLE/DRAFT 进化协议

**Don't:**
- 不替换现有的 `packages/web-app/e2e/` Playwright 测试套件
- 不将 `.scratch/` 中的历史脚本迁移到新系统
- 不为每个已有 feature 重写 E2E 测试
- 不创建新的顶层目录（保持在 `.claude/skills/` 内）
- 不引入 Playwright test runner（保持 standalone .mjs）

## Key Decisions

| # | Decision | Conclusion | Reason |
|---|---------|-----------|--------|
| 1 | 架构形式 | Hybrid (Library + Guide) | 既有稳定代码复用，又有灵活指导处理特殊情况 |
| 2 | 代码位置 | Skill 内聚 (`.claude/skills/e2e-harness/`) | Skill 自包含、可移植、搬家也能用 |
| 3 | 进化协议 | Draft 替换 (STABLE/DRAFT) | 简单清晰只有两个状态，用户有最终决定权 |
| 4 | Pipeline 集成 | 自动加载 (Transparent) | 修改 matt-e2e-tester 定义，零手动操作 |
| 5 | 浏览器策略 | data-testid 先行 | 一劳永逸解决选择器脆弱性 |
| 6 | 验证策略 | 自测 + 集成 | 模块级 self-test + 全流程 integration-test |
| 7 | 初始范围 | 6 模块全抽 (workspace/execution/browser/reporter/api/db) | 覆盖最高频重复实现的基础设施函数 |

## Data Model Changes

无数据库变更。

## API Contracts

无新 API。使用现有 workspace/execution/file/resource API。

### 现有 API 使用清单（lib/ 模块依赖）

| 模块 | Method | Path | 用途 |
|------|--------|------|------|
| workspace.mjs | POST | `/api/workspaces` | 创建工作空间 |
| workspace.mjs | DELETE | `/api/workspaces/:id` | 删除工作空间 |
| workspace.mjs | GET | `/api/workspaces` | 列出工作空间 |
| workspace.mjs | GET | `/api/workspaces/:id` | 获取详情 |
| workspace.mjs | GET | `/api/orgs` | 获取组织列表 |
| execution.mjs | POST | `/api/workspaces/:id/executions` | 创建执行 |
| execution.mjs | POST | `/api/workspaces/:id/executions/:eid/start` | 启动执行 |
| execution.mjs | GET | `/api/workspaces/:id/executions/tree` | 获取执行树 |
| execution.mjs | POST | `/api/workspaces/:id/executions/:eid/pause` | 暂停 |
| execution.mjs | POST | `/api/workspaces/:id/executions/:eid/resume` | 恢复 |
| api.mjs | GET | `/api/health` | 健康检查 |
| db.mjs | — | SQLite direct | 执行 SQL 查询 |

## Design Specs

- Figma link: none
- Fidelity: N/A（纯基础设施，无新 UI）

## Acceptance Criteria

| # | User Story | AC | Verification Method |
|---|-----------|-----|-------------------|
| AC-1 | 作为 matt-e2e-tester，写 E2E 脚本时能自动复用稳定模块 | SKILL.md 中描述了完整的模块 API 和 import 路径；matt-e2e-tester.md 包含"先检查 e2e-harness"步骤 | 手动验证：用 matt-e2e-tester 执行一个新 feature 的 E2E，确认脚本 import 了 lib/ 模块 |
| AC-2 | workspace.mjs 能完成工作空间全生命周期 | 支持 create(name, org, repos), cleanup(id), list(), get(id)；self-test 全部 PASS | `node lib/workspace.self-test.mjs` → 4/4 PASS |
| AC-3 | execution.mjs 能执行和轮询工作流 | 支持 create(wsId, wfRef), start(wsId, execId), poll(wsId, execId, maxWait), getStatus()；self-test 全部 PASS | `node lib/execution.self-test.mjs` → 4/4 PASS |
| AC-4 | browser.mjs 能管理浏览器实例 | 支持 launch(headless), screenshot(page, name), captureConsole(page)；使用 data-testid 选择器 | `node lib/browser.self-test.mjs` → 3/3 PASS |
| AC-5 | reporter.mjs 能记录和生成报告 | 支持 record(step, pass, detail), printReport(results), saveResults(results, path)；self-test PASS | `node lib/reporter.self-test.mjs` → 3/3 PASS |
| AC-6 | api.mjs 能统一 API 调用和端口解析 | 支持 fetchJSON(url, opts), healthCheck(apiUrl), resolvePort()；从 `~/.octopus/ports/` 读取 worktree 端口 | `node lib/api.self-test.mjs` → 3/3 PASS |
| AC-7 | db.mjs 能统一 SQL 执行 | 支持 executeSQL(sql, dbPath?)；统一 3 种历史访问方式为 1 种 | `node lib/db.self-test.mjs` → 2/2 PASS |
| AC-8 | web-app 关键组件有 data-testid | 至少 20 个组件添加了 testId（对话框按钮、Tab 切换、工作空间卡片、工作流面板等） | `grep -r "data-testid" packages/web-app/components/ | wc -l` ≥ 64（现有 44 + 新增 20） |
| AC-9 | index.md 索引完整 | 列出所有模块、状态（STABLE/DRAFT）、上次验证时间、用途描述 | 目视检查 index.md 格式和内容 |
| AC-10 | Draft 协议可执行 | 修改稳定模块时自动创建 _draft 副本；self-test 通过后标记可替换；交付报告中包含替换建议 | 手动验证：故意修改 workspace.mjs → 确认 draft 创建 → self-test → 报告 |
| AC-11 | integration-test 全流程验证 | 创建 workspace → 创建 workflow → 执行 → 等待完成 → 验证结果 → 截图 → 清理 | `node tests/integration-test.mjs` → ALL PASS |
| AC-12 | patterns/ 至少 5 个场景指南 | 包含 workspace-create.md, workflow-execute.md, dialog-interact.md, tab-switch.md, file-tree-ops.md | 文件存在 + 内容包含 import 示例 + 选择器指南 |
| AC-13 | 至少 1 个 recipe/ 模板 | full-lifecycle.mjs：完整的 workspace → workflow → execute → verify → cleanup 流程 | `node recipes/full-lifecycle.mjs` 可执行 |

## Verification Strategy

### Global Config
- Environment: local dev (server:3001, web:3000) 或 worktree (port 自动解析)
- Test user: 无需认证（本地开发模式）
- Data prefix: `E2E_HARNESS_TEST_`（workspace 名 + 测试数据）

### Per-layer Methods

#### Unit Tests (模块 self-test)
每个 lib/ 模块配套 `.self-test.mjs`：
- `workspace.self-test.mjs` — create → get → list → cleanup → 验证删除
- `execution.self-test.mjs` — create execution → start → poll → 验证 completed
- `browser.self-test.mjs` — launch → navigate → screenshot → close
- `reporter.self-test.mjs` — record 3 steps → printReport → saveResults → 验证文件
- `api.self-test.mjs` — healthCheck → fetchJSON → resolvePort
- `db.self-test.mjs` — executeSQL SELECT → executeSQL INSERT/DELETE (with cleanup)

#### Integration Tests
`tests/integration-test.mjs`：
1. assertServerHealthy(apiUrl)
2. ws = createWorkspace("E2E_HARNESS_TEST_integration")
3. writeFile(ws, "test-workflow.yaml", simpleWorkflow)
4. exec = createExecution(ws, "test-workflow")
5. startExecution(ws, exec)
6. result = pollExecution(ws, exec, maxWait=60s)
7. assert result.status === "completed"
8. screenshot(page, "integration-result")
9. cleanupWorkspace(ws)
10. assertWorkspaceDeleted(ws)

#### Browser E2E
通过 `browser.self-test.mjs` 和 integration-test 覆盖：
- 浏览器启动和关闭
- 页面导航到 web-app
- data-testid 选择器工作
- 截图保存
- 控制台捕获

#### Contract Tests
不需要 — 无新 API，使用现有 API。

#### Manual Checklist
- [ ] matt-e2e-tester.md 修改后，在新 feature 的 pipeline 中确认 harness 自动加载
- [ ] index.md 格式清晰，所有模块有描述
- [ ] SKILL.md 中的示例代码可运行

### Prerequisites
- [ ] Server 和 Web App 已启动 (pnpm dev)
- [ ] Playwright 已安装 (npx playwright install chromium)
- [ ] `~/.octopus/` 目录已初始化 (octopus setup)

## Risks & Notes
- R1: web-app 组件添加 data-testid 可能影响 bundle size（极小，可忽略）
- R2: lib/ 模块依赖 `node:child_process` 执行 sqlite3 CLI，需要系统安装 sqlite3
- R3: worktree 模式下端口解析需要 `~/.octopus/ports/{branch}.json` 存在
- R4: Draft 替换协议的原子性 — 替换 stable 时如果中断，可能留下不一致状态（通过先备份后替换解决）
- R5: 现有 `.scratch/` 历史脚本不迁移 — 它们作为 feature artifact 保留原位

## Glossary (new domain terms)

| Term | Meaning |
|------|---------|
| **E2E Harness** | 混合 Skill — 预写好的可复用 lib/ 模块 + patterns/ 指南 + recipes/ 模板。解决 E2E 脚本重复和脆弱性问题。 |
| **STABLE Module** | 经过 self-test 验证的 lib/ 模块，标记为只读。matt-e2e-tester 默认 import STABLE 版本。 |
| **DRAFT Module** | 正在调试中的 lib/ 模块副本（`_draft` 后缀）。self-test 通过后，交付报告中询问用户是否替换 STABLE。 |
| **Self-Test** | 每个 lib/ 模块配套的验证脚本（`.self-test.mjs`）。验证模块核心功能正常。 |
| **Pattern Guide** | `patterns/` 目录下的 Markdown 指南，描述特定场景（弹窗交互、Tab 切换等）的最佳实践和代码模板。 |
| **Recipe** | `recipes/` 目录下的完整可执行脚本模板，组合多个 lib/ 模块。可直接运行或作为新脚本的起点。 |
| **Baseline** | `baselines/` 目录下经过验证的参考脚本，作为特定 feature 场景的黄金标准。 |

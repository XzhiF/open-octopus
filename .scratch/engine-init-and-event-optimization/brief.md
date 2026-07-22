# Requirement Brief

## Overview

工作流执行前注入 engine_init 虚拟阶段（skills/agents 精确拷贝 + 可选 git sync），并在前端对长任务节点事件做渲染截断优化（显示真实计数，只渲染最新 100 条）。

## Projects Involved

- [ ] engine (`packages/engine`) — 新增 engine_init 阶段逻辑，通过 EngineCallbacks 发射事件
- [ ] server (`packages/server`) — ExecutionLifecycle 中调用 engine_init，传递 syncMainBranch 参数，SSE 推送
- [ ] web-app (`packages/web-app`) — 执行对话框新增 Switch 控件 + ExecutionLogViewer 渲染截断

## Feature Scope

**Do:**

1. **engine_init 虚拟阶段**
   - 运行时注入，不出现在 YAML 中
   - 复用现有 EngineCallbacks（onNodeStart/onNodeLog/onNodeEnd）
   - nodeId 为 `__engine_init__`，外观与普通节点一致
   - 步骤 1：解析工作流 YAML 中引用的 skills/agents，精确拷贝到 `.claude/skills/` 和 `.claude/agents/`
   - 步骤 2（可选）：对 workspace 中每个有 worktree 的项目，pull 最新主分支并合并

2. **执行对话框 UI**
   - ExecuteNodeDialog 和 CreateNodeDialog 中新增 "同步主分支" Switch 控件
   - 默认勾选
   - 提交时作为参数传给 start API

3. **事件渲染优化**
   - ExecutionLogViewer 中每个节点组显示真实事件计数
   - 展开后只渲染最新 100 条事件
   - 纯前端截断，服务端照常推送全部事件

**Don't:**

- 不修改 YAML schema（engine_init 不是 YAML 节点）
- 不新增 SSE 事件类型（复用现有 node_start/node_log/node_end）
- 不做虚拟列表（react-virtuoso 等），只做简单 slice 截断
- 不做 "加载更多" 功能
- 不做服务端事件截断

## Key Decisions

| # | Decision | Conclusion | Reason |
|---|---------|-----------|--------|
| 1 | engine_init 定位 | 运行时注入的虚拟阶段 | 所有工作流统一行为，不需要用户配置 |
| 2 | Skills/agents 拷贝范围 | 按工作流 YAML 引用精确拷贝 | 避免冗余文件，精准匹配需求 |
| 3 | Git sync 范围 | workspace 中每个有 worktree 的项目 | 确保所有活跃项目代码最新 |
| 4 | UI 入口 | 执行对话框内 Switch 控件 | 用户在发起执行时自然看到 |
| 5 | SSE 集成 | 复用现有 EngineCallbacks | 前端 ExecutionLogViewer 无需特殊处理 |
| 6 | 事件截断层 | 纯前端截断 | 简单直接，不改变服务端行为 |
| 7 | Init 失败处理 | 分类处理 | git sync 失败=警告继续；skills 拷贝失败=终止 |
| 8 | Init 外观 | 与普通节点一致 | 统一体验，无额外 UI 开发 |

## Data Model Changes

| Table | Operation | Details |
|-------|-----------|---------|
| executions | 无变更 | syncMainBranch 参数通过 API 传入，不持久化 |

## API Contracts

| Method | Path | Side | Params | Response | Notes |
|--------|------|------|--------|----------|-------|
| POST | `/api/workspaces/:id/executions/:executionId/start` | Server | 新增 `syncMainBranch?: boolean`（默认 true） | 不变 | 控制是否执行 git sync 步骤 |

## Design Specs (if any)

- Figma link: none
- Fidelity: N/A — engine_init 节点外观与现有节点一致，Switch 控件使用现有 UI 组件

## Acceptance Criteria

| # | User Story | AC | Verification Method |
|---|-----------|----|-------------------|
| 1 | 作为用户，我执行工作流时看到 "同步主分支" 选项且默认勾选 | ExecuteNodeDialog 和 CreateNodeDialog 中出现 Switch，默认 on | 手动 E2E |
| 2 | 作为用户，工作流执行后右侧日志先显示 engine_init 节点及其步骤日志 | engine_init 节点出现在所有工作流节点之前，包含 skills 拷贝和 git sync 日志 | 手动 E2E |
| 3 | 作为用户，取消勾选 "同步主分支" 后 engine_init 跳过 git pull 步骤 | engine_init 日志中无 git sync 相关条目 | 手动 E2E |
| 4 | 作为用户，skills/agents 拷贝失败时工作流终止并显示错误 | 工作流状态为 failed，错误信息可见 | 单元测试 + 手动 E2E |
| 5 | 作为用户，git sync 失败时工作流继续执行并显示警告 | 工作流继续，engine_init 日志中有警告信息 | 单元测试 + 手动 E2E |
| 6 | 作为用户，长任务节点（200+ events）显示真实计数但只渲染最新 100 条 | 节点组标题显示如 "tool_call (237)"，展开后只有 100 条 | 单元测试（渲染截断） |
| 7 | 作为用户，事件数 ≤100 的节点不受截断影响 | 所有事件正常渲染 | 单元测试（回归） |

## Verification Strategy

### Global Config

- Environment: local dev（`pnpm dev`）
- Test user: N/A（本地运行无认证）
- Data prefix: N/A

### Per-layer Methods

#### Unit Tests

1. **engine_init 核心逻辑**
   - 测试 skills/agents 引用解析：给定 YAML，输出正确的文件列表
   - 测试拷贝逻辑：源文件存在/不存在时的行为
   - 测试 git sync：pull 成功/失败时的行为

2. **渲染截断**
   - 给定 200 条事件，验证 `slice(-100)` 后只渲染 100 条
   - 给定 50 条事件，验证全部渲染
   - 验证计数显示为真实值

#### Integration Tests

- 不适用（SSE 推送依赖完整 server 环境）

#### Browser E2E

- 手动验证（不在自动化 E2E 中覆盖）

#### Manual Checklist

- [ ] 启动 `pnpm dev`，在 web-app 中打开工作流
- [ ] 点击执行，确认 Switch 出现且默认勾选
- [ ] 执行后右侧日志出现 engine_init 节点
- [ ] engine_init 日志显示 skills 拷贝步骤
- [ ] engine_init 日志显示 git sync 步骤
- [ ] 取消勾选后重新执行，engine_init 跳过 git sync
- [ ] 执行一个有 200+ events 的长任务节点
- [ ] 确认节点组标题显示真实计数
- [ ] 确认展开后只渲染 100 条

### Prerequisites

- [ ] `pnpm install` 完成
- [ ] `pnpm build` 通过
- [ ] 至少有一个可执行的工作流 YAML

## Risks & Notes

- R1: engine_init 在 engine.run() 之前执行，需要确保 SSE 连接已建立，否则前端可能错过 init 事件
- R2: 前端当前使用轮询（2s 间隔）而非 SSE 获取事件，engine_init 阶段的短暂执行可能在两次轮询之间完成，导致用户看不到中间步骤
- R3: git sync 合并冲突的处理策略需要明确（当前假设 warn+continue）
- R4: 精确拷贝需要解析 YAML 中的 agent_file 和 skills 引用，需确认 ResourcePreFlight 是否已覆盖此逻辑可复用

## Glossary (new domain terms)

| Term | Meaning |
|------|---------|
| engine_init | 工作流执行前引擎自动注入的虚拟初始化阶段，负责资源准备和环境同步 |
| 虚拟节点 | 不出现在 YAML 中、由引擎运行时注入的节点，外观和行为与 YAML 节点一致 |
| 事件截断 | 前端对节点事件列表的渲染优化：显示真实计数但只渲染最新 N 条 |

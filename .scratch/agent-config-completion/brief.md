# Requirement Brief: Agent Config Tab Completion

## Overview
补全 Agent Config tab 的半成品功能：新增模型选择器（engine→model 两级）、补全缺失配置控件（timeout、max_clones、debug.enabled）、修复安全审计和调试日志模块的 7 个已知 BUG。

## Projects Involved
- [x] @octopus/server (BUG 修复 + API 响应增强)
- [x] @octopus/web-app (新增 UI 控件 + BUG 修复)

## Feature Scope

**Do:**
- 新增 engine→model 两级选择器，默认 claude/pro，数据来源复用 `/api/system/models`
- 补全 timeout（30–1800s）、max_clones（1–20）、debug.enabled 三个缺失控件
- 修复 DebugLogViewer 点击崩溃（skill_sources 未定义）
- 修复 DebugLogViewer 日志摘要为空（message vs summary 字段名不匹配）
- 修复 DebugLogViewer segment 详情缺少 budget/degraded 字段
- 修复 DebugLogViewer 列表选中高亮逻辑（id 缺失导致全部高亮）
- 实现安全事件写入（当前 DAO 有 insert 方法但零调用方）
- 修复 SafetyAudit 操作文本截断无展开、context 字段未渲染

**Don't:**
- 不改动系统模型页（/system/models）的功能
- 不新增 inactive_days_threshold 控件
- 不改动 Config tab 已有的 PersonaEditor、NotificationConfig、MemoryStrategyConfig、SafeModePanel
- 不考虑模型降级逻辑

## Key Decisions

| # | Decision | Conclusion | Reason |
|---|---------|-----------|--------|
| 1 | 模型选择器交互 | engine→model 两级下拉 | 用户需要先选 provider 再选 alias |
| 2 | 模型默认值 | claude / pro | 用户明确指定 |
| 3 | 模型数据来源 | 复用 GET /api/system/models | 不新增 API，解析 providers 块 |
| 4 | 缺失字段范围 | timeout + max_clones + debug.enabled | 用户选择这三个 |
| 5 | 安全审计/调试日志 | 保持现有只读设计，修复 BUG | 用户确认现状可用 |
| 6 | 验证策略 | 全自动化（Playwright E2E + API 测试） | 用户选择 |
| 7 | 后端架构修复 | misc-routes 改用 agentService 方法 | 消除直读文件 vs service 方法的重复 |

## Data Model Changes

无数据库变更。Agent config 仍存储在 `~/.octopus/agent/config.yaml`（YAML 文件）。

## API Contracts

### 需要增强的现有 API

| Method | Path | Change | Notes |
|--------|------|--------|-------|
| GET | `/api/agent/debug/log` | 响应增加 `summary`（映射自 `message`）、`id`（映射自 `chat_id`） | 修复 Bug #2, #4 |
| GET | `/api/agent/debug/assemble/:chat_id` | 响应增加 `skill_sources`、`decisions`、segments 增加 `budget` 和 `degraded` 字段 | 修复 Bug #1, #3 |
| GET | `/api/agent/safety/events` | 无变更 | 读取已存在 |

### 需要新增写入逻辑的端点

| 触发场景 | 写入方法 | 表 |
|---------|---------|---|
| 危险命令被拦截 | `safetyDAO.insertSafetyEvent()` | safety_events |
| 安全模式启用/禁用 | `safetyDAO.insertSafetyEvent()` | safety_events |
| 路径越界检测 | `safetyDAO.insertSafetyEvent()` | safety_events |

### 前端新增 API 调用

| Function | Endpoint | Used By |
|----------|----------|---------|
| `getModelConfig()` | GET `/api/system/models` | ModelSelector 组件获取可用模型列表 |

## Acceptance Criteria

| # | User Story | AC | Verification Method |
|---|-----------|----|-------------------|
| AC1 | 用户切换模型 | Config tab 显示 engine 下拉 + model 下拉，默认 claude/pro，保存后 config.yaml 更新 | E2E: 打开 Config tab → 验证默认值 → 切换 → 保存 → 验证 API 返回 |
| AC2 | 用户配置超时 | Config tab 显示 timeout 输入框（30–1800），保存生效 | E2E: 修改值 → 保存 → 刷新验证持久化 |
| AC3 | 用户配置分身数量上限 | Config tab 显示 max_clones 输入框（1–20），保存生效 | E2E: 同上 |
| AC4 | 用户开关调试模式 | Config tab 显示 debug.enabled 开关，保存生效 | E2E: 切换 → 保存 → 验证 |
| AC5 | 调试日志显示完整 | 日志列表显示摘要文本，点击展开 segment 详情不崩溃，选中高亮正确 | E2E: 点击日志条目 → 验证详情面板渲染 → 验证选中状态 |
| AC6 | 安全事件被记录 | 危险命令触发时 safety_events 表有记录，SafetyAudit 列表有数据 | API: 模拟危险命令 → 查询 safety_events 表 |
| AC7 | 安全事件显示完整 | operation 有 tooltip，context 可展开查看 | E2E: 查看事件列表 → hover 操作 → 展开详情 |
| AC8 | Segment 详情完整 | 显示 token_count/budget 和 degraded 标识 | E2E: 点击日志 → 检查 segment 详情字段 |

## Verification Strategy

### Global Config
- Environment: local dev (`pnpm dev`)
- Base URL: `http://localhost:3001` (API), `http://localhost:3000` (Web)
- Branch: `feat/main-agent-optimization`

### Per-layer Methods

#### API Integration Tests
- `GET /api/agent/debug/log` — 验证返回 `summary` 和 `id` 字段
- `GET /api/agent/debug/assemble/:chat_id` — 验证返回 `skill_sources`、segments 含 `budget`/`degraded`
- `POST /api/agent/config` — 验证 model（含 engine 前缀）、timeout、max_clones、debug.enabled 保存和读取
- 安全事件写入验证 — 通过 API 或 CLI 触发安全拦截，查询 events 列表

#### Browser E2E (Playwright)
- Config tab 全量 UI 渲染检查
- 模型选择器两级交互（engine 切换 → model 列表更新）
- 各控件保存→刷新→持久化验证
- DebugLogViewer 点击展开、选中高亮
- SafetyAudit 列表渲染、operation tooltip、context 展开

### Prerequisites
- [ ] 本地 dev server 运行中
- [ ] 至少有一条 agent chat session（产生 debug trace）
- [ ] 至少触发一次安全事件（验证 SafetyAudit）

## Bugs to Fix (Detailed)

| # | Bug | File | Root Cause | Fix |
|---|-----|------|-----------|-----|
| B1 | DebugLogViewer 点击崩溃 | `DebugLogViewer.tsx:105` | `skill_sources` 未定义 | 前端加 `?? {}` + 后端补字段 |
| B2 | 日志摘要为空 | `DebugLogViewer.tsx:23` | 读 `summary` 但 JSONL 写 `message` | misc-routes 映射 message→summary |
| B3 | Segment 缺 budget/degraded | `DebugLogViewer.tsx:95-97` | `getSegments()` 返回原始数据未经 `truncateToBudget()` | 后端调用 truncateToBudget 对比原始 |
| B4 | 选中高亮全部 | `DebugLogViewer.tsx:64` | 比较 `id` 但两端都无 `id` | 改用 `chat_id` 比较 |
| B5 | 安全事件从未写入 | 全局 | DAO insert 方法零调用方 | 在拦截点插入事件 |
| B6 | 操作文本截断无展开 | `SafetyAudit.tsx:46` | CSS truncate 无 tooltip | 加 `title` + 可展开详情 |
| B7 | Context 字段未渲染 | `SafetyAudit.tsx:41-53` | 组件忽略 context 字段 | 添加折叠面板渲染 context |

## Risks & Notes
- R1: misc-routes.ts 直读 JSONL 文件绕过了 agentService，建议统一走 service 方法以消除重复
- R2: 安全事件写入需要确定在 chat-routes 的哪个阶段调用（命令执行前检测 vs 执行后记录）
- R3: 模型选择器需要解析 models.yaml 的 providers 块，需处理 YAML 格式异常

## Glossary (new domain terms)

| Term | Meaning |
|------|---------|
| engine | models.yaml 中的 provider 名称（如 claude、pi），代表 AI 服务提供商 |
| model alias | provider 下的模型别名（pro-max、pro、se），映射到实际模型 ID |
| debug trace | JSONL 格式的调试追踪文件，记录每次 chat 的 orchestration/intent/workflow 信息 |
| safety event | 安全审计事件，记录危险命令拦截、安全模式切换等安全相关操作 |

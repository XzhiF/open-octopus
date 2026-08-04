# Spec: Octopus Agent UI Wiring + Schema Docs

## Problem Statement
octopus_agent 节点在 React Flow 中已有组件骨架（StatusShell + TypeShell + heartbeat UI），但关键数据流未接通：
1. **ObservabilityService.filterEvent()** 过滤掉 heartbeat/harness_directive/heartbeat_stall 事件，导致这些事件永远不会持久化到 SQLite，REST API 也查不到
2. `statusOverlay` 构建逻辑从不设置 `heartbeat` 属性，OctopusAgentNode 读到的永远是 `undefined`
3. `getExecutorType()` 没有 `octopus_agent` case，octopus_agent 步骤被误分类为 `agent`
4. `NodeInfoDialog` 没有 `octopus_agent` 分支，打开后空白
5. `OctopusAgentDetailTabs` 组件不存在
6. `ExecutionLogViewer` 对 heartbeat/directive/stall 事件只有 fallback 渲染
7. octo-workflow-dev 参考文档未同步 octopus_agent 节点定义和 requires 新类型

## Solution
1. 修复 ObservabilityService 事件过滤，让 heartbeat 类事件持久化
2. 扩展 StatusOverlay/AgentEventsResponse 类型，通过 HTTP 轮询接通 heartbeat 数据
3. 修复 getExecutorType() 添加 octopus_agent case
4. 新建 OctopusAgentDetailTabs 组件
5. 为 ExecutionLogViewer 添加 3 种专属事件渲染
6. 同步 node-schema.md 和 requires-and-effort.md 参考文档
7. 创建最小验证工作流 + Playwright E2E 测试

## Projects Involved
- [x] web-app (React Flow 节点、详情面板、日志渲染、类型扩展)
- [x] server (ObservabilityService 修复、agent-events API 增强)
- [x] octo-workflow-dev skill (参考文档更新)

## Feature Scope
**Do:**
- 修复 ObservabilityService.filterEvent() 不再过滤 heartbeat 类事件
- 扩展 StatusOverlay 和 AgentEventsResponse 类型支持 heartbeat
- 修复 getExecutorType() 添加 octopus_agent case
- 接通 heartbeat 数据流到 OctopusAgentNode
- 新建 OctopusAgentDetailTabs 组件
- 添加 heartbeat/harness_directive/heartbeat_stall 事件渲染
- 更新 node-schema.md（添加 octopus_agent + requires 完整类型）
- 更新 requires-and-effort.md（添加 commands/rules/clones）
- 创建 E2E 测试工作流 + Playwright 截图验证

**Don't:**
- 不实现 heartbeat_stall 的生产端（checkStall() 存在但无调用者，需要引擎改动，本次范围外）
- 不修改 Zod workflow schema（已完整）
- 不改变 SSE 架构（不添加新的 SSE listener）
- 不重构 AgentDetailTabs（OctopusAgentDetailTabs 是独立组件）

## Key Decisions
| # | Decision | Conclusion | Reason |
|---|---------|-----------|--------|
| D1 | Schema 产出格式 | Markdown 参考文档更新 | 项目用 Zod 作 source of truth，不需要独立 JSON Schema |
| D2 | octopus_agent YAML 字段 | 现有 Zod schema 够用 | model/engine/effort 通过 Common Fields 继承，无需额外字段 |
| D3 | skills 字段 | 不暴露 | clone 的 CWD 不在 workspace 目录，外部 skills 无法注入 |
| D4 | heartbeat 数据接通 | HTTP 轮询 | 复用现有 useExecutionEvents 机制，2s 延迟可接受，保持前端架构一致性 |
| D5 | 节点详情面板 | 新建 OctopusAgentDetailTabs | 独立组件更清晰，可扩展 octopus 专属信息 |
| D6 | 日志事件渲染 | 3 个专属 case | Activity 图标给 heartbeat，AlertTriangle 给 directive/stall |
| D7 | E2E 测试 | 最小验证工作流 | 1-2 个 octopus_agent 节点，验证 UI 渲染，不依赖复杂业务流程 |
| D8 | 版本管理 API | **已在 main 分支修复** | Walk-Through 确认路由已正确挂载，无需修改 |
| D9 | requires 文档 | 补充 3 种新类型 | commands/rules/clones 已在 Zod 和 engine-init 中支持 |
| D10 | ObservabilityService 修复 | 移除 filterEvent 对 heartbeat 类事件的过滤 | 这是 heartbeat 数据能持久化和通过 API 返回的前提 |
| D11 | getExecutorType 修复 | 在 model 检查前添加 octopus_agent case | 避免 octopus_agent 被误分类为 agent |
| D12 | "信息" tab 数据来源 | 从 StepExecution 扩展字段获取 | NodeInfoDialog 接收 StepExecution，需要扩展其类型以包含 agent/version/task 信息 |
| D13 | heartbeat_stall 事件 | 仅添加 UI 渲染，不实现生产端 | checkStall() 存在但无调用者，引擎改动超出本次范围 |
| D14 | AgentEvent 类型扩展 | 扩展前端 AgentEvent 联合类型 | 添加 heartbeat/directive/stall 的 typed payload |

## User Stories
1. As a 用户，I want octopus_agent 节点在执行时展示 heartbeat 进度（step/token/activity），so that 我能实时了解 delegate agent 的执行状态
2. As a 用户，I want 点击 octopus_agent 节点打开详情面板（追踪 + 成本 + 信息），so that 我能查看 per-turn 的执行细节和 agent 版本信息
3. As a 用户，I want 执行日志中 heartbeat/directive/stall 事件有专属图标和样式，so that 我能快速识别这些关键事件
4. As a 工作流开发者，I want node-schema.md 包含 octopus_agent 节点的完整字段文档，so that 我能正确编写 octopus_agent 工作流
5. As a 工作流开发者，I want requires-and-effort.md 包含 commands/rules/clones 的文档，so that 我知道如何在 requires 中声明这些资源
6. As a QA，I want 通过 Playwright E2E 测试验证 octopus_agent 节点的 UI 渲染，so that 我能确保功能端到端可用

## Implementation Decisions

### 模块涉及

| 模块 | 改动类型 | 文件 |
|------|---------|------|
| server / observability | 修改 | `ObservabilityService.ts`（移除 filterEvent 对 heartbeat 类事件的过滤） |
| server / routes | 修改 | `routes/execution.ts`（agent-events API 返回 heartbeat 快照） |
| web-app / types | 修改 | `lib/types.ts`（StatusOverlay 添加 heartbeat，AgentEvent 扩展类型） |
| web-app / hooks | 修改 | `use-execution-events.ts`（从事件流提取最新 heartbeat） |
| web-app / workflow-nodes | 修改 | `workflow-flow-viewer-with-status.tsx`（heartbeat 注入 statusOverlay） |
| web-app / workflow-nodes | 修改 | `workflow-detail-panel.tsx`（getExecutorType 添加 octopus_agent） |
| web-app / node-detail | **新建** | `octopus-agent-detail-tabs.tsx` |
| web-app / node-detail | 修改 | `node-info-dialog.tsx`（添加 octopus_agent case） |
| web-app / execution-log-viewer | 修改 | `execution-log-viewer.tsx`（3 个事件 case + 图标导入） |
| skill / references | 修改 | `node-schema.md`（octopus_agent + requires 完整类型） |
| skill / references | 修改 | `requires-and-effort.md`（commands/rules/clones） |
| e2e | **新建** | 测试工作流 YAML + Playwright 测试文件 |

### 数据流变更

#### heartbeat 接通流程（修复后）
```
Server: onAgentEvent → heartbeat event
    ├─ ObservabilityService.filterEvent() ← 修复：不再过滤 heartbeat
    ├─ agent_events table (persist) ← 现在能持久化了
    ├─ SSE emit agent_heartbeat ← 已有
    └─ heartbeats.jsonl ← 已有

Web-app: useExecutionEvents (2s poll) → GET /agent-events
    ├─ 返回 events[] ← 现在包含 heartbeat 事件
    ├─ 返回 heartbeat? ← 新增：最新 heartbeat 快照
    └─ 返回 loopIterations? ← 已有

workflow-flow-viewer-with-status.tsx:
    读取 agent-events 响应 → 提取 heartbeat → 注入 statusOverlay.heartbeat

OctopusAgentNode:
    读取 statusOverlay.heartbeat → 渲染 step/token/activity
```

#### agent-events API 变更
现有 API 返回结构。需增加 heartbeat 快照：

```typescript
{
  events: AgentEvent[],        // 现有（现在包含 heartbeat 类事件）
  heartbeat?: AgentHeartbeat,  // 新增：最新 heartbeat 快照
  loopIterations?: {...}       // 现有
}
```

#### StatusOverlay 类型扩展
```typescript
interface StatusOverlay {
  stepStatus: StepExecutionStatus
  duration?: number
  startedAt?: string
  error?: string
  tokenUsage?: TokenUsage
  tokenUsages?: TokenUsage[]
  heartbeat?: AgentHeartbeat  // 新增
}
```

### OctopusAgentDetailTabs 结构

```typescript
interface OctopusAgentDetailTabsProps {
  executionId: string
  nodeId: string
  agentName?: string
  version?: string
}

// 三个 tab：
// 1. 追踪 (AgentTimeline 复用) — per-turn thinking/tool/text
// 2. 成本 (CostLine + per-model breakdown)
// 3. 信息 (agent name, version, task brief, heartbeat history)
```

### 日志事件渲染设计

| 事件 | 图标 | 颜色 | 标签格式 |
|------|------|------|---------|
| `heartbeat` | `Activity` | rose-500 | `心跳: Step {n} · {tokens} tokens · {activity}` |
| `harness_directive` | `AlertTriangle` | 红色(abort)/黄色(pause) | `指令: {type} — {reason}` |
| `heartbeat_stall` | `AlertTriangle` | orange-500 | `停滞检测: 超过 {timeout}s 无心跳` |

## Data Model Changes
无 schema 变更。heartbeat 数据已通过 `agent_events` 表持久化（event_type='heartbeat'）。

## API Contracts

| Method | Path | Side | 变更 |
|--------|------|------|------|
| GET | `/api/workspaces/:id/executions/:execId/agent-events` | Server | 响应增加 `heartbeat?: AgentHeartbeat` 字段 |
| GET-POST | `/api/agents/:name/versions/*` | Server | 修复 mount（路由已存在） |
| GET-POST | `/api/agents/main/versions/*` | Server | 修复 mount（路由已存在） |

## Verification Strategy

### Verification Environment
| Item | Value |
|------|-------|
| Environment | local dev: `pnpm dev --isolated` |
| API prefix | `/api/` |
| Database | SQLite: `~/.octopus/db/octopus.db` |
| Web UI | `http://localhost:3000` |
| Server | `http://localhost:3001` |

### Test Users & Data
| Item | Value |
|------|-------|
| Test workspace | `E2E_TEST_octopus_agent` |
| Test workflow | `workflows/e2e-octopus-agent-test.yaml` |
| Clone dependency | built-in `workspace` clone |
| Data prefix | `E2E_TEST_` |
| Cleanup | DELETE workspace after test |

### AC to Verification Method Mapping
| US# | User Story | AC | Verification Level | Verification Method |
|-----|-----------|-----|-------------------|---------------------|
| US-1 | heartbeat 展示 | AC-1: heartbeat 事件持久化到 agent_events | Integration | 查询 agent_events 表确认 event_type='heartbeat' 存在 |
| US-1 | heartbeat 展示 | AC-2: agent-events API 返回 heartbeat 字段 | Integration | curl 断言响应包含 heartbeat 对象 |
| US-1 | heartbeat 展示 | AC-3: 节点执行时 heartbeat 信息可见 | Browser E2E | Playwright 截图断言 heartbeat 区域存在 |
| US-1 | heartbeat 展示 | AC-4: step/token 数值正确展示 | Browser E2E | Playwright 断言文本内容匹配 |
| US-2 | 详情面板 | AC-5: getExecutorType 返回 octopus_agent | Unit | 单元测试断言 nodeType=octopus_agent 时返回正确值 |
| US-2 | 详情面板 | AC-6: 点击节点打开 OctopusAgentDetailTabs | Browser E2E | Playwright 点击 + 截图断言 tab 可见 |
| US-2 | 详情面板 | AC-7: 追踪 tab 展示 per-turn 事件 | Browser E2E | Playwright 切换 tab + 截图 |
| US-2 | 详情面板 | AC-8: 信息 tab 展示 agent/version/task | Browser E2E | Playwright 切换 tab + 断言文本 |
| US-3 | 日志事件渲染 | AC-9: heartbeat 事件有 Activity 图标 | Browser E2E | Playwright 截图断言图标存在 |
| US-3 | 日志事件渲染 | AC-10: directive 事件有 AlertTriangle 图标 | Browser E2E | Playwright 截图断言 |
| US-3 | 日志事件渲染 | AC-11: stall 事件有橙色警告样式 | Browser E2E | Playwright 截图断言 |
| US-4 | node-schema 文档 | AC-12: octopus_agent 节点类型文档完整 | Manual | 文档审查 — 所有字段已列出 |
| US-5 | requires 文档 | AC-13: commands/rules/clones 文档完整 | Manual | 文档审查 — 三种类型已列出 |
| US-6 | E2E 测试 | AC-14: Playwright 测试可重复执行 | Browser E2E | 连续 2 次执行均 PASS |
| US-6 | E2E 测试 | AC-15: 截图证据保存在 e2e-screenshots/ | Browser E2E | 目录中有截图文件 |
| — | ObservabilityService 修复 | AC-16: filterEvent 不再过滤 heartbeat | Unit | 单元测试断言 heartbeat 事件通过过滤 |

### Verification Methods Detail

#### Unit Tests
- ObservabilityService.filterEvent() 不再过滤 heartbeat 类事件
- getExecutorType() 对 octopus_agent 返回正确值
- OctopusAgentDetailTabs 组件渲染测试（props 传入后 3 个 tab 均可切换）
- EventIcon/EventLabel 对 3 种新事件类型的返回值测试

#### Integration Tests
- agent-events API 返回 heartbeat 字段（执行含 octopus_agent 的工作流后查询）
- heartbeat 事件持久化验证（执行后查询 agent_events 表）

#### Browser E2E
- Playwright 脚本：
  1. 创建 E2E_TEST_octopus_agent workspace
  2. 在 workflows/ 目录写入测试 YAML
  3. 打开 workflow viewer，截图节点渲染
  4. 执行工作流，等待完成
  5. 截图执行状态（heartbeat/timer/token）
  6. 点击节点打开详情面板，截图各 tab
  7. 打开日志查看器，截图事件渲染
  8. 清理测试 workspace

#### Manual Checklist
- AC-12: 审查 node-schema.md 完整性
- AC-13: 审查 requires-and-effort.md 完整性

### Anti-Fake-Run Standards (R1-R8)
| # | Criterion | Description |
|---|-----------|-------------|
| R1 | Real service | Playwright 连接 localhost:3000 真实运行的 web-app |
| R2 | Business data | 断言 heartbeat 文本中包含具体数值（非空检查） |
| R3 | Cross-validation | API 返回 heartbeat ↔ UI 展示 heartbeat 一致 |
| R4 | Evidence | 截图 + API response body |
| R5 | Side effects | POST publish version → GET versions 列表包含新版本 |
| R6 | Real user path | 通过 UI 操作，不直接调 API |
| R7 | Data isolation | E2E_TEST_ 前缀 |
| R8 | Repeatable | 测试包含 setup + teardown，可重复执行 |

### Prerequisites
- [ ] `pnpm dev --isolated` 运行中（server:3001, web:3000）
- [ ] built-in `workspace` clone 可用
- [ ] Playwright 已安装（`npx playwright install chromium`）

## Risks & Notes
- R1: heartbeat 轮询 2s 延迟，快速心跳场景下可能丢失中间状态（可接受，heartbeat 本身就是采样）
- R2: OctopusAgentDetailTabs 复用 AgentTimeline 组件，如果 AgentTimeline 接口变更需要同步
- R3: heartbeat_stall 事件生产端未实现（checkStall() 无调用者），UI 仅做渲染准备，实际不会触发
- R4: "信息" tab 数据来源需要确认 — StepExecution 可能不包含 agent/version/task 信息，可能需要从 node data 透传

## Glossary (new domain terms)
| Term | Meaning |
|------|---------|
| StatusOverlay | 节点执行状态覆盖层（stepStatus, duration, tokenUsage 等） |
| AgentHeartbeat | octopus_agent 专属心跳数据（step, tokens_used, artifacts, confidence） |
| HarnessDirective | 引擎发出的中止/暂停指令（abort/pause） |

## Appendix: Core User Stories（闭环验证）

### Story 1: heartbeat 实时展示
1. [Exec] OctopusAgentExecutor 执行，HeartbeatHandler 生成 heartbeat 事件
2. [Event] `onAgentEvent` 回调触发
3. [Data] **修复后**: ObservabilityService.filterEvent() 不再过滤 → heartbeat 事件持久化到 agent_events 表
4. [API] `GET /agent-events` 返回 events 数组（含 heartbeat）+ 顶层 heartbeat 快照
5. [UI] useExecutionEvents 轮询，提取 heartbeat 数据
6. [UI] workflow-flow-viewer-with-status 将 heartbeat 注入 statusOverlay
7. [UI] OctopusAgentNode 读取 statusOverlay.heartbeat，渲染 Step N / tokens / activity
8. [UI] 执行完成后，TypeShell 展示 duration + tokenUsage

### Story 2: 详情面板
1. [UI] 用户右键 octopus_agent 节点 → "查看信息"
2. [UI] **修复后**: getExecutorType() 在 model 检查前先判断 nodeType === "octopus_agent"，返回 "octopus_agent"
3. [UI] NodeInfoDialog 匹配 executorType="octopus_agent" 分支
4. [UI] OctopusAgentDetailTabs 渲染，默认显示"追踪" tab
5. [UI] 追踪 tab 展示 AgentTimeline（per-turn thinking/tool/text）
6. [UI] 切换到"成本" tab，展示 CostLine + per-model breakdown
7. [UI] 切换到"信息" tab，展示 agent name, version, task brief（数据来源：StepExecution 扩展字段或 node data）

### Story 3: 日志事件渲染
1. [Exec] octopus_agent 执行产生 heartbeat、harness_directive 事件
2. [Data] **修复后**: 事件持久化到 agent_events 表（不再被 filterEvent 过滤）
3. [API] `GET /agent-events` 返回包含这些事件的列表
4. [UI] ExecutionLogViewer 渲染事件：
   - heartbeat → Activity 图标(rose) + "心跳: Step N · tokens · activity"
   - harness_directive → AlertTriangle(红/黄) + "指令: abort/pause — reason"
   - heartbeat_stall → AlertTriangle(橙) + "停滞检测: 超过 Ns 无心跳"
5. **Note**: heartbeat_stall 生产端未实现（checkStall 存在但无调用者），UI 仅做渲染准备

### Story 4: 文档同步
1. [Doc] node-schema.md 添加 octopus_agent 章节（所有专属字段 + 继承的通用字段说明）
2. [Doc] node-schema.md RequiresDef 添加 commands/rules/clones 字段
3. [Doc] requires-and-effort.md 添加 commands/rules/clones 使用说明和示例
4. [Doc] node-schema.md type enum 列表添加 octopus_agent

### Story 5: ObservabilityService 修复（前置依赖）
1. [Code] 定位 ObservabilityService.filterEvent() 中过滤 heartbeat/harness_directive/heartbeat_stall 的逻辑
2. [Code] 移除或调整过滤条件，让这些事件通过持久化流程
3. [Test] 单元测试：断言 heartbeat 事件不会被过滤
4. [Verify] 执行 octopus_agent 工作流后，查询 agent_events 表确认事件存在

### Story Gap Fixes（Walk-Through 发现的断点修复）

| BP ID | 问题 | 修复方案 | 对应 AC |
|-------|------|---------|---------|
| BP-1A/BP-3K | filterEvent 过滤 heartbeat 类事件 | Story 5: 修改 ObservabilityService | AC-1, AC-16 |
| BP-1B | AgentEventsResponse 缺 heartbeat 字段 | 扩展类型定义 | AC-2 |
| BP-1C | heartbeats.jsonl 无人读取 | agent-events API 从 agent_events 表读取（修复 filterEvent 后可用） | AC-2 |
| BP-1D | statusOverlay 从不设置 heartbeat | workflow-flow-viewer-with-status 注入 | AC-3 |
| BP-1E | StatusOverlay 接口缺 heartbeat | 扩展 types.ts | AC-3 |
| BP-2F | getExecutorType 无 octopus_agent case | 添加 case（在 model 检查前） | AC-5 |
| BP-2G | NodeInfoDialog 无 octopus_agent 分支 | 添加条件分支 | AC-6 |
| BP-2H | OctopusAgentDetailTabs 不存在 | 新建组件 | AC-6, AC-7, AC-8 |
| BP-3L | 前端 AgentEvent 缺 heartbeat 类型 | 扩展联合类型 | AC-9 |
| BP-3M | EventIcon/EventLabel 缺 3 个 case | 添加 case + 图标导入 | AC-9, AC-10, AC-11 |

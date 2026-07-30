# Requirement Brief: Workflow Test 优化 — 直跑优先 + SSE 事件转发

## Overview
优化 `octopus workflow test` 命令：有 fixture 时直跑模拟器（<2s），无 fixture 时才走 agent；同时修复 Server 委托路径的 SSE 事件转发，让 agent 路径的工具调用和结果对 CLI 用户可见。

## Projects Involved
- [ ] `packages/cli` (核心 — `workflow test` 命令重构 + 增强输出 + `--fix` 参数)
- [ ] `packages/server` (修复 `main-agent-route.ts` 委托路径 SSE 事件转发)
- [ ] `packages/engine` (无改动 — 复用现有 `runTestSuite` API)

## Feature Scope

**Do:**
- L1: `workflow test` 直跑优先 — 有 `.test.yaml` 时直接调用 `runTestSuite()`，跳过 Server/Agent
- L1: 增强直跑输出 — Phase 标题（语法检查/模拟/断言）、失败时显示 `--fix` 建议
- L1: `--fix` 参数 — 强制走 agent 路径，智能修复 fixture（复用 `octo-workflow-test` skill）
- L2: SSE 智能过滤 — 委托路径转发 `text_delta` + `tool_call` + `tool_result` + `error`
- L2: CLI 渲染增强 — agent 路径下正确显示工具调用名称/参数和工具结果

**Don't:**
- 改动模拟器引擎本身（`runTestSuite` API 不变）
- 改动 `octo-workflow-test` skill 内容
- Web UI 集成
- 修改 `simulate` 命令（保持不变）

## Key Decisions

| # | Decision | Conclusion | Reason |
|---|---------|-----------|--------|
| 1 | 优化范围 | L1 (test 架构) + L2 (SSE 转发) 一起做 | L2 是平台级基础设施，改了所有委托场景受益 |
| 2 | 执行策略 | 直跑优先 (A) — 有 fixture 走模拟器，无 fixture 走 agent | 有 fixture 时 <2s 出结果，无需 LLM；无 fixture 时 agent 智能生成合理 |
| 3 | SSE 转发策略 | 智能过滤 — 转发 text_delta + tool_call + tool_result + error | thinking 太长是噪音，message 边界对 CLI 无意义 |
| 4 | 直跑输出 | 增强输出 — Phase 标题 + 失败建议 + 更丰富统计 | `test` 定位为"测试助手"，比 `simulate` 底层工具应有更多上下文 |
| 5 | 修复引导 | 提示建议 (A) — 失败后打印 `--fix` 提示，不自动升级 | 避免意外消耗 LLM token，保持命令行为可预测 |

## API Contracts

### CLI 命令变更

```
octopus workflow test <yaml-path> [options]

行为变更:
  有 .test.yaml → 直跑模拟器 (<2s, 无 Server 依赖)
  无 .test.yaml → 委托 workspace clone (需要 Server)

新增 Options:
  --fix                强制走 agent 路径，智能修复/生成 fixture
  --org <org>          组织名 (已有)

输出格式 (直跑模式):
  Testing: my-workflow.yaml
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  
  📋 Phase 1: Syntax Check
    ✔ bash-1: syntax OK
    ✔ python-1: syntax OK
  
  ⚙️ Phase 2: Simulation
    ✔ Scenario "happy path"
      ✔ agent-1: completed [mocked, 0ms]
      ✔ condition-1: completed [real, case 0 → "process"]
      ✔ bash-1: completed [mocked]
  
  ✅ Phase 3: Assertions
    ✔ status = completed
    ✔ vars.result = "expected"
    ✔ node_trace: [agent-1, condition-1, bash-1]
  
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Results: 1 passed, 0 failed (1 scenario, 15ms)

输出格式 (直跑失败):
  ... (同上，✖ 替代 ✔)
  Results: 0 passed, 1 failed (1 scenario, 12ms)
  💡 Run with --fix to auto-fix via AI agent

输出格式 (agent 路径，SSE 增强后):
  Testing: my-workflow.yaml
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ⏳ Workspace clone is analyzing workflow...
  
  🔧 Read {path: "...workflow.yaml"}
  🔧 Write {path: "...test.yaml"}
  🔧 Bash "pnpm exec octopus workflow simulate --json"
  
  [agent 最终总结文本]
  
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

### Server SSE 事件转发变更

```typescript
// packages/server/src/routes/agent/main-agent-route.ts
// 委托路径的事件转发逻辑变更:

// Before (只转发 text_delta + error):
for await (const chunk of runtime.chat(...)) {
  if (chunk.type === 'text_delta') { await stream.writeSSE(...) }
  else if (chunk.type === 'error') { await stream.writeSSE(...) }
}

// After (智能过滤):
for await (const chunk of runtime.chat(...)) {
  switch (chunk.type) {
    case 'text_delta':   // → 转发 (已有)
    case 'tool_call':    // → 新增转发
    case 'tool_result':  // → 新增转发
    case 'error':        // → 转发 (已有)
      await stream.writeSSE({ event: chunk.type, data: ... })
      break
    // thinking, message_start, message_stop → 静默丢弃
  }
}
```

## Acceptance Criteria

| # | User Story | AC | Verification Method |
|---|-----------|----|-------------------|
| 1 | 开发者有 .test.yaml，运行 `test` | 直跑模拟器，<2s 出结果，不连接 Server | 手动: 创建 fixture → `time octopus workflow test wf.yaml` → 检查耗时 |
| 2 | 开发者看到直跑输出 | 显示 3 个 Phase 标题 + 逐项结果 | 手动: 检查输出包含 "Phase 1/2/3" |
| 3 | 直跑测试失败 | 显示失败详情 + `💡 Run with --fix` 提示 | 手动: 创建错误 fixture → 检查输出包含建议 |
| 4 | 开发者运行 `test --fix` | 走 agent 路径，agent 修复 fixture 并重跑 | 手动: `octopus workflow test wf.yaml --fix` → agent 介入 |
| 5 | 无 .test.yaml，运行 `test` | 走 agent 路径，agent 生成 fixture + 运行 | 手动: 删除 fixture → `test` → agent 生成 |
| 6 | Agent 路径中 CLI 显示工具调用 | 🔧 工具名 + 参数可见 | 手动: 观察 agent 路径输出包含 🔧 Read/Write/Bash |
| 7 | Server 委托转发 tool_call 事件 | `tool_call` SSE 事件到达 CLI | 手动/单元测试: 检查 SSE 流包含 tool_call 事件 |
| 8 | Server 委托过滤 thinking 事件 | `thinking` 事件不到达 CLI | 单元测试: 检查 shouldForwardEvent('thinking') = false |
| 9 | `simulate` 命令不受影响 | 行为不变 | 手动: `octopus workflow simulate wf.yaml` 输出不变 |

## Verification Strategy

### Per-layer Methods

#### Unit Tests
- `shouldForwardEvent(eventType)` 函数: 各事件类型的转发/过滤判定
- CLI `discoverTestFixture()` 逻辑: 有/无 fixture 的路径分支

#### Integration Tests
- 对 `packages/core-pack/workflows/xzf-dev.yaml` + 其 test fixture 运行直跑模式
- 对无 fixture 的工作流运行 agent 路径（需 Server）

#### Manual Checklist
| # | 场景 | 操作 | 预期 |
|---|------|------|------|
| 1 | 有 fixture 直跑 | `octopus workflow test xzf-dev.yaml` | <2s, Phase 标题, 无 Server 连接 |
| 2 | 无 fixture agent | 删除 .test.yaml → `test` | Agent 生成, 🔧 事件可见 |
| 3 | 直跑失败 | 故意写错 fixture → `test` | ✖ 结果 + --fix 提示 |
| 4 | --fix 修复 | `test --fix` | Agent 介入修复 |
| 5 | simulate 不变 | `simulate xzf-dev.yaml` | 输出格式无变化 |

### Prerequisites
- [ ] `pnpm build` 成功
- [ ] Server 运行中（agent 路径测试需要）
- [ ] 已有 `xzf-dev.yaml` 的 `.test.yaml` fixture（直跑路径测试）

## Changed Files 预估

| Package | File | Change Type | 说明 |
|---------|------|-------------|------|
| cli | `commands/workflow.ts` | 重构 | `test` 命令: fixture 检测 → 直跑/agent 分支 + `--fix` + 增强输出 |
| server | `routes/agent/main-agent-route.ts` | 修改 | 委托路径增加 `tool_call` + `tool_result` 事件转发 |
| cli | `commands/workflow.ts` | 新增 | `renderDirectTestResult()` 增强输出渲染函数 |

## Risks & Notes

- **R1: 直跑路径绕过 Server** — 直跑模式不经过 Server，意味着 Server 不会记录测试执行的 session/message。这是预期的：直跑是纯本地操作。
- **R2: `--fix` 需要 Server** — `--fix` 走 agent 路径，需要 Server 运行中。如果 Server 未启动，显示与当前相同的错误提示。
- **R3: SSE 事件格式兼容** — 新增的 `tool_call` / `tool_result` 事件可能影响已有的 SSE 消费者（Web UI）。需要确认 Web UI 的 SSE 监听器不会被未知事件类型干扰。
- **R4: Claude SDK tool_result 可用性** — `tool_result` 事件依赖 `PostToolUse` hooks 的 `toolResultQueue`。需确认委托路径下 hooks 正常工作。

## Glossary (new domain terms)

| Term | Meaning |
|------|---------|
| **直跑模式** | `workflow test` 直接调用 `runTestSuite()` 而不经过 Server/Agent，当 `.test.yaml` 存在时使用 |
| **Agent 路径** | `workflow test` 通过 Server 委托 workspace clone 执行，当无 fixture 或使用 `--fix` 时使用 |
| **智能过滤** | SSE 委托路径选择性转发事件：text_delta + tool_call + tool_result + error 转发，thinking + message_* 过滤 |
| **Phase 输出** | 直跑模式下的三段式输出结构：Syntax Check → Simulation → Assertions |

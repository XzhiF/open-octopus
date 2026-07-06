# Pi Agent Provider 问题排查记录

> 实施过程中发现的问题、根因分析与修复方案。
> 
> 时间：2026-07-06 | Commits：`4cf2086` → `957f1ba` → `9a23aa4`

---

## P1: Provider 路由不生效

**现象**：Workflow 设置 `engine: pi`，实际仍走 Claude SDK Provider。

**根因**：5 处代码硬编码 fallback `"claude"`，未读取 `workflow.engine`。

**修复**：

| 文件 | 修复 |
|------|------|
| `engine.ts` | `node.engine ?? this.workflow.engine ?? "claude"` |
| `swarm.ts` | 构造函数加 `workflowEngine` 参数 |
| `loop.ts` | 同上 |
| `ExecutionLifecycle.ts` | `resolveProviders` 追加 `workflow.engine` |
| `server/index.ts` | 去掉 `OCTOPUS_ENABLE_PI` feature flag |

**验证**：Server stdout 打印 `[PiProvider] sendQuery called`。

---

## P2: 模型自称 Claude

**现象**：Qwen 模型通过 Pi SDK 运行时回答 "I am Claude, made by Anthropic"。

**排查过程**（6 组对照实验 `test-pi-exact.mjs`）：

| 条件 | 结果 |
|------|------|
| 直接 API（无 prompt） | "I am Qwen" ✅ |
| 短 prompt + tools | "coding assistant" ✅ |
| **完整 Pi SDK prompt + tools** | **"I am Claude"** ❌ |
| Tools 写在 prompt 文本（无 API tools） | "I am Claude" ❌ |
| Tools 在 prompt + API tools 同时存在 | "I am Qwen" ✅ |

**根因**：Pi SDK system prompt 中 `Available tools: read, bash, edit, write` 文本格式触发 qwen 的 Claude 训练模式。

**修复**：`resolveSystemPrompt()` 注入 Octopus identity 规则，通过 `resourceLoader.getSystemPrompt()` 覆写持久化。

**关键技术点**：
- `createAgentSession` 忽略 `options.systemPrompt`
- 直接设 `agent.state.systemPrompt` 被 `_rebuildSystemPrompt()` 覆盖
- 必须通过 `resourceLoader.getSystemPrompt()` 注入

---

## P3: 工具调用日志为空

**现象**：日志中 `tool_call` 无参数，`tool_result` 为空字符串。但实际工具执行成功。

**根因**：`event-mapper.ts` 字段名与 Pi SDK agent-core 不匹配。

| Pi SDK 实际 | Mapper 使用 | 结果 |
|------------|-----------|------|
| `e.toolCallId` | `e.id` | undefined |
| `e.args` | `e.input` | undefined |
| `e.result` | `e.output` | undefined |

**修复**：使用 `e.toolCallId ?? e.id` 兼容两种格式。

---

## P4: Sub-Agent 工具未注册

**现象**：模型报告 "I don't have delegation tools available"。

**根因**：Sub-agent 作为 `extensions` 传给 `createAgentSession`，但 Pi SDK 期望 `customTools`。两者是完全不同的机制。

**修复**：
- `toSubAgentTool()` 返回 Pi SDK 兼容的工具定义格式（name/parameters/execute）
- adapter 传 `customTools` 而非 `extensions`

---

## P5: Skills 未注入

**现象**：模型无法看到 `.claude/skills/` 中定义的 skills。

**根因**：两层问题：
1. `noSkills: true` 禁用了 Pi SDK 原生 skill 加载
2. `resourceLoader.reload()` 未被调用（`createAgentSession` 只在自行创建 resourceLoader 时调用 reload）

**修复**：
- `noSkills: false`
- `agentDir: .claude`（从 `.pi-agent` 改为 `.claude`）
- 手动 `await resourceLoader.reload()`

---

## P6: prod.mjs Health Check 404

**现象**：`pnpm prod` 启动后 health check 返回 404。

**根因**：`prod.mjs` 请求 `/api/health`，但 server 实际端点是 `/api/actuator/health`（actuator 重构后路径变更）。

**修复**：URL 改为 `/api/actuator/health`，响应映射对齐 `dev.mjs`。

---

## P7: Sub-Agent System Prompt 未生效

**现象**：Sub-agent 没有使用 `def.prompt` 作为 system prompt，而是拼到 user message。

**根因**：`toSubAgentTool` 的 `execute()` 将 prompt 拼成 `${def.prompt}\n\nTask: ${args.task}` 作为 user message 发送，未设置 system prompt。

**修复**：
- `createSession({ systemPrompt: def.prompt })` — prompt 作为 system prompt
- `promptSession(session, args.task)` — user message 只发 task

---

## P8: Sub-Agent 工具限制无效

**现象**：`tools: [Read, Grep]` 定义的只读 sub-agent 仍能使用 bash。

**根因**：`def.tools` 未传给子 session 的 `createAgentSession`。

**修复**：
- adapter `SessionOptions` 加 `tools?: string[]`
- `toSubAgentTool` 将 PascalCase 映射为 lowercase 后传入
- `createAgentSession({ tools: opts.tools })`

---

## P9: Sub-Agent Skills 未透传

**现象**：`skills: [octo-workflow-dev]` 指定的 skill 在 sub-agent 中不可见。

**根因**：`def.skills` 未传给子 session。

**修复**：`createSession({ skills: def.skills })` 透传到 adapter 的 skills 过滤。

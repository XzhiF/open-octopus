# Qoder Agent SDK 集成为 Octopus Provider 可行性调研

> 调研目标：评估将 `@qoder-ai/qoder-agent-sdk`（Qoder CLI 的嵌入式 Agent SDK）包装为 Octopus `IAgentProvider` 第三实现（与 claude / pi 并列）的可行性、能力映射与集成方案。
> 调研日期：2026-09-30
> 一手资料：https://docs.qoder.com/cli/sdk/* 各子页面（均于当日抓取成功）；Octopus 代码以当前 main 工作区为准。
> 本地补充：任务提示中提到的 `sdk` skill（SKILL.md）在 `C:\Users\EDY\.qoder`（含 skills/、plugins/cache/）与本项目目录均未检索到，本笔记全部以官方文档为准。

---

## 0. TL;DR

**结论：可行，且是"同形态"移植级别的工程。** Qoder Agent SDK 与 Claude Agent SDK 在设计上高度同构（都是"SDK 包装本地 CLI 子进程 + query() 异步消息流 + hooks/canUseTool 权限拦截 + resume 会话"），claude provider（`packages/providers/src/claude/provider.ts`）约 70% 的结构可直接照抄：stream_event 的 delta 词汇（`text_delta` / `thinking_delta` / `input_json_delta`）、canUseTool 的 allow/deny 返回形状、PreToolUse/PostToolUse/PostToolUseFailure hooks、session_id 生命周期、abortController 中断全部同名同形。

**最大的实质性 gap 是用量口径**：Qoder SDK 对外暴露 **Credits（信用点）** 而非 USD，且文档层面**不承诺 token 四字段**（input/output/cacheRead/cacheCreation）——这直接冲击 Octopus 的 token 计费账本（`llm_calls` 需要四类 token）与 `MessageChunk.result.usage: TokenUsage` 规范形状。次级 gap：无 `maxBudgetUsd` SDK 硬保险丝（`error_max_budget_usd` subtype 不存在，额度耗尽以 error_code 113/118 形式出现在 `error_during_execution` 内）、systemPrompt preset 名不同（`qodercli` vs `claude_code`）、模型 tiers 词汇不同（`ultimate/performance/efficient/lite` vs `opus/sonnet/haiku`）、`getContextUsage()` 返回形状与 `ContextUsageData` 不镜像。

建议按 pi provider 的先例落地：新增 `packages/providers/src/qoder/provider.ts`，注册 id `'qoder'`，usage 采用"文档级 credits 如实透传 + token 字段留待实测包体确认"策略，预算硬保险丝在 provider 层做尽力而为。

---

## 1. Octopus Provider 契约现状（代码事实）

### 1.1 接口定义

`IAgentProvider`（`packages/providers/src/types.ts:149-159`）只有 4 个成员：

| 成员 | 定义位置 | 说明 |
|---|---|---|
| `sendQuery(prompt, cwd, resumeSessionId?, options?): AsyncGenerator<MessageChunk>` | types.ts:150-155 | 唯一必须实现的核心方法；每次调用 = 一轮 agent 执行 |
| `getType(): string` | types.ts:156 | provider id（`'claude'` / `'pi'` / 新 `'qoder'`） |
| `getLLMCalls?(): LLMCallRecord[]` | types.ts:157 | 可选；per-LLM-call 明细（供观测/账本） |
| `testConnectivity?(model?)` | types.ts:158 | 可选；实际由通用 `connectivity.ts:23-53` 用 `sendQuery('ping')` 兜底实现 |

`SendQueryOptions`（types.ts:32-81）字段清单：`model`、`systemPrompt`（string 或 `{type:'preset', preset:'claude_code', append?}`，types.ts:7-13）、`abortSignal`、`timingTag`、`maxBudgetUsd`、`maxTurns`、`env`、`agent`、`skills`、`tools`、`agents: Record<string, OctopusAgentDef>`（types.ts:15-24，含 description/prompt/tools/model/skills/maxTurns/background/effort）、`plugins`、`disablePlugins`、`disallowedTools`、`effort`、`interactionSession`（AskUserQuestion 拦截开关，types.ts:52-57）、`onBeforeToolCall`（安全拦截回调，types.ts:59-66）、`varsUpdate`、`customProviders`（types.ts:68-80，仅 pi 消费）。

### 1.2 事件流格式：MessageChunk

`MessageChunk` 联合类型（types.ts:108-129），共 19 个事件形状，关键点：

- **流式文本/思考**：`message_start` / `text_delta` / `text_done` / `thinking_start` / `thinking` / `thinking_done` / `message_delta`（携带 `TokenUsageDelta`，shared 规范形状）/ `message_stop`，全部挂 `messageId`。
- **工具**：`tool_call_start` / `tool_call`（完整入参）/ `tool_progress` / `tool_result`（含 `isError`）/ `tool_summary`。
- **交互**：`ask_user_question` / `complete_interaction`（工作流交互节点协议）。
- **终态**：`result`（`content`/`sessionId`/`usage: TokenUsage`/`costUsd`/`numTurns`/`modelUsages: ModelUsage[]`，types.ts:127）与 `error`（`code`/`message`/`sessionId`/`terminalReason: GoalTerminalReason`，types.ts:128）。
- **硬保险丝词表**：`GoalTerminalReason = 'max_turns' | 'max_budget_usd'`（types.ts:83-89），由 SDK 终态 subtype `error_max_turns` / `error_max_budget_usd` 归一而来。
- 其他：`status`（compacting/requesting）、`context_usage`（`ContextUsageData`，镜像 Claude SDK `getContextUsage()`，types.ts:131-147）、`local_command_output`、`active_goal`（/goal 收敛证据，types.ts:91-103）。
- **token 形状口径**（types.ts:3-5 注释）：`TokenUsage/ModelUsage/TokenUsageDelta` 唯一定义在 `@octopus/shared`，provider 的职责是**在 SDK seam 把 snake_case 原始事件转成规范形状**，其余层不再换形（C1 约定）。

### 1.3 注册与消费链路

- 注册表：`registerProvider(id, factory)` 工厂 + 单例缓存（registry.ts:3-9），sync `getProvider`（registry.ts:13-26）与 async `getProviderAsync`（registry.ts:30-40，pi 的 ESM 动态 import 需要）。
- 装配点：server 启动时注册 `claude` 与 `pi`（`packages/server/src/index.ts:227,230`）；CLI 侧同样注册（`packages/cli/src/commands/workflow.ts:27-28`）。**新 provider 需要在这两处 + 可能 swarm 的 engine 名映射处增加注册**。
- 引擎消费：`AgentNodeRunner.run()`（`packages/engine/src/executors/agent-runner.ts:135-156` 调 `sendQuery`）逐 chunk switch 转成 `AgentEvent`（agent-runner.ts:164-236）；`result` chunk 的 `sessionId/usage/modelUsages/costUsd` 是节点终态权威值（agent-runner.ts:214-220）；带 `terminalReason` 的 `error` chunk 被当作**正常硬保险丝终态**（不抛异常，agent-runner.ts:221-238）；无 `terminalReason` 的 error 抛异常（agent-runner.ts:235）。20 分钟无事件触发 idle abort（agent-runner.ts:9,107-129），resume 用保存的 sessionId + RESUME_PROMPT（agent-runner.ts:6,101-105）。
- swarm 里引擎名映射先例：`engine === "claude-code" ? "claude" : engine`（`packages/engine/src/executors/swarm.ts:157,172`）——`'qoder'` 作为新 key 可直接被 `getProvider(engine)` 消费。
- 结果二次消费：swarm 用 `chunk.modelUsages` 合并用量（swarm.ts:694-700）；agent 执行器把 `result.modelUsages` 上报（`packages/engine/src/executors/agent.ts:165,242`）。

### 1.4 Claude Provider 实现要点（Qoder 集成的模板）

`packages/providers/src/claude/provider.ts`（727 行），结构拆解：

1. **环境装配**：`loadClaudeSettingsEnv` + `buildSubprocessEnv`（:45-67）——合并 `~/.claude/settings.json` env、进程 env、options.env，带全局登录兜底开关 `CLAUDE_USE_GLOBAL_AUTH`。
2. **工具结果捕获**：`buildToolCaptureHooks`（:69-154）——用 PostToolUse/PostToolUseFailure hooks 把工具结果压入队列，主循环排空后 yield `tool_result` chunk；PreToolUse 拦截 `AskUserQuestion`/`complete_interaction`（deny + 固定话术）。
3. **权限门**：`canUseTool` 回调（:300-332）三路合流——`onBeforeToolCall` 安全拦截 → interactionSession 交互控制 → 默认 allow。**注释明示（:289-299,338-342）：不能用 `permissionMode:'bypassPermissions'`，否则 canUseTool 不被调用**，改用 `allowDangerouslySkipPermissions: true`。
4. **SDK 选项组装**（:334-369）：`model` 走 tier 别名解析 `resolveModelName`（:247-253，`loadModelAliasConfig`/`resolveModelAlias(model, 'claude', config)` —— **按 provider 键查别名表，Qoder 需新增 'qoder' 键档位**）；`systemPrompt` 默认 `{type:'preset', preset:'claude_code'}`；`includePartialMessages: true`；`resume` 传会话 id；abortSignal 桥接到 `abortController`。
5. **事件映射主循环**（:382-714）：`stream_event` 分支（:424-555）把 Anthropic 风格 raw event 转成 message_start/text_delta/thinking/tool_call/message_delta/message_stop，其中 `message_delta.usage`（snake_case 四字段）→ `TokenUsageDelta`（:527-549）；`message_start` 后一次性调用 `q.getContextUsage()` 发 `context_usage`（:439-452）；`result` 分支（:639-713）以 `result.modelUsage` 为**唯一权威 token 源**（seam 处 snake→规范形状转换 + `calibrateFromModelUsage` 校准 LLMCallTracker，:653-668），SDK 对不认识模型给 costUSD=0 时归一为"未定价"undefined（:663-665，C2 约定）。
6. **错误约定**：非 success 的 result 转 `error` chunk，subtype→code、errors 拼接→message、terminalReason 由 subtype 推导（:224-242）；**非终态保真原则**（:221-223 注释）：num_turns/cost/session_id/terminal-reason 必须在 error chunk 里存活。
7. **账本接线**：成员 `_llmTracker = new LLMCallTracker()`（:245），`getLLMCalls()` 透出（:255-257）；tracker 用 message 生命周期打点（onMessageStart/onTextDelta/onMessageDelta/onMessageStop）+ result.modelUsage 权威校准（llm-call-tracker.ts:42-50 还做模型名归一化，剥 ANSI 码与 `[1m]` 变体后缀）。
8. **pi provider 的差异化先例**（`packages/providers/src/pi/provider.ts`）：AsyncEventBridge 把 push 事件桥接成 pull generator（:196,318）；SDK 无 per-session 成本时用 TokenAggregator 逐消息聚合（:217-247）；**maxBudgetUsd 无 SDK 对应物时在 provider 层尽力而为**（:299-327，agent_end 后比较累计成本、超限提前结束并发 `budget_exceeded` error chunk）；错误统一走 `classifyProviderError`（:343-348，errors.ts:6-64 词表：auth_missing/auth_invalid/rate_limited/model_not_found/budget_exceeded/...）+ `sanitizeErrorMessage` 脱敏（errors.ts:66-85）。

### 1.5 Token 计费账本对 provider 的要求

- 账本行 `llm_calls` 需要**四类 token**（`recordLlmCall` 入参 `usage: Pick<TokenUsage,'inputTokens'|'outputTokens'|'cacheReadTokens'|'cacheCreationTokens'>`，`packages/server/src/services/llm-call-ledger.ts:26-47`）；**钱不落账本**（NEW-r2 起费用查询时按 `billing_price_config` 现算，llm-call-ledger.ts:9-11 注释），模型名落库前 `normalizeModelId` 归一（llm-call-ledger.ts:14-16,63）。
- 聊天路径旁路记账 `recordProviderResultUsage` 直接消费 `result` chunk 的 usage/costUsd/modelUsages（调用点：main-agent-route.ts:253,413,811、clone/index.ts:676、global-chat.ts:296 等）。
- 结论：**Qoder provider 必须回答"每轮/每模型 token 从哪来"**；若 Qoder SDK 不给 token，`llm_calls` 的 token 粒度只能缺省或估算（见 §4、§5）。

---

## 2. Qoder Agent SDK 能力全景（每条附来源 URL）

定位：把 Qoder 产品内部 Harness 作为可嵌入库暴露，SDK（TS/Python API）驱动本地 `qodercli` 子进程执行，模型通信由 CLI 走 Qoder 云服务。（https://docs.qoder.com/cli/sdk/overview）

### 2.1 安装与包

- TS 包 `@qoder-ai/qoder-agent-sdk`（`npm install`），Node.js 18+；发布包内含兼容 `qodercli` runtime，一般无需单独装 CLI。（overview）
- Python 包 `qoder-agent-sdk`，Python 3.10+。（overview）

### 2.2 核心 API：query() 与 Options

`query({ prompt, options }): Query`，`Query` 是 `AsyncGenerator<SDKMessage, void>`，`for await` 消费。（https://docs.qoder.com/cli/sdk/references-typescript）

与 Octopus 集成相关的 Options（references-typescript 页面逐项核对）：

| 类别 | 字段 |
|---|---|
| 认证（**必填**） | `auth`：`accessToken`/`accessTokenFromEnv(envVar?)`（默认读 `QODER_PERSONAL_ACCESS_TOKEN`）/ `serviceAccount({serviceAccountKey\|fetchServiceAccountToken})` / `qodercliAuth()` 复用本地登录。（https://docs.qoder.com/cli/sdk/authentication） |
| 会话 | `cwd`、`sessionId`、`resume`、`continue`、`forkSession`、`resumeSessionAt`、`persistSession`（默认 true）、`sessionStore`（外部存储适配器 `append/load/listSessions?/delete?`）、`sessionStoreFlush`、`QODER_CONFIG_DIR`（env 指定会话存储目录）（https://docs.qoder.com/cli/sdk/session-control） |
| 流式 | `includePartialMessages: true` → 流中出 `stream_event`；`includeHookEvents`；`promptSuggestions` |
| 模型 | `model`（`auto/ultimate/performance/efficient/lite` 或具体 id）、`fallbackModel`、`resolveModel: ModelPolicyProvider`（每次 LLM 请求前回调，`context.purpose ∈ main/subagent/compact/WebFetch/image generation`，返回 `{model, parameters?:{contextWindow, reasoningEffort}}`）、`resolveModelTimeoutMs`；运行时 `q.setModel()`、`q.getAvailableModels()`。（https://docs.qoder.com/cli/sdk/model-policy） |
| 系统提示 | `systemPrompt: string \| {type:'preset', preset:'qodercli', append?}` |
| 工具/权限 | `tools`（可见集，`'preset:qodercli'` 或数组）、`allowedTools`、`disallowedTools`（deny 优先）、`permissionMode`：`default/acceptEdits/bypassPermissions/yolo/plan/dontAsk/auto`（bypass 需 `allowDangerouslySkipPermissions:true`）、`canUseTool`、`permissionPromptToolName`（与 canUseTool 互斥）、运行时 `q.setPermissionMode()`（https://docs.qoder.com/cli/sdk/permissions） |
| 扩展 | `hooks`、`mcpServers`、`createSdkMcpServer({name, tools})` + `tool(name, desc, zodShape, handler, extras?)`（进程内自定义工具，全名 `mcp__{server}__{tool}`）（https://docs.qoder.com/cli/sdk/tools）；内置工具名与 Claude 系一致：`Read/Edit/Write/Bash/Glob/Grep/WebFetch/WebSearch/Agent`（tools 页列举，完整列表在其称的 SDK References） |
| Agent 组织 | `agent`、`agents: Record<string, AgentDefinition>`（description/prompt/tools/disallowedTools/model('inherit')/mcpServers/skills/initialPrompt/maxTurns/effort('low'\|'medium'\|'high'\|'max')/permissionMode）、`skills`、`plugins`、`settingSources`（user/project/local） |
| 限制 | `maxTurns`、`goalMaxTurns`、`q.setGoalMaxTurns()`；**无 maxBudgetUsd 等价字段** |
| 中断 | `abortController`（abort 关闭整个会话）；`q.interrupt()`（停当前生成/工具，返回 `{still_queved, cancelled}` 语义的对象）、`q.cancelAsyncMessage(uuid)`、`q.backgroundTasks()`、`q.stopTask()` |
| 进程/其他 | `env`、`pathToQoderCLIExecutable`、`spawnQoderCLIProcess`（自定义 spawn）、`executable/executableArgs`、`enableFileCheckpointing` + `rewindFiles()`（https://docs.qoder.com/cli/sdk/checkpoint）、`strictMcpConfig`、`customContext`、`experimentalCloudAgent`（云执行，实验） |

### 2.3 消息流（SDKMessage union）

（references-typescript + https://docs.qoder.com/cli/sdk/quick-start）

- `system` / `subtype:'init'`：含 `commands/agents/skills/models/account/fast_mode_state` 及 `session_id`（会话 id 的取得时机，session-control 页）。其他 subtype：`context_usage`、`usage_info`、`task_started/updated/notification`、`background_tasks_changed`、`hook_*`、`session_*` 等。
- `assistant`：`uuid/session_id/message/parent_tool_use_id/parent_agent_id/timestamp`；per-request 用量在 `message.usage`：文档明确字段为 `credits`、`original_credits`、`billable`（https://docs.qoder.com/cli/sdk/cost-usage）。references-typescript 的字段表还列出 `completion_tokens/prompt_tokens/total_tokens` 与 `usage.total_cost_usd/num_turns/modelUsage` —— **与其他页"仅 Credits"表述不一致，以前者实测为准（见 §6 未验证项）**。
- `user`：`subtype:'input' | 'tool_use_result' | 'side_question'`；tool_use_result 携带各工具结构化输出（BashOutput/FileReadOutput/…，后台任务 `kind:'backgrounded'`）。
- `stream_event`：`includePartialMessages:true` 时出现；`event.delta.type ∈ text_delta{delta.text} / thinking_delta{delta.thinking} / input_json_delta{delta.partial_json}`（https://docs.qoder.com/cli/sdk/streaming-output）——**与 Anthropic raw stream event 词汇完全一致，claude provider 的映射逻辑可平移**。
- `result`（终态）：字段 `subtype / is_error / error_code / errors / duration_ms / num_turns / result / session_id / total_credits / modelUsage（model→credits） / usage`。（cost-usage、errors、quick-start 三页交叉）

### 2.4 成本与用量口径

- **单位是 Credits，不是 USD，token 换算逻辑在 Qoder 内部不公开**（cost-usage 页"Summary of Missing Fields"明确 total_cost_usd/token counts 未提供）。
- 读取规则（cost-usage 页）：per-request credits 在 assistant `message.usage`；会话累计在 result `total_credits`（**跨 result 不可相加，是累计值**）；`modelUsage[model].credits` 按模型分组；三条"Do NOT"兼容规则。**result.modelUsage 的 value 文档只承诺 credits 字段**。
- 配额侧：`q.getUsageInfo()` 返回 `userQuota/addOnQuota/orgResourcePackage/totalUsagePercentage/isQuotaExceeded/session.total_credits/session.model_usage`，可不开新 turn 直接查。（references-typescript + cost-usage）
- 上下文用量：`q.getContextUsage()` 返回 `contextWindow.usedPercentage`、`skills.items[{name, percentageOfContext}]` —— **形状与 Octopus `ContextUsageData`（绝对 token 数、分类目）不镜像**。（cost-usage）

### 2.5 错误与终态

（https://docs.qoder.com/cli/sdk/errors）

- 三层：result 流内终态（`subtype` ∈ `success / error_during_execution / error_max_turns`，配 `is_error`、`error_code`）；SDK 异常（throw）：`QoderCliProcessError`（CLI 起不来/退出）、`AuthAccessTokenEnvVarError`、`AuthServiceAccountEnvVarError`、`ModelPolicyTimeoutError`、`ProtocolVersionMismatchError`、`UnsupportedCliCapabilityError`；进程退出码（41 认证失败、53 turn 超限等）。
- **额度/预算类错误是 error_code 不是 subtype**：105 token 过期、110 日限、113 配额耗尽、118 个人 Credits 耗尽、119 模型免费额度满等；可重试码 500/10408/10500/10605（退避重试），不可重试的认证/配额/策略类需改变输入。**不存在 `error_max_budget_usd`**。
- quick-start 页示例注释写 `subtype: 'done' | 'error'`，与 errors 页的 `success / error_during_execution / error_max_turns` 词表**冲突**（见 §6）。
- 认证失败回调 `onAuthExpired`（每会话最多一次）；PAT 不自动续期，换 token 后须新建会话。（authentication 页）

### 2.6 交互（AskUserQuestion）

- `AskUserQuestion` 作为特殊工具**恒经 canUseTool 路由**（即使 `bypassPermissions` 模式仍回调；`dontAsk` 模式直接 deny）；宿主在回调里拿到 `input.questions[1-4]`，拿到答案后返回 `{behavior:'allow', updatedInput:{questions, answers: {<问题原文>: <label 或自定义文本>}}}`，取消则 deny。（https://docs.qoder.com/cli/sdk/user-input）
- 复杂追问/长文本改用多轮流式输入（`prompt` 传 AsyncIterable），MCP 输入用 `onElicitation`。（user-input 页）

### 2.7 会话模型

- session = CLI 侧持久化的对话历史（UUID），`session_id` 从 init 消息与 result 消息取；`resume`/`continue`/`forkSession` 语义与 claude provider 用法同形。（session-control 页）

---

## 3. 能力映射表：Qoder SDK ↔ Octopus IAgentProvider

| Octopus 契约点 | Qoder SDK 对应物 | 匹配度 |
|---|---|---|
| `sendQuery(prompt, cwd, resume, opts)` | `query({prompt, options:{cwd, resume, ...}})` | ✅ 同构，直接映射 |
| `MessageChunk.text_delta/thinking/message_start/stop` | `stream_event`（`includePartialMessages`），delta 词汇与 Anthropic 相同 | ✅ claude provider 映射分支可平移 |
| `tool_call_start/tool_call` | stream_event 的 `tool_use` content block（`content_block_start` + `input_json_delta` 聚合） | ✅ 同 claude 做法 |
| `tool_result` | ① PostToolUse/PostToolUseFailure hooks 队列（claude 模式，注意 Qoder hook 输出为 `hookSpecificOutput.permissionDecision` 嵌套形状，与 claude provider 返回的顶层形状有差异需适配）；② `user/subtype:'tool_use_result'` 消息 | ✅ 双通道，≥claude |
| `message_delta.usage (TokenUsageDelta)` | ⚠️ per-request usage 公开字段是 `credits/original_credits/billable`；token 字段文档口径不一 | ❌/⚠️ **核心 gap，见 §4-1** |
| `result` chunk：sessionId/numTurns | `result.session_id` / `result.num_turns` | ✅ |
| `result` chunk：usage: TokenUsage / modelUsages / costUsd | `result.modelUsage[model].credits` + `total_credits`；**无 USD、token 未承诺** | ⚠️ 需转换策略（§4-1、§5.3） |
| `error` chunk code/message | `result.subtype + error_code + errors[]`，异常 `QoderCliProcessError` 等 → `classifyProviderError` 扩展 | ✅ 有词表，补映射 |
| `terminalReason:'max_turns'` | `error_max_turns` subtype | ✅ 同名 |
| `terminalReason:'max_budget_usd'` / `options.maxBudgetUsd` | **无 SDK 字段**；额度耗尽=error_code 113/118（属 error_during_execution） | ❌ provider 层自实现（pi 模式，provider.ts:299-327 先例） |
| `options.model` tier 别名 | `model: auto/ultimate/performance/efficient/lite` + `resolveModel` 回调 + `getAvailableModels()` | ✅ 走 `resolveModelAlias(model,'qoder',config)` 新档位表 |
| `options.systemPrompt` preset `claude_code` | preset 名 `qodercli` | ✅ provider 内翻译，不动接口 |
| `options.effort` | AgentDefinition.effort（low/medium/high/max）；主会话经 `resolveModel.parameters.reasoningEffort` | ⚠️ 主会话无独立 effort 选项，需 policy 回调承载 |
| `options.agents / OctopusAgentDef` | `agents: Record<string, AgentDefinition>`（字段超集，含 permissionMode/initialPrompt；缺 `background`） | ✅ 高保真（toClaudeAgentDef 模式照抄） |
| `options.skills / plugins / tools / disallowedTools` | 同名 Options 字段 | ✅ |
| `options.env` | `options.env`（传给 CLI 进程） | ✅ |
| `options.abortSignal` | `options.abortController`（桥接同 claude provider:361-369）；另可 `q.interrupt()` | ✅ |
| `interactionSession` / `ask_user_question` chunk | AskUserQuestion 恒走 canUseTool（bypass 下也回调） | ✅ 且语义更明确：可挂起回调等答案再 allow（§5.4） |
| `onBeforeToolCall` 安全拦截 | canUseTool deny（返回形状与 claude 一致：`{behavior:'deny', message, toolUseID}`） | ✅ 与 claude 同构；注意 permissions 页未复述 claude 的 updatedInput 必填差异 |
| `context_usage` chunk (`ContextUsageData`) | `getContextUsage()` 形状不同（百分比制、无分类目绝对值） | ❌ 一期不发此 chunk（引擎侧仅透传展示，agent-runner 不消费） |
| `active_goal` chunk | 有 goalMaxTurns/setGoalMaxTurns，**未见 active_goal 消息或 Stop-hook feedback 文档** | ❌/⚠️ 未验证，一期不发 |
| `getLLMCalls()`（LLMCallTracker） | tracker 打点照抄 claude；`calibrateFromModelUsage` 取决于 modelUsage 是否含 token | ⚠️ 半可用（credits 可作 costUsd 替身或另开口径） |
| token 账本 `llm_calls` 四字段 | SDK 不承诺 → 只能 (a) 实测包体拿真 token，(b) 记 0 + credits 另列，(c) 按价表反推估算（失真） | ❌ **需要产品决策**（§4-1） |
| 多租户/隔离 | `settingSources:[]` 可禁读文件系统配置、`pathToQoderCLIExecutable`/`spawnQoderCLIProcess` 可控进程、`QODER_CONFIG_DIR` 隔离会话目录、`sessionStore` 外部存储 | ✅ 优于 claude（有官方外置会话存储接口） |
| `customProviders`（自带端点/价表） | **无对应**——模型通信锁在 Qoder 云服务，不能指到任意 base_url | ❌（可接受：该字段本就仅 pi 消费） |

---

## 4. Gap 与风险清单

1. **【高】用量口径 Credits vs Token/USD**：Octopus 全站规范是 token 四字段 + 查询时价表算钱（llm-call-ledger.ts:9-11），Qoder 公开口径是 Credits（cost-usage 页明说 token 不公开、无 total_cost_usd）。影响：`llm_calls` 的 token 粒度对 Qoder 路径要么缺失要么估算。**缓解**：① 拿到真实包后实测 `assistant.message.usage` 与 `result.modelUsage` 的运行时完整字段（references-typescript 列了 completion_tokens/prompt_tokens/total_tokens，与 cost-usage 页矛盾，实测定夺）；② 若确实只有 credits，在 seam 处把 credits 记为"未定价实测"（同 C2 的 costUsd=undefined 处理），账本 token 记 0 并在 source_path 维度可辨识；③ 长期向 Qoder 侧要 credits→token 换算接口或账单 API。
2. **【高】无 USD 预算硬保险丝**：`maxBudgetUsd` 无 SDK 对应物（Options 表、errors 页均无）。**缓解**：pi 模式 provider 层尽力而为——按累计 credits/估算成本超阈主动 abort 并合成 `{terminalReason:'max_budget_usd'}` error chunk（引擎侧词表不动）。语义差异：SDK 侧真硬熔断（账号配额 113/118）仍可能先触发，映射为 `budget_exceeded` 类 error。
3. **【中】文档自相矛盾**：result subtype `done/error`（quick-start）vs `success/error_during_execution/error_max_turns`（errors 页）；assistant usage 是否含 token（§4-1）。SDK 协议演进快（存在 `ProtocolVersionMismatchError`、`UnsupportedCliCapabilityError` 即证）。**缓解**：集成实现按"subtype 集合 + error_code 双读、未知 subtype 保守当 error"编写；锁定 SDK+CLI 版本入 monorepo。
4. **【中】数据边界**：prompt/上下文由 qodercli 上传 Qoder 模型服务（overview"执行边界"节），文件/命令在本地 CLI 环境执行。对 Octopus 的多租户/私有部署场景是合规评估项，与 claude 路径性质相同但供应商不同。
5. **【中】hooks 输出形状差异**：Qoder hooks 文档的返回是 `{hookSpecificOutput:{hookEventName, permissionDecision...}}` 嵌套形（hooks 页），claude provider 现在返回顶层 `{hookEventName, permissionDecision}`（provider.ts:86-91）。照搬时需在 qoder provider 里改成 Qoder 文档形状；且 PreToolUse deny 在 bypass 模式下是否被忽略（claude 侧踩过坑，provider.ts:291-293 注释）文档未说明——canUseTool 作为权威门的策略可沿用。
6. **【低】`context_usage`/`active_goal` 两 chunk 无对等源**：一期省略（引擎不硬依赖，agent-runner.ts 对未知/缺失 chunk 均为可选消费）；`ContextUsageData` 可后续做百分比→估算的降级映射。
7. **【低】`OctopusAgentDef.background` 无对应**（AgentDefinition 无 background 字段）；后台任务在 Qoder 是运行时能力（`q.backgroundTasks()`），非 agent 定义字段。透传丢弃即可（记录在案，避免 claude 侧曾经"静默丢字段"的同款问题，provider.ts:176-178 注释教训）。
8. **【低】testConnectivity 烧 Credits**：connectivity.ts 的 `'ping'` 会真实起一次 agent turn 消耗配额；qoder provider 可实现轻量 `testConnectivity`（用 `q.getUsageInfo()`/`initializationResult()` 不跑 turn——references-typescript 明示 `getUsageInfo` "without starting an Agent turn"）。

---

## 5. 集成方案骨架

### 5.1 文件与注册

```
packages/providers/src/qoder/
  provider.ts        # QoderSDKProvider implements IAgentProvider, getType(): 'qoder'
  event-mapper.ts    # SDKMessage → MessageChunk（或直接内联，参照 claude）
  auth.ts            # auth 解析：PAT env → accessTokenFromEnv('QODER_PERSONAL_ACCESS_TOKEN')；
                     #   无 PAT 且 QODER_USE_GLOBAL_AUTH≠'0' → qodercliAuth()（本地开发兜底，仿 buildSubprocessEnv 逻辑）
  usage-adapter.ts   # credits/modelUsage → ModelUsage/TokenUsage 的 seam 转换（唯一改形点，C1 约定）
```

注册（三处）：
- `packages/server/src/index.ts:227` 附近：`registerProvider('qoder', () => new QoderSDKProvider())`
- `packages/cli/src/commands/workflow.ts:27` 附近：同上
- `packages/providers/src/index.ts`：导出 `QoderSDKProvider`
- 引擎侧零改动：workflow 节点 `engine: qoder` 经 `getProvider(engine)` 即达（swarm.ts:157 的映射只处理 claude-code 特例）。

模型别名：`loadModelAliasConfig` 体系为 'qoder' 键新增档位映射（`pro-max→ultimate`、`pro→performance`、`se→efficient` 示意，最终以 `getAvailableModels()` 实测为准）。

### 5.2 sendQuery 主流程（复用 claude provider 的具体点位）

逐段对应 `claude/provider.ts`：

| claude 段落 | qoder 做法 |
|---|---|
| :247-253 resolveModelName | 同构，provider 键换 'qoder'；`model` 值放 SDK 档位名 |
| :56-67 buildSubprocessEnv | 复制结构：process.env + options.env + QODER_* 白名单；auth 单独走 `options.auth` 而非 env 拼装 |
| :69-154 buildToolCaptureHooks | 语义照搬，返回值改为 Qoder 的 `hookSpecificOutput` 嵌套形（hooks 页）；PostToolUse/PostToolUseFailure 队列排空 yield `tool_result` |
| :300-332 canUseTool | **几乎逐行可用**：onBeforeToolCall deny → interactionSession（AskUserQuestion deny+固定话术）→ allow+updatedInput；返回形状 allow/deny/toolUseID 与 permissions 页一致 |
| :334-363 sdkOptions | `auth` 必填；`systemPrompt` 默认 `{type:'preset', preset:'qodercli', append}`；`includePartialMessages:true`；**不设 bypassPermissions**（沿用 :338-342 的教训，用 default/auto + canUseTool）；`resume`/`abortController` 桥接同形 |
| :382-555 stream_event 映射 | **直接平移**：delta 词汇相同（streaming 页）；message_start 后 `q.getContextUsage()` 一期跳过（形状不镜像，见 §4-6） |
| :639-713 result 映射 | `sessionId←session_id`、`numTurns←num_turns`、`content←result`；`modelUsages←result.modelUsage`：value 有 token 四字段则规范转换+calibrate，仅 credits 则 `ModelUsage{model, credits}`（扩展 shared 或 credits 折入 costUsd 需评审）；`costUsd←total_credits` 折算或直接 undefined（未定价）——**决策点** |
| :224-242 error 映射 | 非 success/error_code：`code←subtype 或 error_code 字符串`、`message←errors.join('; ')`、`terminalReason← error_max_turns→'max_turns'`；error_code 113/118 → 映射 `'max_budget_usd'`（provider 合成的语义等价物，需在注释声明）；catch 圈 `QoderCliProcessError` 等走 `classifyProviderError` 扩展 qoder 分支 |
| :289 tracker | `LLMCallTracker` 打点全同（onMessageStart/TextDelta/MessageDelta/Stop）；calibrate 数据源弱化为 credits 时仅记 costUsd |
| pi:299-327 预算 | provider 层 maxBudgetUsd 尽力而为：累计 credits×折算率 或 getUsageInfo() 采样，超限 `abortController.abort()` + yield budget 终态 error |

### 5.3 账本对接策略（建议默认）

一期：`result` chunk 中 `usage` 按实测（若 token 可得）否则 undefined；`modelUsages` 至少含 `{model, credits}`（shared `ModelUsage` 若不含 credits 字段，加可选字段属跨包评审项）；`costUsd` 一律 undefined（credits 非 USD，避免假实测污染价表反推），`llm_calls` 走现有"缺 token 记 0、费用查询时段现算"路径不会崩（行可空/零值，llm-call-ledger.ts:26-47）。二期再评估 credits 折算率表。

### 5.4 AskUserQuestion 交互的两个方案

- **A（贴 Octopus 现状，推荐先行）**：canUseTool 里 deny + "问题已转发 web UI" 话术，yield `ask_user_question` chunk，用户答案作为**下一次 sendQuery(resumeSessionId)** 注入——与 claude 路径行为完全一致，引擎/InteractionService 零改动。依据：bypass 下 AskUserQuestion 仍回调（user-input 页表格）。
- **B（更贴 Qoder 语义，留作演进）**：canUseTool 内挂起 Promise 等 UI 答案，返回 `allow + updatedInput.answers`（user-input 页官方形态）。好处单会话闭环、无 resume 往返；风险是回调悬挂期与 agent-runner 20min idle 超时（agent-runner.ts:9）赛跑，长审批需调 IDLE_TIMEOUT 或心跳。

### 5.5 建议验证步骤（实现前跑通）

1. `npm i @qoder-ai/qoder-agent-sdk`，最小脚本跑通 `query({prompt:'hello', options:{auth: qodercliAuth()}})`，**dump 全量消息 JSON**：定夺 result subtype 真实词表（done vs success）、assistant usage 真实字段（credits? tokens?）、modelUsage value 形状 —— 一次性解决 §4-1/§4-3 两大文档矛盾。
2. `includePartialMessages:true` 下核对 stream_event 的 content_block_start/delta/stop 索引结构是否同 Anthropic（决定映射代码能否逐行平移）。
3. resume 验证：记录 init `session_id`，二次 `query({resume})` 确认上下文延续。
4. abort/interrupt 验证：AbortController.abort 后生成器行为（抛错还是自然结束）——决定 provider 的 abort 语义包装。
5. AskUserQuestion 验证：permissionMode 'default' + canUseTool，确认回调必达、deny 话术回传给模型的行为。
6. PreToolUse deny 在 `allowDangerouslySkipPermissions:true` 下是否生效（claude 侧曾失效）；以 canUseTool 为权威门复测。
7. 错误注入：无效 PAT（期望 AuthAccessTokenEnvVarError / error_code 105）、kill 掉 qodercli 进程（期望 QoderCliProcessError + exitCode）。
8. 连通性：`getUsageInfo()` 不起 turn 的实测（决定 testConnectivity 实现）。

---

## 6. 未验证项（诚实清单）

- **assistant message / result 消息的真实运行时字段**：所有结论来自 docs.qoder.com 文档转述，未安装未执行；`references-typescript` 抓取摘要中的 `completion_tokens/prompt_tokens/total_tokens/total_cost_usd` 与 `cost-usage` 页"仅 Credits"矛盾，两处均可能过期。§5.5-1 为裁决步骤。
- result `subtype` 终值集合（`success/error_during_execution/error_max_turns` vs `done/error`）未实机确认。
- Qoder 是否发出 `tool_progress`、`tool_use_summary` 类消息：文档消息 union 未见对应物（Octopus 对应 chunk 可不发，引擎不强依赖）。
- `active_goal` 等价物：Qoder 有 Goal 选项（goalMaxTurns、setGoalMaxTurns）但文档未描述收敛证据消息；claude 侧靠 "Stop hook feedback" 文本解析的土路径（claude/provider.ts:193-219）是否在 Qoder 复现未查。
- `getContextUsage()` 的 `SDKControlGetContextUsageResponse` 完整字段：cost-usage 页只给了 contextWindow/skills 两角，references 页表格被截断，是否有 categories/totalTokens 明细未证实。
- canUseTool 挂起时长上限 / 是否有超时打断（影响 §5.4-B）。
- `customContext`、`sessionStore`、`experimentalCloudAgent` 的成熟度与限制条目。
- 本地 `sdk` SKILL.md（任务提示可能存在）：在 `C:\Users\EDY\.qoder\skills`（空目录）与插件缓存中检索无果，未采信。
- 文档抓取情况：本次引用的 12 个页面全部抓取成功，无失败页；但各页为二手转述给 WebFetch 的提炼，字段级细节（类型定义原文）建议以 `sdk.d.ts` 实测复核。

---

## 7. 参考链接

Octopus 代码锚点：
- `packages/providers/src/types.ts`（契约）、`registry.ts`（注册表）、`claude/provider.ts`（集成模板）、`pi/provider.ts`（provider 层预算兜底先例）、`llm-call-tracker.ts`、`errors.ts`、`connectivity.ts`
- `packages/engine/src/executors/agent-runner.ts`（chunk 消费/终态语义）、`swarm.ts:157`（engine key 映射）
- `packages/server/src/index.ts:227-230`、`packages/cli/src/commands/workflow.ts:27-28`（注册点）
- `packages/server/src/services/llm-call-ledger.ts`（账本行要求）
- 同目录既往笔记：`docs/research/claude-agent-sdk.md`、`docs/research/agent-provider-mastra-pi.md`、`docs/research/pi-agent-integration/`

Qoder 官方文档（均 2026-09-30 可达）：
- Overview: https://docs.qoder.com/cli/sdk/overview
- Quick Start: https://docs.qoder.com/cli/sdk/quick-start
- Authentication: https://docs.qoder.com/cli/sdk/authentication
- SDK References (TypeScript): https://docs.qoder.com/cli/sdk/references-typescript
- Streaming Output: https://docs.qoder.com/cli/sdk/streaming-output
- Session Control: https://docs.qoder.com/cli/sdk/session-control
- Approval and User Input: https://docs.qoder.com/cli/sdk/user-input
- Permission Control: https://docs.qoder.com/cli/sdk/permissions
- Hooks: https://docs.qoder.com/cli/sdk/hooks
- Tools: https://docs.qoder.com/cli/sdk/tools
- Model Selection: https://docs.qoder.com/cli/sdk/model-policy
- Cost and Usage: https://docs.qoder.com/cli/sdk/cost-usage
- Errors: https://docs.qoder.com/cli/sdk/errors

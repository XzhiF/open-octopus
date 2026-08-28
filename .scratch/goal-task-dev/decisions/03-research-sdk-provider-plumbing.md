# 03 — Research: Claude SDK / provider 管道缺口清单

Type: research
Status: resolved
Blocked by: None

## Question

Claude Agent SDK(query/Options)主会话层的能力边界,以及本仓库 provider 管道现状缺口:

1. SDK `Options.maxTurns` 是否存在?语义(单次 query 内 tool-call 轮数上限?)、超限行为(抛错/正常结束)?
2. SDK `allowedTools`/`disallowedTools`/`tools` 的确切语义与现状映射(`packages/providers/src/claude/provider.ts:285-286`)是否已是直通、有无过滤差异。
3. `OctopusAgentDef.maxTurns`(:33)在 sub-agent 场景怎么被消费——现成先例。
4. 本仓库从 `SendQueryOptions` → provider → SDK 之间,goal 模式要真实执行 max_turns/tools 需要动哪几层(文件+函数级清单)。
5. SDK 是否支持会话 resume(本仓库已用于 context: continue)+ 每轮注入新消息的机制(evaluator 反馈续跑需要)。

## Answer

调研基线:已安装 SDK `@anthropic-ai/claude-agent-sdk@0.3.235`(node_modules/.pnpm 下,类型定义 `sdk.d.ts` 共 8151 行,下文行号均指该文件)+ 本仓库 `packages/providers` / `packages/engine` 现状。

### 1. `Options.maxTurns` — 存在,超限**不抛异常**,以 error 型 result 正常结束

SDK 层两处都存在:

- **主会话** `sdk.d.ts:1721-1725`:
  > ```
  > * Maximum number of conversation turns before the query stops.
  > * A turn consists of a user message and assistant response.
  > */
  > maxTurns?: number;
  > ```
- **子代理** `AgentDefinition.maxTurns` `sdk.d.ts:71-75`:
  > ```
  > * Maximum number of agentic turns (API round-trips) before stopping
  > */
  > maxTurns?: number;
  > ```

语义:限制单次 `query()` 内的对话轮数。在单 prompt 模式下,每次 tool-use 往返都表现为"assistant 回复 + tool_result 回填的 user 消息",所以实际效果就是 **agentic loop 的 API round-trip 上限**(`num_turns` 会体现在 result 里,`sdk.d.ts:4627`)。

超限行为:**流正常走完、iterator 不 throw**,CLI 发出一条 `SDKResultError`,由 consumer 判型:

- `sdk.d.ts:4578-4579`:`subtype: 'error_during_execution' | 'error_max_turns' | 'error_max_budget_usd' | 'error_max_structured_output_retries'`
- `sdk.d.ts:7911` `TerminalReason` 联合中含 `'max_turns'`(以及 `'budget_exhausted'`、`'completed'`)。

本仓库对 error result 的现有处理:`ClaudeSDKProvider.sendQuery` 把非 success 的 result 转成 `{type:'error', code: rm.subtype}`(`packages/providers/src/claude/provider.ts:524-529, 563-569`),`AgentNodeRunner` 收到 error chunk 后 **throw**(`packages/engine/src/executors/agent-runner.ts:174-176`)→ 节点 failed。即 goal 模式若不特殊处理,`error_max_turns` 会被当作节点失败而非"轮数耗尽后交给 evaluator 评审"。

**现状缺口:`SendQueryOptions` 没有 `maxTurns` 字段,provider 的 `sdkOptions` 从不设置它**(`provider.ts:264-291` 全量构造中无 maxTurns)——SDK 能力存在但管道断开。

### 2. `allowedTools` / `disallowedTools` / `tools` 三者语义与现状映射

SDK 语义(三个不同的东西,易混):

| 选项 | sdk.d.ts 位置 | 语义(引注释) |
|---|---|---|
| `tools` | :1467-1478 | "Specify the **base set of available built-in tools**"。`string[]` 白名单集合;`[]` 禁用全部内建;`{type:'preset',preset:'claude_code'}` 全量。决定模型**看得见哪些工具** |
| `allowedTools` | :1413-1422 | "List of tool names that are **auto-allowed without prompting for permission**"。只是免审批清单,**不控制可见性**("To restrict which tools are available, use the `tools` option instead") |
| `disallowedTools` | :1437-1442 | "these tools will be **removed from the model's context and cannot be used**, even if they would otherwise be allowed"。硬移除 |

现状映射(`packages/providers/src/claude/provider.ts:285-286`):

```ts
tools: options?.tools,
disallowedTools: options?.disallowedTools,
```

结论:
- **`tools`、`disallowedTools` 已是纯直通**,provider 无任何额外过滤;`SendQueryOptions.tools`(`providers/src/types.ts:52`)/`disallowedTools`(:56)→ SDK 一一对应。
- **`allowedTools` 在本仓库全库 0 引用**(grep engine/server/providers 无命中,只有 disallowedTools),SendQueryOptions 也未暴露。权限层由 `canUseTool` 回调代替:`provider.ts:230-262` 默认 `{behavior:'allow'}`,仅 harness 拦截器(`onBeforeToolCall`)和 interaction 控制例外 deny。注意 `provider.ts:268-272` 的注释:仓库刻意**不设** `permissionMode:'bypassPermissions'`(会破坏 canUseTool),靠 canUseTool 全 allow 达成免审批——所以 `allowedTools` 缺位目前无副作用,但若 goal 模式想收紧权限(如 `dontAsk`),`allowedTools` 必须补进管道。
- 另注意 `NodeDef.planning.tools / disallowed_tools`(`shared/src/types/workflow.ts:179-186`)**当前只是拼进 prompt 文本**(`engine/src/executors/agent.ts:377-390` 的 "## Allowed Tools" 段落),是软约束,不进 SDK。

### 3. `OctopusAgentDef.maxTurns`(providers/src/types.ts:33)在 sub-agent 场景的消费现状

**结论:目前没有任何消费方——它在 provider 边界被静默丢弃。**

值的来源链(完好):
1. workflow YAML `agents.<name>.maxTurns`:`SubAgentDef.maxTurns`(`shared/src/types/workflow.ts:75`,`SubAgentDefSchema` :88 `z.number().int().positive().optional()`)。
2. agent .md frontmatter `maxTurns: N`:解析先例 `engine/src/executors/agent.ts:218`(`parseFrontmatter`,`} else if (key === "maxTurns") { const n = parseInt(val, 10) ... }`)与 swarm 版 `engine/src/executors/swarm/agent-file-utils.ts:52`。
3. `AgentExecutor.resolveAgents()`(`agent.ts:231-303`)把 frontmatter 与 YAML 合并(后者覆盖前者),`resolved[name] = merged` 保留 maxTurns。
4. `AgentExecutor.execute` → `runner.run({ agents: this.resolveAgents(), ... })`(`agent.ts:107-119`)→ `AgentNodeRunner.run` → `sendQuery(..., { agents: opts.agents })`(`agent-runner.ts:124`)。

断点:
- **Claude provider:`toClaudeAgentDef`(`provider.ts:175-183`)只映射 `description/prompt/tools/model/effort` 五个字段,`maxTurns`(以及 `skills`、`background`)被丢掉**,尽管 SDK `AgentDefinition.maxTurns` 真实存在(:71-75)。`as AgentDefinition` 的宽转义使 TS 不会报缺失。
- Pi provider 同样不消费(grep `maxTurns` 在 `providers/src/pi/` 0 命中,`toSubAgentTool` 只用 prompt/tools/model)。
- 唯一"消费先例":`CloneDef.config.maxTurns`(`shared/src/types/agent.ts:154`)——但同样停在声明层,clone-runtime 的 `sendQuery`(`server/src/services/agent/clone-runtime.ts:411`)只传 model/systemPrompt/agents/plugins,没传 maxTurns。

即现成先例只到"YAML/frontmatter→合并→传入 options.agents"这一段;最后一跳(provider→SDK)不存在。修复是 `toClaudeAgentDef` 加一行 `maxTurns: def.maxTurns`(顺带 `skills`、`background`,SDK 均支持)。

### 4. goal 模式真实执行 max_turns/tools 需要动的层(文件+函数清单)

自上而下 5 层,现状每层缺口:

| # | 文件 | 函数/位置 | 改动 |
|---|---|---|---|
| L1 shared | `packages/shared/src/types/workflow.ts` | `PlanningSchema`(:184-190) | 无需改——`max_turns/tools/disallowed_tools` 已解析;若 goal 节点还要 `budget_usd` 等再扩 schema |
| L2 providers 类型 | `packages/providers/src/types.ts` | `SendQueryOptions`(:44-87) | 新增 `maxTurns?: number`、`allowedTools?: string[]`(`tools/disallowedTools/maxBudgetUsd` 字段已存在,但见 L3) |
| L3 claude provider | `packages/providers/src/claude/provider.ts` | `ClaudeSDKProvider.sendQuery` sdkOptions 构造(:264-291) | ① 补 `maxTurns`(现在完全没传);② 补 `allowedTools`;③ **`maxBudgetUsd` 是死字段**:`SendQueryOptions.maxBudgetUsd`(:48)在 claude provider 中从未读取,SDK `Options.maxBudgetUsd`(:1728-1731)原生支持,直通即可;④ `toClaudeAgentDef`(:175-183)补 `maxTurns/skills/background` |
| L4 engine runner | `packages/engine/src/executors/agent-runner.ts` | `AgentNodeRunner.run` opts(:27-52)+ sendQuery options(:120-132) | run opts 新增 `maxTurns/tools/allowedTools/maxBudgetUsd` 并透传进 sendQuery(现 opts 已有 `disallowedTools` 且与硬编码 `["AskUserQuestion","complete_interaction",...]` 合并,先例可仿) |
| L5 agent executor | `packages/engine/src/executors/agent.ts` | `AgentExecutor.execute` 的 `runner.run({...})` 调用(:107-119) | 把 `this.node.planning?.max_turns / tools / disallowed_tools` 从"只拼 prompt"升级为真实参数传入(planning.tools 同时建议保留 prompt 注入,软+硬双保险) |
| L6 错误语义 | `agent-runner.ts:174-176` + `agent.ts execute catch` | error chunk 处理 | 区分 `code === 'error_max_turns' / 'error_max_budget_usd'`:goal 循环里应作为"轮数/预算耗尽 → 进入 evaluator 评审"的信号,而非节点 failed(现一律 throw) |

另有 swarm 路径若需同权:`engine/src/executors/swarm/` 走同一 `toClaudeAgentDef`,L3-④ 一行改动自动覆盖(`agent-file-utils.ts:52` 已解析 frontmatter maxTurns)。

### 5. 会话 resume:SDK 支持且本仓库已用;"每轮注入新消息"有两条 SDK 路线

**Resume(已在用)**:
- SDK 侧完整一套:`resume?: string`(:1851 "Session ID to resume")、`continue?: boolean`(:1432,与 resume 互斥)、`forkSession?: boolean`(:1547,"resumed sessions will fork to a new session ID")、`sessionId?: string`(:1857)、`resumeSessionAt?: string`(:1865,截断到指定消息 UUID 再续跑)、`persistSession`(:1633)。
- 仓库通路:`IAgentProvider.sendQuery(prompt, cwd, resumeSessionId?, options)`(types.ts:130-135)→ `provider.ts:290` `...(resumeSessionId ? { resume: resumeSessionId } : {})`。上层:`engine.ts` `resolvePreviousSessionId`(:1845,`context:'continue'`→globalSessionId、`resume_from`→branchSessionIds)+ `updateSessionContext`(:1860)。已投产的续跑先例:① agent-runner 断流重试(`RESUME_PROMPT` :5 + attempts 循环);② 人工干预 `engine.ts:751-761`(intervention 以 resume 会话再跑一轮 `AgentNodeRunner.run`)。**这正是 goal evaluator 反馈续跑可以复用的模式**:每轮 = 新 `query({prompt: 反馈文本, options:{resume: sessionId}})`。
- 注意语义:每次 resume 会重起子进程、`total_cost_usd/modelUsage` 按 result 注释"resumed sessions start fresh"(:4585),跨轮累计要在 engine 层自己加总。

**每轮注入新消息的机制**(evaluator 反馈续跑需要,由轻到重):
1. **resume-per-turn(仓库现成)**:如上,每轮一次 sendQuery+resume。已满足功能,代价是每轮冷启动子进程、且 `maxTurns` 每轮重新计数(单轮内上限)。
2. **streaming-input 模式(SDK 原生、仓库未用)**:`query({ prompt: AsyncIterable<SDKUserMessage> })`(:2688-2691)+ `Query.streamInput(stream)`(:2658)。会话进程常驻,evaluator 输出作为新 `SDKUserMessage` push 进流:`shouldQuery?: false` 可纯追加不触发回合(:4949 注释"appended to the transcript without triggering an assistant turn"),`priority?: 'now'|'next'|'later'`(:4940),`interrupt()`(:2394)可打断当前回合,每回合恰好一条 result(:4608 注释"exactly one result message per turn ... treat it as the turn-complete signal")。改造点:provider.sendQuery 的 prompt 从 string 换为可注入的 async queue,`MessageChunk` 协议基本不用动。
3. **Stop hook 注入(SDK 原生、仓库未用)**:`HookEvent` 含 `'Stop'`(:858),`StopHookSpecificOutput.additionalContext`(:7791-7797:"non-error feedback delivered to the model; the conversation continues so the model can act on it")+ `stop_hook_active` 防死循环字段(:7774)。可把 evaluator 反馈直接以 hook 形式回灌、会话不断。仓库 `buildToolCaptureHooks` 目前只挂 Pre/PostToolUse/PostToolUseFailure(:81-159),扩展点是现成的。

**建议**:goal 循环用方案 1(改动最小、与 intervention/loop 同构,SDK resume 已被本仓库验证);若后续要低延迟多轮+精确控轮,再升级到方案 2。

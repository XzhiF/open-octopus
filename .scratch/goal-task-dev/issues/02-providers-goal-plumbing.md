# 02 — providers:maxTurns 直通 + active_goal/error chunk 透传链

## What to build
SDK 能力面:claude provider 把 maxTurns/maxBudgetUsd 送进 sdkOptions(SDK 原生硬终态);`SDKActiveGoalMessage` 不再被 if-chain 丢弃,转为 MessageChunk 新变体;非 success result 不再压扁证据(terminalReason/numTurns/costUsd/sessionId 保留)。engine 与 web 的可观测性都消费本工单。

## Blocked by
None — can start immediately(与 01 并行;sdk.d.ts 已验证字段存在)

## Status
done

## Acceptance Criteria
- [x] AC1: `SendQueryOptions.maxTurns?: number`;provider sdkOptions 映射 maxTurns + maxBudgetUsd(后者字段已存在但从未读——救活)
- [x] AC2: `toClaudeAgentDef` 补 maxTurns/background 透传(现状静默丢弃,03 研究锤实)
- [x] AC3: MessageChunk 新增 `active_goal` 变体{condition,iterations,last_reason?,set_at};claude provider if-chain 顶层识别 StdoutMessage type==='active_goal' 转 chunk
- [x] AC4: error chunk(result 非 success)扩展 numTurns/costUsd/sessionId/terminalReason;subtype∈{error_max_turns,error_max_budget_usd} 时 terminalReason 必带、不 throw
- [x] AC5: pi provider 不消费新 option 字段,类型编译通过,行为不变

## Verification Method
**Verification type**: 单元测试(mock SDK message 流)
**Verification steps**:
```bash
cd packages/providers && pnpm vitest run
```
用例:sdkOptions 断言(maxTurns/maxBudgetUsd 落进 query options);构造 StdoutMessage active_goal → chunk 输出断言;result{subtype:error_max_turns,num_turns:4} → error chunk 含 terminalReason='max_turns'+numTurns=4;常规 result success 路径回归。
**Pass criteria**: 全绿
**Failure handling**: Max 3 fix attempts, then mark SKIP with reason

## Exploration

Analog studied: `effort-passthrough.test.ts` + `claude-provider.test.ts`(mock `@anthropic-ai/claude-agent-sdk` 的 `query`，断言 `mockQuery.mock.calls[0][0].options` 与 chunk 序列)。

SDK 事实核对(@anthropic-ai/claude-agent-sdk@0.3.235 sdk.d.ts):
- **:38 `AgentDefinition`**:`maxTurns?: number`(:75 "Maximum number of agentic turns (API round-trips) before stopping")、`background?: boolean`(:79 "Run this agent as a background task (non-blocking, fire-and-forget)")、`skills?: string[]`(:65)——现状 toClaudeAgentDef(provider.ts:175-183)只传 description/prompt/tools/model/effort,maxTurns/background/skills 全被静默丢弃。
- **:3015 `SDKActiveGoalMessage`**:顶层 StdoutMessage type(:7764 联合成员,非 system subtype)——`{ type:'active_goal'; value: { condition: string; iterations: number; set_at: number; tokens_at_start: number; last_reason?: string } | null; uuid; session_id }`。**value 可为 null**(goal 被清除/met 时,doc:"value is null when the goal is cleared")→ chunk 变体 condition 定为 `string | null` 以保真表达 cleared,不伪造空串。
- **:4577 `SDKResultError`**:`subtype: 'error_during_execution' | 'error_max_turns' | 'error_max_budget_usd' | ...`、`num_turns: number`、`total_cost_usd: number`、`terminal_reason?: TerminalReason`、`session_id: string`。
- **:7911 `TerminalReason`** 含 `'max_turns'`/`'budget_exhausted'`(注意:预算超支时 SDK 原值是 `budget_exhausted`,非本 feature 词表的 `max_budget_usd`)→ **terminalReason 由 subtype 推导**(error_max_turns→'max_turns'、error_max_budget_usd→'max_budget_usd'),与 spec 词表(K3/ticket 03 白名单)一致,不直接透传 SDK 原字段。
- **:1725/1730 `Options`**:`maxTurns?: number`、`maxBudgetUsd?: number`("returning an `error_max_budget_usd` result")。

引擎消费面核查:`agent-runner.ts:141` 的 `switch (chunk.type)` 无 `never` 穷尽断言 → 新增联合变体不破坏 engine 编译(03 负责加 case)。pi provider 只 yield 现有类型,零改动(AC5)。

需改文件(仅 packages/providers):
1. `src/types.ts` — SendQueryOptions 加 `maxTurns?: number`;MessageChunk 加 `active_goal` 变体 + `error` 变体扩 `numTurns?/costUsd?/sessionId?/terminalReason?: 'max_turns'|'max_budget_usd'`。
2. `src/claude/provider.ts` — sdkOptions 加 maxTurns/maxBudgetUsd;toClaudeAgentDef 补 maxTurns/background/skills;if-chain 顶层加 `event.type === 'active_goal'` 分支;:524-530 与 :563-569 两处 error 分支统一扩展保真字段。
3. `src/__tests__/claude-goal-plumbing.test.ts` — 新测试(verification 用例如上)。

## Verification — PASS

- `pnpm vitest run src/__tests__/claude-goal-plumbing.test.ts` → **14/14 green**(sdkOptions 映射、AgentDefinition maxTurns/background/skills、active_goal 转 chunk(含 value:null cleared→condition:null)、error_max_turns/modelUsage+fallback 双分支 terminalReason/numTurns/costUsd/sessionId、error_during_execution 无 terminalReason、不 throw、success 双路径回归)。
- `pnpm --filter @octopus/providers build` → DTS build success。
- 全包 `pnpm vitest run` → 155 passed / 11 failed;**11 项失败为 pi/ 既有基线**(stash 本工单 3 文件后跑 `src/__tests__/pi/` 结果完全一致:同 11 failed),本工单零新增失败(AC5:pi 行为不变)。
- 偏差说明:① SDK 公开 `SDKMessage` TS union 不含 active_goal(仅内部 StdoutMessage),但 sdk.mjs `readMessages` 运行时确会 enqueue——provider 分支用 `as {type:string}` cast 规避 TS2367;② SDK 原始 `terminal_reason` 对预算超支拼作 `'budget_exhausted'`,故 terminalReason 由 **subtype 推导**('max_turns'/'max_budget_usd'),与 spec 词表及 ticket 03 白名单一致;③ SDKActiveGoalMessage.value 可为 null(goal cleared/met),chunk 以 `condition: null` 保真表达,不伪造空串。

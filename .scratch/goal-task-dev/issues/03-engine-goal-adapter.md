# 03 — engine:/goal 薄适配器 + 终态映射 + 全量注入(含真跑集成)

## What to build
goal 节点的真收敛执行:executor 把 goal 文本装配为 `/goal <condition>` 首行(插值全文);节点新字段解析并传给 runner;runner 不吞终态与事件;`error_max_turns/budget` → 节点 failed + goal_evidence。含两组真实 claude 执行验证(收敛向/不收敛向)——这是本需求的心脏。

## Blocked by
01(shared 字段契约)、02(providers chunk/option 面)

## Status
ready-for-human — engine lane complete & verified; AC5's `active_goal`-in-JSONL sub-assertion is blocked by a **cross-package finding** (claude CLI 2.1.250 never emits `active_goal` on headless stdout; needs a providers follow-up, outside ticket-03 ownership). Details in ## Verification below.

## Acceptance Criteria
- [x] AC1: buildGoalPrompt 重构——首行 `/goal <插值后全文>`;删 Allowed/Disallowed Tools 段;上下文全量注入(截断全删)— 单元 16/16
- [x] AC2: resolveNodeNumber(number 直取/string→substituteVarsFull→Number/无效→undefined+warn-once);maxTurns/maxBudgetUsd/tools/disallowedTools 传入 runner.run — 单元覆盖(含 wire 断言到 provider sendQuery options)
- [x] AC3: runner error+terminalReason 不 throw→AgentRunResult 终态;active_goal chunk→AgentEvent 进 events;普通 error 回归仍 throw — 单元 6/6
- [x] AC4: executor 终态映射 failed + `goal_not_met (<reason>)` + goal_evidence(最后 active_goal + terminalMeta)— 单元(fake runner)+ **真跑 B 场景锤实**
- [~] AC5: 真跑收敛 A1/A2 PASS(completed + hello.txt=GTD_OK);A3「JSONL 含 active_goal」**FAIL — 非 engine 缺陷**,见 Verification 根因
- [x] AC6: 真跑不收敛:node failed + error `goal_not_met (max_turns)` + evidence `{"numTurns":4,"costUsd":0.21}` — 两向实跑复现一致
- [x] AC7: 基线失败集零新增(4 files:octopus-wf-e2e-tester / outputs-resolver / pr-workflows / swarm-host-agent,测试名级 diff 为空;846→847 passed 全为本工单新增用例)

## Verification — PARTIAL PASS(引擎全绿;AC5·A3 阻塞在 providers 面)

**命令与结果**:
- `pnpm --filter @octopus/engine build` → DTS green(修复了 stage-1 遗留的 agent.ts `node.planning` ×5 编译错)
- `pnpm --filter @octopus/engine test` → `Test Files 4 failed | 67 passed (71)`,`Tests 4 failed | 847 passed`;失败文件集与改动前基线 **完全相同**(test-name 级 comm 为空)
- `node scripts/goal-realrun-probe.mjs`(真 claude CLI 2.1.250,两轮实跑,共 ~$0.42)→ 5/6 PASS;产物已拷 `.scratch/goal-task-dev/e2e-data/`(converge/not-converge 的 jsonl + summary.json)供 07 复用

**A3 根因(二进制定位,锤实)**:claude.exe 2.1.250 的 stdout 写出谓词 `Bg()` 无条件排除 `e.type==="active_goal"`(另有 stream 白名单 `lt.active_goal:false`);该事件只服务远端/TUI 面(doc:"Any surface with a goal indicator re-renders from this")。`--include-hook-events`、`--include-partial-messages` 实测均不产出(三轮 raw CLI 事件普查为零)。SDK 侧 `readMessages` 虽有 enqueue 分支,但 CLI 从不写出 → **headless 恒不可达**。ticket 02 的单测(mock StdoutMessage)证明 provider 分支正确,但该分支在当前 CLI 下是死代码(向前兼容保留)。

**evaluator 证据在 headless 的唯一出口**:`user` isMeta 合成消息 `"Stop hook feedback:\n[<condition>]: <reason>"`(transcript 实锤;每轮 not-met 一条)——provider `event.type==='user'` 直接 `continue` 丢弃,engine 拿不到。**修复点 = providers(1 个分支)**:识别 isMeta Stop-hook-feedback user 消息 → yield ActiveGoalChunk(condition=[..] 内文本、iterations=计数、last_reason=冒号后文本),engine 透传链已就绪零改动;合入后 probe A3 自动转绿(可移除 `GOAL_PROBE_A3=WARN` 降级开关)。

**真跑行为快照**:收敛向 11-16s completed、文件断言 PASS;不收敛向 max_turns:3 → num_turns=4 error_max_turns → 节点 failed、error `goal_not_met (max_turns)`、goal_evidence `{numTurns:4,costUsd:0.21}`(与 K5 实测口径一致;iterations/last_reason 待 providers 修复后补齐)。

## Exploration

Analog studied: `agent-goal-mode.test.ts`(mock runner 断 `mockRun.mock.calls[0][0]`)+ `agent-runner.test.ts`(mock `IAgentProvider.sendQuery` async-generator 产 MessageChunk 序列)。两者即本工单测试 seam。

**基线记录**(改动前):
- `pnpm --filter @octopus/engine test` → 4 failed files:octopus-wf-e2e-tester、outputs-resolver、pr-workflows、swarm-host-agent(66 passed)。终态对比以此集合为准,零新增。
- `pnpm build`(tsup --dts)当前失败,src 内**仅** agent.ts 的 5 处 `node.planning` 引用(agent.ts:377-399)。src 其余 tsc --noEmit 报错(executor-factory precomputeHook、swarm strategies timeout_exceeded、task-dispatch 等)不在 tsup dts rollup 图上,为既有基线,不归本工单。

JSONL/SSE 泛化核实:runner 事件经 executor-factory:198 `logger.log(node.id,"agent_event",{event_data})` + `onAgentEvent` callback 入链;`mergeAgentEvents`(logger.ts:383)对未知 agent_event subtype **pass-through** → `active_goal` 事件零改动即落 JSONL。

provider 面事实(02 handoff + claude/provider.ts 实读):`error` chunk 携 `terminalReason?: 'max_turns'|'max_budget_usd'`(subtype 推导,已归一)+ `numTurns/costUsd/sessionId`;`active_goal` chunk `{type, condition: string|null, iterations, last_reason?, set_at?}`(condition:null = met/cleared 收敛信号)。

需改文件(仅 packages/engine):
1. `executors/agent-types.ts` — AgentEvent 加 `active_goal` 变体;AgentRunResult 加 `terminalReason?` + `terminalMeta?{numTurns?,costUsd?}`
2. `executors/agent-runner.ts` — run() opts 加 `maxTurns/maxBudgetUsd/tools` → sendQuery options;switch `error` case:有 terminalReason → 不 throw、置 terminal、退出流、返回带终态的 AgentRunResult;`active_goal` case → emit AgentEvent
3. `executors/agent.ts` — buildGoalPrompt 重写(首行 `/goal <插值全文>`,删 Allowed/Disallowed Tools 段与 planning 全部引用,删 verify 分支);buildGoalContext 删 20-key/100字/200字截断;`resolveNodeNumber`(private method,string→substituteVarsFull→Number,无效→undefined+实例级 warn-once);run 调用追加 4 字段;terminalReason→failed+`goal_not_met (<reason>)`+outputs.goal_evidence(倒扫 result.events 取最后 active_goal 的 iterations/last_reason + terminalMeta)
4. `__tests__/agent-goal-mode.test.ts` — 重写 2 个 planning 用例;新增:/goal 首行、>200 字上游输出 VERBATIM、>20 变量全量、resolveNodeNumber 表(number/string/$inputs/无效→undefined)、terminal 映射(fake runner)
5. `__tests__/agent-goal-runner.test.ts`(新)— runner 层:error+terminalReason 不 throw→AgentRunResult 终态;active_goal→events;普通 error 仍 throw(回归)
6. `scripts/goal-realrun-probe.mjs`(repo 根,工单指定)— engine dist API 直驱两场景

**未采用**:engine 自建 loop/evaluator(K1 否决);`chunk.terminalReason` 直接透传 SDK 原值(provider 已归一,engine 侧只消费)。

## Acceptance Criteria
- [ ] AC1: buildGoalPrompt 重构——首行 `/goal <插值后全文>`;删 ## Allowed/Disallowed Tools 段;## Previous Node Results / ## Available Variables **删除 20-key/100字/200字全部截断**,全量注入
- [ ] AC2: `resolveNodeNumber`:number 直取;string→substituteVarsFull→Number;无效→undefined+warn 一次;run 传 maxTurns/maxBudgetUsd/tools/disallowedTools
- [ ] AC3: runner:`error_max_*` chunk 不 throw → AgentRunResult{terminalReason,terminalMeta};switch 新增 active_goal case → AgentEvent 进 events;其余 chunk 行为不变
- [ ] AC4: executor 终态映射:terminalReason 存在 → {status:'failed', error:'goal_not_met (max_turns|max_budget_usd)', outputs.goal_evidence={iterations?,numTurns?,last_reason?}}(证据取最后 active_goal 事件+terminalMeta)
- [ ] AC5: **真跑收敛**:最小 YAML(goal="创建 hello.txt 内容 GTD_OK"),claude 实跑 → 节点 completed、文件存在、JSONL 含 active_goal 记录
- [ ] AC6: **真跑不收敛**:goal="说出 7,每轮只说一个递增数字" × max_turns: 3 → 节点 failed、error 含 goal_not_met、evidence.numTurns>0(镜像已验证探针)
- [ ] AC7: 既有 engine agent 测试基线不新增失败(13 文件既有失败集不变)

## Verification Method
**Verification type**: 单元 + 真实执行集成
**Verification steps**:
```bash
cd packages/engine && pnpm vitest run src/__tests__/agent-goal-mode.test.ts  # 装配/映射单测
# 真跑(临时 workspace,脚本存 .scratch/goal-task-dev/e2e-data/ 供 07 复用)
node scripts/goal-realrun-probe.mjs   # AC5/AC6 两向,断言文件+JSONL subtype
pnpm vitest run && pnpm build
```
断言:prompt 装配单测含 >200 字上游输出原样出现(截断移除)、/goal 前缀、string max_turns 解析。
**Pass criteria**: AC1-AC7 全 PASS(R1:真 claude CLI,非 mock)
**Failure handling**: Max 3 fix attempts, then mark SKIP with reason

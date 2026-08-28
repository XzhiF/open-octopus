# 03 — engine:/goal 薄适配器 + 终态映射 + 全量注入(含真跑集成)

## What to build
goal 节点的真收敛执行:executor 把 goal 文本装配为 `/goal <condition>` 首行(插值全文);节点新字段解析并传给 runner;runner 不吞终态与事件;`error_max_turns/budget` → 节点 failed + goal_evidence。含两组真实 claude 执行验证(收敛向/不收敛向)——这是本需求的心脏。

## Blocked by
01(shared 字段契约)、02(providers chunk/option 面)

## Status
ready-for-agent

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

# 06 — Workflow Agent Node Experience Integration (VarPool Bridge)

## What to build
通过 VarPool 桥接模式将经验注入工作流 Agent 节点。Server 端在 precompute hook 中预计算经验 segment 写入 VarPool，Engine 端在 AgentExecutor.buildPrompt() 中读取并注入。

## Blocked by
01 — ContextEnricher Core

## Status
ready-for-agent

## Acceptance Criteria
- [ ] AC-1: Server precompute hook 调用 ContextEnricher.enrich({scope:'workflow', forceSearch:true})
- [ ] AC-2: 结果写入 VarPool `__experience_segment` key
- [ ] AC-3: Engine AgentExecutor.buildPrompt() 读取 `__experience_segment` 并 prepend 到 prompt
- [ ] AC-4: Goal-mode agents (`buildGoalPrompt()`) 也注入经验
- [ ] AC-5: 无相关经验时 VarPool key 为空，不注入
- [ ] AC-6: 现有知识规则注入不受影响

## Verification Method
**Verification type**: unit test + integration test

```bash
# Server side
pnpm --filter @octopus/server exec vitest run src/__tests__/experience-precompute.test.ts

# Engine side
pnpm --filter @octopus/engine exec vitest run src/__tests__/agent-executor.test.ts
```

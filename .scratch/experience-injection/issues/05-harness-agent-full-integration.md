# 05 — Harness Agent Full Integration

## What to build
将 HarnessPromptAdapter 真正接入 AgentDelegationService 生产路径。补上 daily memory 加载、FTS5 历史案例搜索、stats 注入迁移。修复 C2（adapter 孤儿）问题。

## Blocked by
01 — ContextEnricher Core

## Status
ready-for-agent

## Acceptance Criteria
- [ ] AC-1: `AgentDelegationService.buildPromptWithHistory()` 使用 HarnessPromptAdapter 组装基础 prompt
- [ ] AC-2: `HarnessPromptAdapter.loadDailyMemory()` 读取 daily/YYYY-MM-DD.md（500t 预算）
- [ ] AC-3: `HarnessPromptAdapter.loadExperienceContext(report)` 调用 ContextEnricher（scope=harness, forceSearch=true）
- [ ] AC-4: Stats 注入从 AgentDelegationService 移入 HarnessPromptAdapter
- [ ] AC-5: 最终 prompt 包含：persona + long-term + daily + 历史案例 + 成功率 + 诊断报告 + session history
- [ ] AC-6: 现有 harness delegation 测试不受影响（回归测试）
- [ ] AC-7: 无干预历史时 gracefully 降级（experience segment = null）

## Verification Method
**Verification type**: unit test + integration test

```bash
pnpm --filter @octopus/server exec vitest run src/__tests__/prompt-assembler.test.ts
pnpm --filter @octopus/server exec vitest run src/__tests__/harness-delegation-integration.test.ts
```

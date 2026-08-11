# 04 — Clone Agent Experience Integration

## What to build
在 CloneRuntime.assembleContext() 中追加经验加载，调用 ContextEnricher 获取相关历史经验。Clone 看到自己 scope + global 的经验。

## Blocked by
01 — ContextEnricher Core

## Status
ready-for-agent

## Acceptance Criteria
- [ ] AC-1: CloneRuntime.assembleContext() 调用 ContextEnricher
- [ ] AC-2: scope='agent'，可见性 [agent, global]
- [ ] AC-3: 经验内容附加在 memory 之后
- [ ] AC-4: 预算 800 tokens
- [ ] AC-5: 现有 clone 聊天行为不受影响（snapshot 回归）

## Verification Method
**Verification type**: unit test

```bash
pnpm --filter @octopus/server exec vitest run src/__tests__/clone-runtime.test.ts
```

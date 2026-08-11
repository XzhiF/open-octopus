# 03 — Main Agent Experience Integration

## What to build
在 SystemPromptAssembler 中新增 `buildExperienceSegment()` 方法（P3.5 优先级），调用 ContextEnricher 搜索相关经验并注入 prompt。智能触发：仅当用户消息匹配关键词时搜索。

## Blocked by
01 — ContextEnricher Core
02 — User Message Wiring

## Status
ready-for-agent

## Acceptance Criteria
- [ ] AC-1: `buildExperienceSegment(userMessage)` 方法存在
- [ ] AC-2: 关键词匹配时调用 ContextEnricher.enrich({scope:'agent'})
- [ ] AC-3: 无关键词匹配时返回 null（不搜索，不注入）
- [ ] AC-4: Segment 优先级 P3.5（memory 和 skills 之间）
- [ ] AC-5: 预算 800-1200 tokens
- [ ] AC-6: 快照测试验证现有 prompt 输出不变（无关键词时）

## Verification Method
**Verification type**: unit test + snapshot test

```bash
pnpm --filter @octopus/server exec vitest run src/__tests__/prompt-assembler.test.ts
```

# 02 — User Message Wiring (AssembleOptions 扩展)

## What to build
扩展 SystemPromptAssembler 的 AssembleOptions 接口，增加 `userMessage` 字段。修改两个 chat routes 传入用户消息。这是智能触发的必要前提。

## Blocked by
None — can start immediately

## Status
ready-for-agent

## Acceptance Criteria
- [ ] AC-1: `AssembleOptions` 接口增加 `userMessage?: string` 字段
- [ ] AC-2: `main-agent-route.ts` 调用 `assemble()` 时传入 `body.message`
- [ ] AC-3: `chat-routes.ts` 调用 `assemble()` 时传入 `body.message`
- [ ] AC-4: 现有测试不受影响（userMessage 为 optional）

## Verification Method
**Verification type**: unit test + snapshot regression

```bash
pnpm --filter @octopus/server exec vitest run src/__tests__/prompt-assembler.test.ts
```

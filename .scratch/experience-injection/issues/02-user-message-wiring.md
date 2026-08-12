# 02 — User Message Wiring (AssembleOptions 扩展)

## What to build
扩展 SystemPromptAssembler 的 AssembleOptions 接口，增加 `userMessage` 字段。修改两个 chat routes 传入用户消息。这是智能触发的必要前提。

## Blocked by
None — can start immediately

## Status
done

## Acceptance Criteria
- [x] AC-1: `AssembleOptions` 接口增加 `userMessage?: string` 字段
- [x] AC-2: `main-agent-route.ts` 调用 `assemble()` 时传入 `body.message`
- [x] AC-3: `chat-routes.ts` 调用 `assemble()` 时传入 `body.message`
- [x] AC-4: 现有测试不受影响（userMessage 为 optional）

## Verification Method
**Verification type**: unit test + snapshot regression

```bash
pnpm --filter @octopus/server exec vitest run src/__tests__/prompt-assembler.test.ts
```

## Exploration
**Analog studied**: Existing `AssembleOptions` pattern — `clone_name`, `scheduled_task`, `include_skills` are all optional fields that are passed through at call sites and consumed (or ignored) by segment builders.

**Files modified**:
- `packages/server/src/services/agent/system-prompt-assembler.ts` — added `userMessage?: string` to `AssembleOptions` interface
- `packages/server/src/services/agent/prompt-assembler.ts` — `ChatPromptAdapter.assemble()` and `assembleForClone()` pass `userMessage` through to underlying `SystemPromptAssembler`
- `packages/server/src/routes/agent/main-agent-route.ts:299` — `assembler.assemble({ userMessage: body.message })`
- `packages/server/src/routes/agent/chat-routes.ts:86` — `assembler.assemble({ ..., userMessage: body.message })`
- `packages/server/src/__tests__/prompt-assembler.test.ts` — added test verifying field is accepted and passthrough works

**Decision**: `AssembleForAgentOpts extends AssembleOptions` inherits `userMessage` automatically — no separate wiring needed in that interface. The `userMessage` field is purely additive (optional) and does NOT change behavior until ticket 03 adds the experience segment builder.

# 02 — Unified Prompt Assembler (Adapter Pattern)

## What to build
用 Adapter 模式统一三套 prompt 组装系统（SystemPromptAssembler、CloneRuntime.assembleContext、buildDelegationPrompt）为一个 `PromptAssembler` 接口。加 E2E 快照测试确保现有 Agent 行为不变。

## Blocked by
None — can start immediately (independent of schema migration)

## Status
done

## Acceptance Criteria
- [x] AC-1: 定义 `PromptAssembler` 接口，含 `assembleForAgent(cloneName?, opts)` 统一入口
- [x] AC-2: 现有 SystemPromptAssembler 逻辑包装为 `ChatPromptAdapter`
- [x] AC-3: 现有 CloneRuntime.assembleContext 逻辑包装为 `ClonePromptAdapter`
- [x] AC-4: 现有 buildDelegationPrompt 逻辑包装为 `HarnessPromptAdapter`
- [x] AC-5: 主 Agent 调用 assembleForAgent() 输出与统一前一致（快照测试）
- [x] AC-6: Clone 调用 assembleForAgent('clone-name') 输出与统一前一致（快照测试）
- [x] AC-7: Harness 调用 assembleForAgent('harness-agent') 输出包含 persona + memory
- [x] AC-8: priority-based budget truncation 逻辑保持不变
- [x] AC-9: 现有 Clone 聊天行为不受影响（E2E 回归）

## Verification Method
**Verification type**: unit test + E2E snapshot test

**Verification steps**:
```bash
# 1. Snapshot tests for each adapter
pnpm --filter @octopus/server exec vitest run --reporter=verbose src/__tests__/prompt-assembler.test.ts

# 2. E2E regression for existing clones
pnpm --filter @octopus/web-app exec playwright test --grep "clone"

# 3. Verify harness persona loading
pnpm --filter @octopus/server exec vitest run --reporter=verbose src/__tests__/harness-prompt.test.ts
```

**Pass criteria**: All 9 ACs pass, snapshot diffs are zero
**Failure handling**: Max 3 fix attempts, then mark SKIP with reason

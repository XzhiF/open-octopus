# 01 — shared schema: workflow_ref in TaskSpecField

## What to build
`TaskSpecFieldSchema` (shared) 加 `workflow_ref` 成员；`validateSpecFieldValue` 增加分支：non-empty string。
- 共享 validator 供 server / tests / future SDK 复用
- `EXPECTED_SPEC_FIELDS` 测试常量同步加入 `workflow_ref`（以及历史遗留的 `decisions`）

## Blocked by
None

## Status
done

## Acceptance Criteria
- [x] AC3: schema 包含 `workflow_ref`，validate 拒 empty / non-string
- [x] AC7: 与 server 端 fail-fast 共享同一 validator

## Verification Method
`pnpm vitest run packages/shared/src/__tests__/task-domain-schema.test.ts`

## Implementation notes
- 文件：`packages/shared/src/types/task.ts`（enum + validator）
- 测试：`packages/shared/src/__tests__/task-domain-schema.test.ts`
- 未触及 server / web-app 代码

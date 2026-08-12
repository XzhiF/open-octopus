# 01 — Shared 类型定义 + 配置默认值

## What to build
在 `@octopus/shared` 中新增 harness 模块：类型定义、配置 schema、默认配置文件。这是所有后续 ticket 的基础。

## Blocked by
None — can start immediately

## Status
done

## Acceptance Criteria
- [x] AC1: `packages/shared/src/harness/types.ts` 定义 DiagnosisReport、InterventionAction、HarnessDirective（含 inject 类型）、NodeStatus 扩展（harness_intervening/modified/executed）
- [x] AC2: `packages/shared/src/harness/config-schema.ts` 定义 Zod schema 验证 harness.yaml 结构
- [x] AC3: `packages/shared/src/harness/harness-defaults.yaml` 包含完整的默认配置（4 个 detector + 策略表 + 隔离配置）
- [x] AC4: `packages/shared/src/harness/index.ts` 导出所有类型
- [x] AC5: `packages/shared/src/index.ts` 导出 harness 模块

## Verification Method
**Verification type**: unit test

**Verification steps**:
1. `pnpm --filter @octopus/shared build` — 编译通过
2. `pnpm --filter @octopus/shared test` — Zod schema 验证测试通过
3. TypeScript 类型导入测试: `import { DiagnosisReport } from '@octopus/shared'`

**Pass criteria**: 所有 AC 通过编译和测试

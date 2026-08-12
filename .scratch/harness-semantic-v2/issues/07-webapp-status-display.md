# 07 — Web-App Harness Status Display + Log Rendering

## What to build
前端显示执行级 harness 状态 + 日志中 5 种决策类型的差异化渲染。

## Blocked by
01 — Shared Types + DB Migration
05 — DetectorPipeline Decision Execution + Harness Status Update

## Status
done

## Acceptance Criteria
- [x] AC1: 执行列表 API 响应包含 harnessStatus 和 harnessSummary 字段
- [x] AC2: web-app Execution 接口增加 harnessStatus/harnessSummary 可选字段
- [x] AC3: 执行列表中被干预的执行显示 harness 图标（intervened: 🛡️, blocked: 🛡️❌, delegated: 🤖）
- [x] AC4: 日志渲染区分 5 种决策类型（不同图标和文案）
- [x] AC5: harness_modified 和 harness_executed 节点状态在 flow viewer 正确显示

## Verification Method
**Verification type**: browser E2E

**Verification steps**:
1. 执行 test-process-conflict → 检查执行列表显示 blocked 状态
2. 执行 test-stupid-retry → 检查日志显示 harness 决策
3. 检查 flow viewer 中节点 harness 图标

**Pass criteria**: UI 正确显示所有 harness 状态和决策类型

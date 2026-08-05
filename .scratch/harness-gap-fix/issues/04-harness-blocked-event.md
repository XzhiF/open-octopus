# 04 — 发射 harness_blocked 事件 + 清理死代码

## What to build
(1) 当 process_conflict 策略匹配并执行 abort 动作时，额外发射 `harness_blocked` SSE 事件，使前端能显示阻断通知。(2) 修复或删除 `getWrappedCallbacks()` 死代码方法。

## Blocked by
- 01 (Proxy decision callbacks) — harness_blocked 的 onBeforeNode skip 逻辑需要与 pendingActions 机制协调

## Status
ready-for-agent

## Acceptance Criteria
- [ ] AC1: process_conflict + abort 策略执行时，SSE 发出 `harness_blocked` 事件
- [ ] AC2: `harness_blocked` 事件包含 executionId、nodeId、reason、pattern
- [ ] AC3: `getWrappedCallbacks()` 要么修复为返回实际 wrapped callbacks，要么删除（如无调用者）
- [ ] AC4: 新增单元测试验证 harness_blocked 事件发射

## Verification Method
**Verification type**: unit test

**Verification steps**:
```bash
cd packages/server
npx vitest run src/services/harness/__tests__/
```

**Pass criteria**: harness_blocked 事件测试 PASS
**Failure handling**: Max 3 fix attempts, then mark SKIP with reason

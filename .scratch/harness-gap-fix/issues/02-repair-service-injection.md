# 02 — 注入 repairService 到 HarnessController

## What to build
在 ExecutionLifecycle 构造 HarnessController 时传入 repairService，使 `inject_message` 动作能够成功调用 `repairService.intervene()` 注入消息到 agent session。

## Blocked by
None — can start immediately

## Status
done

## Acceptance Criteria
- [x] AC1: ExecutionLifecycle 构造函数接收 repairService 参数
- [x] AC2: HarnessController 构造时收到 repairService
- [x] AC3: `inject_message` action 调用 `repairService.intervene()` 成功
- [x] AC4: 更新/新增单元测试验证 inject_message 端到端调用

## Verification Method
**Verification type**: unit test

**Verification steps**:
```bash
cd packages/server
npx vitest run src/services/harness/__tests__/
```

**Pass criteria**: inject_message action 测试 PASS，repairService.intervene 被调用
**Failure handling**: Max 3 fix attempts, then mark SKIP with reason

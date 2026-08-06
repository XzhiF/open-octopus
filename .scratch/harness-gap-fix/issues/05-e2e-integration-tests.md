# 05 — E2E 集成测试：真实干预闭环

## What to build
编写 Playwright E2E 测试，验证 harness 干预闭环：运行一个会触发傻重试检测的 workflow → 验证 SSE 事件到达前端 → 验证悬浮面板显示 → 验证 chatbot inject 成功。

## Blocked by
- 01 (Proxy decision callbacks) — 干预闭环依赖决策回调连接
- 02 (repairService injection) — inject 依赖 repairService
- 03 (frontend bug fixes) — chatbot 依赖 nodeId 修复
- 04 (harness_blocked event) — blocked 事件验证

## Status
done

## Acceptance Criteria
- [x] AC1: Playwright 测试：运行 harness_test workflow → 面板出现并显示 harness_diagnosis 事件
- [x] AC2: Playwright 测试：面板显示 harness_intervention 事件（harnessHint 被注入）
- [x] AC3: Playwright 测试：chatbot 发送 inject 指令 → mock 返回 200 → 面板显示成功消息
- [x] AC4: Playwright 测试：totalExtraTokens 在面板中显示（当事件包含 token 信息时）
- [x] AC5: 所有现有 harness E2E 测试继续通过

## Verification Method
**Verification type**: browser E2E

**Verification steps**:
```bash
cd packages/web-app
npx playwright test e2e/harness-e2e.spec.ts
```

**Pass criteria**: 所有 E2E 测试 PASS（包括新增和现有的）
**Failure handling**: Max 3 fix attempts, then mark SKIP with reason

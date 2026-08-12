# 03 — 修复 chatbot nodeId + totalExtraTokens

## What to build
修复两个前端 bug：(1) chatbot 发送 inject 指令时缺少 `nodeId` 字段导致服务端 400；(2) `totalExtraTokens` 计算逻辑错误，永远返回 0。

## Blocked by
None — can start immediately (frontend only)

## Status
done

## Acceptance Criteria
- [x] AC1: `harness-chatbot.tsx` POST body 包含 `nodeId` 字段
- [x] AC2: HarnessChatbot 接收 `currentNodeId?: string` prop
- [x] AC3: `WorkflowDetailPanel` 传入当前活跃节点 ID 给 HarnessChatbot（通过 HarnessFloatingPanel 透传）
- [x] AC4: `use-harness-events.ts` 的 `totalExtraTokens` 正确从事件中提取 token 数
- [x] AC5: 更新单元测试覆盖 nodeId 和 token 计算

## Verification Method
**Verification type**: unit test + manual

**Verification steps**:
```bash
cd packages/web-app
npx vitest run components/workspace/__tests__/harness-floating-panel.test.tsx
```

**Pass criteria**: 测试 PASS，POST body 包含 nodeId
**Failure handling**: Max 3 fix attempts, then mark SKIP with reason

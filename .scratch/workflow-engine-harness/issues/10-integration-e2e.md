# 10 — ExecutionLifecycle 集成 + 端到端测试

## What to build
将 HarnessController 集成到 ExecutionLifecycle.start() 中。创建端到端测试 workflow 验证完整流程。

## Blocked by
02 (engine callbacks), 03 (harness controller), 05 (process isolation), 06 (DB migration)

## Status
done

## Acceptance Criteria
- [x] AC1: `ExecutionLifecycle.start()` 中用 HarnessController 包装 EngineCallbacks
- [x] AC2: 每个 execution 创建独立的 HarnessController 实例 + 检测器实例
- [x] AC3: execution 完成/失败时调用 HarnessController.destroy() 清理检测器
- [x] AC4: 端到端测试 workflow: harness_test_stupid_retry — 验证完整傻重试纠正流程
- [x] AC5: 端到端测试 workflow: harness_test_process_conflict — 验证进程冲突阻断
- [x] AC6: 端到端测试 workflow: harness_test_model_mismatch — 验证模型自动切换
- [x] AC7: 端到端测试: harness_events 表记录完整 + SSE 事件正确推送 + 节点状态正确

## Verification Method
**Verification type**: integration test (full stack)

**Verification steps**:
1. `pnpm dev` 启动 dev 环境
2. 运行 harness_test_stupid_retry workflow → 验证:
   - harness_events 有 diagnosis + intervention 记录
   - 节点状态: failed → harness_modified → running → completed
   - SSE 推送 harness_diagnosis + harness_intervention
3. 运行 harness_test_process_conflict → 验证:
   - 宿主进程存活
   - 节点被阻断 (status: failed, harness_status: harness_blocked)
4. 运行 harness_test_model_mismatch → 验证:
   - 模型被切换
   - 节点重试成功

**Pass criteria**: 3 个端到端场景全部通过

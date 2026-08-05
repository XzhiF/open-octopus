# 06 — Dynamic Sub-Workflow Compatibility

## What to build
更新 dynamic_sub_workflow 的三层验证系统（L1/L2/L3），使其支持 octopus_agent 类型节点。更新 LLM 生成 prompt 以允许生成 octopus_agent 节点。

## Blocked by
02 — Shared Types + Registration (需要 octopus_agent 的 Zod schema)
03 — OctopusAgentExecutor (需要 executor 可用以执行动态生成的节点)

## Status
done

## Acceptance Criteria
- [x] AC1: L3 验证 `ALLOWED_TYPES` 从 `new Set(["agent"])` 扩展为 `new Set(["agent", "octopus_agent"])`
- [x] AC2: L1 结构验证: 对 `octopus_agent` 类型节点，不要求 `prompt` 字段，改为验证 `task.brief` 字段存在
- [x] AC3: LLM 生成 prompt 更新: 约束从 "ALL nodes must have type: agent" 改为 "nodes can have type: agent or octopus_agent"
- [x] AC4: 生成 prompt 中包含 octopus_agent 节点的示例 YAML（含 agent, version, task.brief, task.context）
- [x] AC5: L2 DAG 依赖验证: octopus_agent 节点的 depends_on 正确处理
- [x] AC6: 端到端测试: dynamic_sub_workflow 生成的 DAG 包含 octopus_agent 节点并成功执行
- [x] AC7: octopus_agent 节点在子 workflow 中的 VarPool 作用域正确（input_mapping/output_mapping 工作）
- [x] AC8: 子 workflow 中的 octopus_agent 节点 Heartbeat 事件冒泡到父 execution 的 SSE 流

## Verification Method
**Verification type**: integration test + E2E workflow execution

**Verification steps**:
```bash
# 1. Unit test: L3 validation
pnpm vitest run packages/engine/src/__tests__/dynamic-sub-workflow-validation.test.ts
# Expect: octopus_agent nodes pass L3 validation

# 2. Unit test: L1 structure validation
# Expect: octopus_agent without prompt but with task.brief passes L1

# 3. E2E: 创建包含 dynamic_sub_workflow 的 workflow
# dynamic_sub_workflow 生成包含 octopus_agent 的 DAG
# Expect: 执行成功完成

# 4. 验证 VarPool 作用域
# 子 workflow 中的 octopus_agent 能正确读取 input_mapping 的变量
# 结果通过 output_mapping 返回父 VarPool

# 5. 验证 Heartbeat 冒泡
# SSE 订阅父 execution → 收到子 workflow 中 octopus_agent 的 heartbeat 事件
```

**Pass criteria**: All 8 ACs pass, E2E dynamic sub-workflow with octopus_agent succeeds
**Failure handling**: Max 3 fix attempts, then mark SKIP with reason

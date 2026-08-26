# 07 — ready-gate 必填 inputs 校验

Type: grilling
Status: resolved
Blocked by: 05(resolved)

## Answer

**A(做必填校验)。** simple 任务(subunits<2,S3 同一分支)在入队 gate:
1. resolve workflow ref → parse workflow schema;
2. 对每个 `required: true` 的 input,取**模板解析后**的 input_values 值(替换 `${goal}`/`${ac}` 后的真值,不是原始模板串);
3. 空/缺失 → `missing.push("input:<name>")` → 409。
- composite(composition-task)跳过。
- 与现有 missing 列表(goal/ac/goal_confirmed/ac_confirmed/workflow_ref)并列,前端可见缺哪几个。
- 防"白执行"的最后闸:绑定表单填错必填会在入队时当场拦住,不在运行时炸。
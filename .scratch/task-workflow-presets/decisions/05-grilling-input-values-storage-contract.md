# 05 — input_values 存储与 spec-field 契约

Type: grilling
Status: resolved
Blocked by: 04(resolved)

## Answer

**存储: `task_spec.input_values`**(随 spec JSON 版本化,updateTask If-Match);引用放顶层 `workflow_ref` 列(指向),载荷放 spec(值)。

**写入通道:只走绑定弹窗 `updateTask` PUT**(与 workflow_ref 同一次原子提交);**不入 spec-field 枚举**(agent 澄清语义纯净)。

**物化合并**:`simpleInputValues = { ...resolve(task_spec.input_values), task_artifacts_dir, task_workflows_dir }` — 管理键(task_*_dir)最后写入优先。

**校验**:对象;键/值非空 string;单键值 ≤ 2KB 拒绝;非 string 拒绝;绑定即 fail-fast。

**不暴露给 agent**:input_values 是绑定期产物,agent 只需知道"已绑定 + 输入齐备",context.md/spec.json 不详细展开。
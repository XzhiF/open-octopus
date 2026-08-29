# 04 — 变量模板语法与保留名映射规则

Type: grilling
Status: resolved
Blocked by: 01(resolved)

## Question

绑定"其他内置工作流"时用 `${goal}`/`${ac}` 模板映射 input_values,需要定死:
1. 占位符集合:`${goal}` `${ac}` `${projects}` 还有吗?要不要 `${session}`?
2. 语法:与现有 `$vars.xxx` 体系怎么共存?用 `${...}` 避免歧义?
3. 保留输入名自动映射表(goal/requirement → goal;ac/acceptance_criteria → ac;projects → projects)是否采纳?
4. 缺值行为:模板引用的 WHAT 字段为空 → 绑定拒绝 / 留空 / 警告?required 时?
推荐一套可执行规则。

## 研究输入(01 resolved)

- 引擎不识别 `${goal}`;`$vars.goal` 原生可消费(经 pool.update 注入 + 执行期 substitute)。
- input_values 原样入池,无递归替换。
- 派生**双机制**倾向:
  - task-dev 契约 workflow → 直接用 `$vars.goal`/`$vars.ac`(物化注入 `goal/ac/projects` 键);
  - 其他内置 workflow → 用户 `input_values` 里写 `${goal}`,物化时一次性字符串替换为真值。
- 保留名自动映射表(requirement→goal 等)仍是"用户不写映射也自动填"的增强,待确认采纳与否。

## Answer

**语法(已定):**
- 占位符集合 = **`${goal}` `${ac}` 两个**,`${projects}` 删除(projects 已由 workspace_spec 供给,冗余;将来表驱动可扩)。
- `ac`(string[])串化 = **换行连接**(`"ac1\nac2"`);goal(string)直替。
- 语法是**物化前的 UI/契约约定**,非引擎语法;task-dev 契约 workflow 不用它,直接 `$vars.goal`/`$vars.ac`。
- **无保留名自动映射表** — 映射是 catalog inputs 里的显式 `${goal}`,不搞"名字撞了自动填"(回到魔法)。
- **缺值/未知占位符 = 绑定阶段 fail-fast**:拼错 / 引用空 WHAT 字段 → 绑定请求 400 + 明确信息,不静默留帧(与 ADR-0013 绑定预检一致)。
- 实现位:`materializeTaskSpecToConfig` 写 input_values 前做一次 `${...}` 替换(自写 `replace(/\$\{(\w+)\}/g, map)`),值取 task_spec.goal / task_spec.ac.join('\n')(join 按选型)。不存在则报错。
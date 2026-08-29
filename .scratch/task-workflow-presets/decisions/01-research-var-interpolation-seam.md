# 01 — 引擎现有变量插值缝(研究)

Type: research
Status: resolved
Blocked by: None

## Question

Engine 如何解析 input_values / 节点配置里的占位符(`$vars.xxx`、`$node-id.output.xxx`、`$last_output`、`$iteration`)?有没有现成缝可让 task 物化时把 `${goal}`/`${ac}` 模板替换进 input_values,还是必须物化前自处理?simpleInputValues 注入值(token dirs)的消费层在哪?

## Answer

**结论(3-6 行):**
1. 引擎所有占位符解析集中在 `packages/shared/src/variables/`:核心函数是 `substituteVars` (substitute.ts:4) 和增强版 `substituteVarsFull` (substitute-full.ts:15,处理 `{{#if}}` + `${var|filter}` + `$vars.xxx`)。`$last_output`/`$exit_code` 由 `resolveOutputsExpression` (outputs-resolver.ts:40) 在节点 `outputs:` 映射里处理;`$iteration` 在 substitute.ts:19 单列处理。
2. **`${goal}` 这种大括号无管道语法引擎不识别**——`substituteVars` 只吃 `$xxx.yyy`(`/\$([a-zA-Z0-9_.:-]+)/g`),`applyFilters` 必须带 `|`(regex `/\$\{([^{}|]+)\s*\|\s*([^{}]+)\}/g`)。所以 preset 的 `${goal}`/`${ac}` 不能在引擎侧消费,必须在物化前自替换,或改写为 `$vars.goal`/`$vars.ac` 走原生缝。
3. `input_values` 在 engine.ts:223 经 `pool.update(initialInputs)` **原样**灌入 VarPool,该层不做任何替换;真正的替换发生在每个 executor 渲染 prompt/script 时(agent.ts:327/365, bash.ts:82, approval.ts, interaction.ts 均调 `substituteVarsFull`)。所以引擎侧没有"input_values 解析层"可复用,注入只能放在物化侧。
4. `simpleInputValues`/`compositeInputValues` 构造于 `scheduler-service.ts:214-228`(`materializeTaskSpecToConfig`),随后写入 `workflow_chain[0].input_values`(composite 走 `COMPOSITION_WF_REF`);下游消费有两条路径——引擎通过 `pool.update` 读取供 `$vars.task_artifacts_dir` 等引用,`workflow-executor.ts` 在 `createFromSpec` 后读取作文件系统 setup(ADR-0013)。
5. **建议的 `${goal}` 接入点**:`materializeTaskSpecToConfig` 内 `simpleInputValues`/`compositeInputValues` 组装处(scheduler-service.ts:214-228),与 `task_artifacts_dir` 同模式追加 `goal`/`ac` 键。若保留 `${goal}` 语法,在写入前做字符串替换;若改用 `$vars.goal` 原生语法,则直接作为 input_values 键即可,引擎自动消费,无需新增替换代码(推荐)。

**关键文件 + 行号:**
- `packages/shared/src/variables/substitute.ts:4` — `substituteVars`(核心运行时替换,`$vars.`/`$inputs.`/`$hook.`/`$ref:`/`$iteration`/`$nodeId.output.xxx`)
- `packages/shared/src/variables/substitute-full.ts:15` — `substituteVarsFull`(节点 prompt 全管道:`{{#if}}` → `${var|filter}` → `substituteVars`)
- `packages/shared/src/variables/outputs-resolver.ts:40,103` — `resolveOutputsExpression` / `applyOutputsMapping`(`$last_output`/`$exit_code`/`$vars.x = expr`)
- `packages/shared/src/variables/expression.ts:68` — `evaluateExpression`(`execute_when`/`break_when` 条件)
- `packages/shared/src/notify/filters.ts:13` — `applyFilters`(唯一处理 `${...}` 的函数,但要求带 `|`)
- `packages/engine/src/engine.ts:200-238` — VarPool 构造 + `pool.update(initialInputs)`(input_values 入口,**无替换**)
- `packages/engine/src/executors/bash.ts:82`、`agent.ts:327/365`、`loop.ts:670` — 执行期调用 `substituteVarsFull` 的位置
- `packages/engine/src/executors/task-dispatch.ts:218-270` — `applyInputMapping`/`resolveMappingValue`(父子 schedule 间 input_values 透传,也走 substituteVars)
- `packages/server/src/services/scheduler/scheduler-service.ts:194-252` — `materializeTaskSpecToConfig` 和 `simpleInputValues`/`compositeInputValues` 组装(`task_artifacts_dir`/`task_workflows_dir`/`subunit_count` 注入点,即新 task 输入的推荐接入位)
- `packages/server/src/services/scheduler/executors/workflow-executor.ts` — 物化后读 `task_workflows_dir` 作 FS setup 的消费侧

**建议 `${goal}` 接入点:**
在 `materializeTaskSpecToConfig`(scheduler-service.ts:214-228)追加 `goal`/`ac` 到 `simpleInputValues` & `compositeInputValues`,与 `task_artifacts_dir` 完全同模式。优先采用 `$vars.goal`/`$vars.ac` 原生语法(零引擎改动,自动通过 pool.update → `$vars.xxx` 路径消费);若 UX 必须保留 `${goal}`,则在物化层用一次性字符串替换(可复用 `applyFilters` 但需补一个"无管道 plain 变量"分支,或自写 `text.replace(/\$\{(\w+)\}/g, ...)`),不要扩展引擎的 `substituteVars` 以免引入语法膨胀。

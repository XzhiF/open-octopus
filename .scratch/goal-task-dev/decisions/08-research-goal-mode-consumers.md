# 08 — Research: goal/loop 既有消费方影响面

Type: research
Status: resolved
Blocked by: None

## Question

goal 节点从"prompt 装配"变为"loop 形状"会波及哪些既有消费方(文件+行号级清单):

1. 全仓库现存 YAML 里带 `goal:` 的 agent 节点(cloud 里 grep core-pack、templates、~/.octopus/workflows、task home workflows 抽样),形状改变影响谁。
2. simulator(packages/engine src/simulate* 或 cli):goal 节点怎么 mock?loop 形状后 fixture 要不要 `iterations`?
3. web-app 工作流编辑器/详情/可视化:agent 节点 goal/constraints/planning 字段有无渲染(dagre 布局、属性面板);goal 变 loop 是否需要 UI 跟随。
4. CLI `workflow validate` + validate-workflow.js skill 脚本对 goal 节点的硬校验(goal/prompt 互斥等)。
5. SSE 事件流:loop 子节点事件已有形状(goal 展开成 loop 后节点 ID 命名冲突风险,如 develop/develop-eval 合成 ID)。
6. ~/.octopus/workflow-schema.json 的 goal 字段描述需要怎么改 + 它的同步机制(谁写入这个文件)。

## Answer

### Q1 — 全仓库 YAML 中带 `goal:` 的 agent 节点

**结论:现存 YAML 里没有任何 `type: agent` 节点使用 `goal:` 字段。** 多行 rg(`type: agent … goal:` 双向窗口)在 packages/、core-pack、~/.octopus 全语料零命中;goal mode 目前只有测试内联构造在用。

抽样明细(所有 `goal:` 命中都不是 agent 节点字段):

- `packages/core-pack/workflows/moa-requirements-review.yaml:30` / `spec-review-swarm.yaml:20` / `clarify-debate.yaml:18` — workflow 级 `variables.goal: ""`(占位),节点是 swarm `topic` 引用 `$vars.goal`(:39/:28/:26)
- `packages/core-pack/workflows/composition-task.yaml:43` — `variables.goal`;`:59` — task_dispatch `input_mapping.goal: "$vars.goal"`(子 schedule 输入)
- `packages/core-pack/workflows/superpowers-task-dev.yaml:42` — `inputs.goal` 声明,节点用 `$inputs.goal` 拼 prompt(:88),即 goal 走"prompt 文本"路径而非 goal 字段
- `*.test.yaml`(moa:11、composition:13、spec-review:8、clarify:8、superpowers:8/46)— fixture `inputs:` 值,非节点字段
- `packages/cli/dist/core-pack/workflows/*` — 上述文件的构建镜像,同样命中
- `~/.octopus/workflows/`(仅 doc/、test-task-workflow.yaml)、`~/.octopus/agent/workflows/dynamic-*.yaml`(约 10+ 个)、`~/.octopus/tasks/*/workflows/`(全部为空目录)— `goal:` 零命中

唯一运行时消费方(形状改变的真正震中):

- `/Users/xzf/Projects/ai/XzhiF/open-octopus/packages/engine/src/executors/agent.ts:320-321` — `buildPrompt()` 检测 `node.goal` 走 goal 分支
- `/Users/xzf/Projects/ai/XzhiF/open-octopus/packages/engine/src/executors/agent.ts:360-433` — `buildGoalPrompt()`:Goal/Constraints/Allowed Tools/Instructions/上下文注入(:436-467 `_buildGoalContext`、`_execution_history` :413)
- `/Users/xzf/Projects/ai/XzhiF/open-octopus/packages/engine/src/__tests__/agent-goal-mode.test.ts:51-157` — goal mode 行为锁测试(prompt 拼装、planning 注入、变量替换、历史注入)

**影响评估:YAML 语料零迁移成本;需要迁移的只有 agent.ts goal 分支 + agent-goal-mode.test.ts 一个测试文件。** 注意别把 `variables.goal`/`inputs.goal`/preset `${goal}` 占位(`packages/server/src/services/agent/workflow-presets-seed.ts:43,50,57`、`packages/server/src/services/scheduler/executors/workflow-executor.ts:691`)误当 goal mode——它们是任务 spec 层的字符串,与节点 goal 字段无关,不受 loop 化影响。

### Q2 — Simulator 对 goal 节点的 mock 与 loop fixture

- goal 节点在 simulator 中与 prompt 节点**无差别**:`packages/engine/src/simulator/mock-factory.ts:105-107` agent → `MockAgentExecutor`,mock 只按 `mocks[node.id]` 查表,输出取 `output/status/update_vars`(`packages/engine/src/simulator/mock-executors.ts:76-99`),从不读 `node.goal`。
- loop 由 SimulatorEngine 真迭代:`packages/engine/src/simulator/simulator-engine.ts:136-137`(分支入口)、`:236-335 executeLoopNode`。迭代上限 = `loopNode.max_iterations ?? 100`(:245),收敛只靠真求值 `while`/`break_when`(:254-283)。
- **fixture 的 `iterations` 字段无人消费**:`packages/engine/src/simulator/types.ts:43-45 LoopMockDef{iterations?, nodes}` 声明了 iterations,但 simulator 全目录 grep 零读取;现存 fixture 写 `iterations: 1`(`packages/core-pack/workflows/xzf-dev.test.yaml:49,143,241`、`matt-dev-pipeline.test.yaml:46,138`)纯装饰——收敛实际靠 break_when 对上 mock 输出。
- inner 节点 mock 查找三级兜底:`simulator-engine.ts:372`(loopMockDef.nodes[childId])→ `:374-378`(顶层 mocks[childId] 兜底)→ `:380-385`(auto-pass);per-iteration 数组 mock 按迭代索引、越界取末元素(:388-393)。
- loop 输出契约:`simulator-engine.ts:329 outputs: { iterations }` — **没有 last_output**;inner 结果记账 key 为复合 ID `${loopId}.${innerId}.iter${N}`(:301)。

**影响评估:goal→loop 形状后,该节点的 fixture 必须从 AgentMockDef 改成 LoopMockDef 形状 `{<goalNodeId>: {iterations: n, nodes: {<innerId>: mock|mock[]}}}`;若 break_when 引用的 eval mock 输出不收敛,会空转 max_iterations 次(默认 100);且下游 `$<goalNodeId>.output.*` 全部失效(只剩 `iterations` 输出),需要在 goal→loop 展开时合成一个"末次迭代输出透传"否则断链。**

### Q3 — web-app 编辑器/可视化对 goal/constraints/planning 的渲染

**结论:web-app 完全不渲染 agent 节点的 goal/constraints/planning —— 无属性面板,goal 变 loop 没有"字段渲染破坏"问题,但有两个 UI 跟随决策点。**

- 编辑器是纯 Monaco YAML + 只读 DAG 预览:`packages/web-app/components/workspace/workflow-editor-tab.tsx:1-60`,无节点属性表单。
- DAG 数据提取不读 goal:`packages/web-app/lib/workflow-parser.ts:518-529` 只提取 `command/script/prompt/risk_level/iterations/loop_body/cases`;agent 卡片只渲染 prompt 两行:`packages/web-app/components/workspace/workflow-nodes/agent-node.tsx:32-34`。grep `constraints|planning` 在 web-app 源码零命中(仅 tasks 域 `spec.constraints` 无关)。
- loop 已有完整渲染:`workflow-nodes/loop-node.tsx:31-44`(卡片)+ `loop-container-node.tsx:66-202`(容器:虚线框、IterationDots、`/{maxIter}`)+ `workflow-parser.ts:184-186,226-360`(子节点展开,dagre 内布局,inner key 用 `${loopId}:${innerId}` 冒号前缀 :244)。
- 执行视图 loop 事件已打通(见 Q5):`use-execution-tree.ts:316-352`、`loop-overview.tsx:43-231`、`execution-log-viewer.tsx:787-904`。
- 图标按 node type 分发:`packages/web-app/components/workspace/workflow-nodes/node-icon-config.ts:23-100`(`agent: Bot/purple`,`loop: Repeat/orange`),goal 节点无特殊样式。
- 注意:tasks 域大量 `goal` 命中(`components/tasks/authoring/goal-ac-card.tsx:52-57`、`spec-panel.tsx:289-293`、`task-modal.tsx:830`)是 task_spec.goal 需求目标,与工作流节点 goal 无关。

**影响评估:硬性跟随只有一处——若 goal 保留在 YAML(运行时才展开),编辑器 DAG 预览会把它当 agent 卡渲染且 prompt 为空 → 空白卡片,需要 parser 把 goal 文本当作 agent 卡显示内容(workflow-parser.ts:518-529 + agent-node.tsx);若"goal 节点有 loop 图标/loop-body 预览"成为需求,则是 parser 184-186 分支的类型判定扩展。属性面板不存在,无面板迁移成本。**

### Q4 — validate 对 goal 节点的硬校验

两处校验器需要**同步改**(shared 是权威、skill 脚本是镜像):

- `packages/shared/src/yaml/parser.ts:108-124` — `_validateGoalPromptExclusion`:goal/prompt 互斥(:110-111);constraints/planning 必须配 goal(:114-119);递归进 loop 内层节点(:121-124)
- `packages/shared/src/yaml/parser.ts:181-182` — agent 节点要求 `agent|prompt|goal|agents` 四选一
- `packages/shared/src/yaml/parser.ts:143-157` — `validateWorkflow._collectIds` **跨层**(顶层 + 所有 loop.nodes)查重节点 ID
- `packages/shared/src/yaml/parser.ts:200-208` — loop 节点要求 `max_iterations`
- zod:`packages/shared/src/types/workflow.ts:237-239`(NodeDef goal/constraints/planning)、`:360-362`(NodeSchema)、`:377`(max_iterations)、`:178-191`(PlanningSchema)
- skill 脚本:`.claude/skills/octo-workflow-dev/scripts/validate-workflow.js:148-149`(L1 四选一)、`:224-226`(L2 goal/prompt 互斥)、`:160-162`(L1 loop requires max_iterations);`packages/core-pack/skills/octo-workflow-dev/` 有同名镜像副本
- CLI 入口:`packages/cli/src/commands/workflow.ts:36-37`(run 前)、`:168-169`(`workflow validate` 子命令 :156)都调 `parseWorkflow + validateWorkflow`

**影响评估:若 goal 仍在 agent 节点上、loop 化只发生在执行期,则四处校验一行都不用改(goal/prompt 互斥语义不变);若是"作者期 goal 就写成 loop 形状"(goal 从 agent schema 移除/迁移),则 parser.ts:108-124 整段规则退役、:181 四选一收缩、loop 的 max_iterations 必填补上 goal 缺校验,且合成 inner ID 必须过 :143-157 全局查重——`<nodeId>-eval` 这类合成名与用户手写的同名节点冲突会在 validate 直接炸,这是好事(早报),但要保证展开发生在 validate 之后。**

### Q5 — SSE 事件流:loop 子节点事件形状与合成 ID 冲突

现有形状(三层,命名规则各不相同):

- **node_start / node_end**:payload `data.nodeId` = **裸 inner ID,无 loop 前缀、无迭代号** — `packages/engine/src/executors/loop.ts:144,158,194,216` 调 `callbacks.onNodeStart(innerNode.id)` → `packages/server/src/services/execution/EngineCallbacks.ts:326-342`(`node_start`)/`:358-441`(`node_end`);DB 行主键 `neId = ${executionId}-${nodeId}`(EngineCallbacks.ts:327,359)→ **同一 inner 节点跨迭代反复覆盖同一行**(每次 onNodeStart 会 `deleteAgentEventsByNode` + 重置 buffer :330-334,只保留最新迭代)
- **branch_start / branch_end**:合成 ID `${loopId}-iter-${N}` — loop.ts:108,343,356,408 → EngineCallbacks.ts:508,515;web-app 靠 `nodeExecutionId.split("-iter-")[0]` 反推 loopId(`packages/web-app/hooks/use-execution-tree.ts:319,337`)、stepId 正则 `/^(.+)-iter\d+$/`(`workflow-flow-viewer-with-status.tsx:114`)
- **JSONL 日志文件**:loop 上下文按迭代分片 `${loopId}-iter-${N}__${childId}.jsonl` + entry.iteration 字段(`packages/engine/src/logger.ts:84-90,112-114`;:33 注释明确处理过 `-iter-N` 文件名转义冲突)
- 另有 `runtime_node_added`(`EngineCallbacks.ts:660`)带 parentNodeId/iterationIndex,供动态子工作流(`loop.ts:601-607` 注入 iterationIndex);sub_workflow 用 `${parent}:${child}` 冒号复合 ID(`packages/engine/src/__tests__/nested-hierarchy-callbacks.test.ts:57-60`)

**影响评估:goal 展开成 loop 后,其 inner 节点(如合成的 `develop-eval`)以裸 ID 进 node_start/node_end——与既有顶层节点同 ID 的冲突已被 validateWorkflow 全局查重挡住(Q4),但三个真实风险是:(a) node_end 的 `nodeId` 命名空间新增一批"作者不可见"的合成 ID,按 nodeId 精确匹配的下游(web-app status 映射 :304-342、execution-log-viewer)会渲染出 YAML 里不存在的幽灵节点;(b) 现有两套复合命名(loop 用 `-iter-N`/`__`,sub_workflow 用 `:`)已经不一致,goal 若再造第三种(如 `develop/develop-eval`)命名空间碎片化加剧;(c) `${executionId}-${nodeId}` 主键下,两个不同 goal-loop 各自展开出的同名 eval inner 节点(如两个 goal 节点都合成 `eval`)将互相覆盖事件行。建议合成 ID 强制带父前缀(复用 `${loopId}:${innerId}` 或 `-iter` 约定)并接入 validateWorkflow 查重。**

### Q6 — ~/.octopus/workflow-schema.json 的 goal 描述与同步机制

goal 相关字段描述(现存文件 `/Users/xzf/.octopus/workflow-schema.json`):

- `:469-472` `goal`: *"High-level goal description. Mutually exclusive with 'prompt'. Engine builds a structured goal prompt…"* — loop 化后此描述需改:装配语义("builds a structured goal prompt")→ 执行语义(展开为 loop、收敛条件),并新增对 loop 字段(max_iterations/break_when,已在 schema loop 段)的交叉引用
- `:475-476` `constraints`("Requires 'goal' to be set")、`:479-500` `planning`(max_turns/verify/tools/disallowed_tools,"rendered in the goal prompt")同步措辞

**同步机制(关键发现:schema 源文件已从仓库删除,同步已断):**

- 写入方 1:`scripts/sync-builtin.mjs:63-69` — 从 `packages/core-pack/workflows/workflow-schema.json` 拷到 `~/.octopus/workflow-schema.json`,但用 `existsSync` 守卫,源缺失时**静默跳过**(:73 打印 `schema: ✗`)
- 写入方 2:`packages/cli/src/setup-runner/index.ts:1185-1188` — `octopus setup` 时从 core-pack 拷到 globalDir,同样 existsSync 守卫
- 源文件已死:`git show 2bc5951d --stat` 显示 `packages/core-pack/workflows/workflow-schema.json`(765 行)在 "refactor: simplify xzf-dev workflow and clean up unused assets" 中被删;当前仓库 `find` 无任何 workflow-schema.json 副本
- 悬空引用:`xzf-dev.yaml:1`、`matt-dev-pipeline.yaml:1`、`superpowers-task-dev.yaml:1` 头部 `$schema=./workflow-schema.json`;`packages/core-pack/skills/octo-workflow-dev/SKILL.md:12` 与 `.claude/skills/octo-workflow-dev/SKILL.md:12` 仍宣称 schema authority 指向已不存在的源;`packages/core-pack/skills/octo-workflow-dev/references/special-conventions.md:12` 同样引用
- 磁盘上的 `~/.octopus/workflow-schema.json`(mtime 2026-07-22)是**历史孤儿**,不会再被任何机制更新

**影响评估:不存在"改 schema 文件即可"的路径——要么先恢复 `packages/core-pack/workflows/workflow-schema.json`(git show 2bc5951d^ 可取回 765 行原文)让 sync-builtin/setup 重新生效并补 goal→loop 描述,要么明确废弃 JSON Schema 路线、清理 5 处悬空引用。若选恢复,注意孤儿文件与恢复源之间的版本差(磁盘版 32894 字节)需 force 覆盖。**

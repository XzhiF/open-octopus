# Story Walk-Through — goal-task-dev

> 对 spec.md 附录 3 条核心故事 + task-dev input_values 全链路(max_turns)做的代码级走查。
> 基线 = feat/task-workflow-presets 分支当前代码。所有断点均已定位到文件/行号。

---

## 全链路专项:max_turns(工作流参数)从看板到 SDK

**结论:除末端两处 spec 已列改动外,链路本身通畅;engine 的 inputs default 机制确实生效。**

| # | 步骤 | 触点 | 现状验证 |
|---|------|------|---------|
| 1 | 绑定对话框渲染 max_turns 输入框 | [UI] | ✅ `workflow-box.tsx:334-350` 遍历 `parsed.inputs` **全部**(含非 required)渲染 Input,不区分 required |
| 2 | 默认值 200 渲染 | [UI] | ❌ **断点 F**:value 只来自 `formInputs`(preset skeleton 预填,general-dev skeleton 按 spec 不含 max_turns),`def.default` 从不呈现 |
| 3 | 留空 → 不写入 | [UI] | ✅ `handleSave` 剔除空值(`workflow-box.tsx:203-209`)→ input_values 无 max_turns → 走 YAML default,设计自洽 |
| 4 | PUT /api/tasks/:id | [API] | ✅ `InputValues = Record<string,string>`(shared/types/workflow-presets.ts:20),字符串 "50" 合法 |
| 5 | ready-gate | [API] | ✅ `tasks-service.ts:957-968`:required 检查只对 `def.required===true`;max_turns 非 required 不拦;`parseWorkflowInputDefs`(template-resolver.ts:93) 读原始 YAML `inputs` 节 |
| 6 | materialize | [Data] | ✅ `materializeTaskSpecToConfig`(scheduler-service.ts:219-234):`resolveInputValues` 只替换 `${goal}/${ac}` 占位,max_turns 字面值原样保留 → `workflow_chain[0].input_values` |
| 7 | dispatch → execution | [Exec] | ✅ `workflow-executor.ts:329/394` 把 `firstStep.input_values` 传给 `service.start(execution.id, …)`;`ExecutionLifecycle.start:222-224` 写入 execution 行 |
| 8 | engine 构造 | [Exec] | ✅ `EngineFactory.createEngine:95-114`:input_values JSON → 引擎第 8 参 `initialInputs` |
| 9 | **engine default 机制**(parent 问题:input_values 缺 max_turns 时 default 是否生效?) | [Exec] | ✅ **生效**。`engine.ts:208-219`:遍历 `workflow.inputs`,仅当 key 不在 initialInputs 时 `pool.set(key, String(def.default))`;`engine.ts:226-238` 另建 `this.inputs`(mergedInputs,同样 default+caller 合并,供 evaluateExpression) |
| 10 | `$inputs.max_turns` 插值源 | [Exec] | ✅ 权威源 = **VarPool**:`substitute.ts:39-45` `$inputs.<k>` → `pool.get(k)`(inputs 与 vars 共享同一个 pool,engine 构造时已注入 default/initialInputs)。`substituteVarsFull` 同链路。**注意**:`ExecutionLifecycle.start` 的 `yamlInputDefaults` 合并(:247-261)只作用于**子执行**($parent 解析)路径,顶层执行靠引擎自身 default 逻辑——两条路都覆盖,无缺口 |
| 11 | executor resolve | [Exec] | ⚠️ spec 已列改动(resolveNodeNumber + runner opts + sdkOptions);见断点 C/E/H |

**附加发现(链路外但同源):**
- `WorkflowInputSchema`(workflow.ts:486-490):`description` 为**必填**、`default: z.string()`。→ **断点 D**(task-dev 草案缺 description 直接 parse 失败)+ YAML 里 `default: 200` 不带引号会 Zod 拒绝,必须 `"200"`。

---

## Story 1:看板默认无人值守(K6+K2+K3)

```
[draft] goal+ac 确认 → WorkflowBox 绑定 general-dev(→task-dev)
  │
  ├─[UI] 推荐列表 ← GET /api/workflow-presets
  │   ⚠ 断点B(CRITICAL):seed 常量改了,但存量安装永远看不到
  │     clone-init-service.ts:109 `if (!fs.existsSync(presetsPath))` — skip-if-exists。
  │     ~/.octopus/agent/built-in/task-author/workflow-presets.yaml 一旦落盘,
  │     升级永不刷新 → general-dev 继续指 matt-dev-pipeline(含 interaction 节点,
  │     执行期要人答题)= Problem Statement 主痛点原样保留。
  │     presets service 本身是每次 readFileSync 无缓存(✅ 改了文件立即生效),
  │     所以唯一缺口就是"没有任何机制去改这个文件"。
  │   ⚠ 断点K(MEDIUM):task-dev.yaml 需 `octopus resource install builtin:task-dev`
  │     (BuiltInWorkflowService 只读 ~/.octopus/resources/installed,无目录扫描)。
  │     未安装时:绑定对话框 detail 404 → 输入表单整个不渲染;ready-gate 把
  │     不可解析 ref 报成 missing "workflow_ref"(文案误导为"没绑定")。
  │     spec 已列 Prerequisite,但缺交付时的自动 install/提示 → 至少写进 Do。
  │
  ├─[UI] max_turns 输入框 ← 见上表 #1/#2(断点F: default 不显示)
  │
  ├─[API] PUT → ready-gate → confirm 入队          ✅ 见上表 #4/#5
  ├─[Data] scheduler config input_values{goal,ac(+max_turns?)} ✅ #6-#9
  │
  ├─[Exec] develop 节点 = /goal 装配 + maxTurns 直通
  │   ⚠ 断点C(HIGH):NodeDef/NodeSchema **没有节点级 `tools` 字段**
  │     (workflow.ts:210-334 只有 planning.tools / expert_defaults.tools /
  │     SubAgentDef.tools),且 NodeSchema 非 strict → YAML `tools:` 被 Zod 静默剥离。
  │     spec shared 节只列了 max_turns/max_budget_usd/disallowed_tools 三个新增,
  │     而 engine 节写 `tools: node.tools` → 按 spec 落地 TS 编译失败或字段丢失,
  │     US4 的 tools 半边落空。必须把 `tools: z.array(z.string()).optional()`
  │     补进 NodeDef+NodeSchema(以及 K4 "tools 统一 node.tools" 的表述)。
  │   ⚠ 断点E(HIGH):error_max_turns 证据链在 provider 就残缺:
  │     claude/provider.ts:524-530 — 非 success result 被压成
  │     `{type:'error', code: rm.subtype, message: rm.errors?.join('; ') ?? 'unknown error'}`,
  │     SDKResultError 的 num_turns / session_id / total_cost_usd / terminal_reason
  │     全部丢弃。runner(:174-176)见 error 即 throw → executor catch → failed。
  │     AC3"failed 且 error 携 iterations 证据"没有数据来源:
  │     max_turns 场景 errors[] 很可能为空 → 'unknown error'。
  │     需要:provider error chunk 增加 numTurns/sessionId/costUsd/terminalReason
  │     (或改 yield 专用 result_error chunk),runner 终态分支透传,executor 组装
  │     goal_evidence。sessionId 丢失还顺带毁掉 resume 重试的语境。
  │   ⚠ 断点I(与 Story 3 共):agent-runner.run() opts 现无 maxTurns/tools/
  │     maxBudgetUsd 通道;provider sdkOptions(:264-291)无 maxTurns/maxBudgetUsd
  │     映射 —— spec 已列,✅ 认知正确。disallowedTools 已有合并通道
  │     (agent-runner.ts:131 硬保 AskUserQuestion/complete_interaction + opts),
  │     executor 只需把 node.disallowed_tools 传进 opts。
  │
  ├─[Exec] ship 节点(prompt)读 $vars.task_artifacts_dir
  │   ✅ materialize 注入 simpleInputValues.task_artifacts_dir(scheduler-service.ts:238-241)
  │   → 引擎 pool → $vars 可解析。failed 上游节点的 outputs 仍在 nodeResults
  │   (engine.ts:357 无条件存),ship 读 develop last_output 可行。
  │   ⚠ LOW:独立 CLI 跑 task-dev(不经看板)时该 key 不存在,
  │   substituteVars miss 返回字面 "$vars.task_artifacts_dir" 进 prompt。
  │   建议 task-dev 声明可选 input task_artifacts_dir 或文档注明看板专用。
  │
  ├─[Event] 每轮 active_goal 进 JSONL/SSE
  │   ⚠ 断点A(CRITICAL):链在 provider 层就是断的,详见 Story 2。
  │
  └─[验收] 人对照 ac 看 PR + 报告                     ✅ 无新增触点
```

## Story 2:作者自定 goal 节点保险丝

```
[UI] YAML 写 max_turns: 10 / $inputs.my_cap
  ✅ 前提:字段进 NodeSchema(C 修掉后)。`$inputs.my_cap` 字符串经
  resolveNodeNumber→substituteVarsFull→pool → 可行。
  ⚠ LOW:"无效→undefined=不限制" 会静默失去保险丝(用户手滑 "abc" → 无上限
  + 默认 600s activity-timeout 兜底)。建议 resolve 失败时 log 一行 warn 进
  node logLines,而非纯静默。
  │
[Exec] sdkOptions.maxTurns=10 → error_max_turns
  ⚠ provider 现把 error_max_turns 压扁成 error chunk(断点E)。spec 的
  "runner 特判 subtype 白名单"落点没错(agent-runner.ts:174-176),但它只能
  看到 code='error_max_turns',看不到 num_turns —— 白名单判断可行,证据不行。
  另注意:spec 描述"result 消息 subtype"不准确 —— runner 收不到 result chunk,
  result/error 的区分在 provider 已完成。文案应改为"error chunk 的 code"。
  │
[Event] 看板/执行日志响 + goal_not_met(max_turns)
  ✅ 终态映射后:executor 返回 status:failed+error → engine
  nodeResults/engine.ts:2169-2171 → DB/SSE 均通(无字段枚举问题)。
  ✅ harness detector-pipeline onAgentEvent 泛化透传(:1003-1007);
  server EngineCallbacks.onAgentEvent SSE 透传(:518-520);
  executor-factory:199 每条事件 log 进 JSONL —— 这三层确认无白名单。
  ❌ 但 active_goal 本身到不了这三层 —— 断点A。
```

### 断点A 详解(CRITICAL):active_goal 透传链不存在,且 spec 前提为假

- SDK 侧成立:`@anthropic-ai/claude-agent-sdk@0.3.235` sdk.d.ts 有
  `SDKActiveGoalMessage { type:'active_goal', value:{condition,iterations,set_at,tokens_at_start,last_reason?} }`,
  且它是 **StdoutMessage 顶层成员**(sdk.d.ts:7764),**不是 system subtype**。
- provider 层丢弃:`claude/provider.ts:306-572` 的 if-chain 只处理
  stream_event/assistant/user/tool_progress/tool_use_summary/system/result →
  `event.type==='active_goal'` 无人认领,**静默消失**。system 分支(:487-496)本身
  也是 subtype 白名单(status/compact_boundary/local_command_output)。
- MessageChunk 联合类型(types.ts:89-109)无 active_goal 变体。
- runner 层也是白名单:`agent-runner.ts:141-177` switch 无 default,未知 chunk
  类型静默丢(现 provider 发的 message_start/message_delta 就是这么被丢的)。
- 结论:spec"确认无白名单丢弃即可"**为假**。需要三处新增:
  1. providers/types.ts:MessageChunk 加 `{ type:'active_goal'; condition; iterations; lastReason?; setAt? }`;
  2. provider.ts:顶层 `else if (event.type === 'active_goal')` yield;
  3. agent-runner.ts:case 'active_goal' → emit 新 AgentEvent 变体(agent-types.ts)。
  engine→JSONL/SSE 段无需动。AC2/AC3 的"日志含 active_goal"在此修复前必挂。

## Story 3:老 planning 文件迁移

```
[UI] 作者保留 planning:{max_turns:5,verify:true} → parse 报迁移错
  ⚠ 断点G(MEDIUM):删除 PlanningSchema 后,Zod 默认 strip 未知键 ——
  `planning:` 会被**静默吞掉**,不报错。spec 说"检测到 planning 键抛 ValueError",
  必须明确:在 parseWorkflow 里对**pre-Zod raw 对象**递归扫 nodes(含 loop 嵌套,
  仿 normalizeTokenAmounts 的 walker),否则迁移指引形同虚设。
  ⚠ 同一文件的另一面:server 加载路径吞错 ——
  builtin-workflow.ts:33-35 与 :70-73 `catch { skip }`:含 planning 的老文件
  不会给用户看到迁移错误,而是从"已安装工作流列表"里**消失**(silent failure)。
  CLI validate/run 路径 ✅ 能收到 ValueError。US6"明确迁移错误信息"仅半达成。
  │
[Exec] engine: octopus_agent + max_turns → validate 警告,运行忽略
  ⚠ 断点H(MEDIUM):`validateWorkflow(wf): void`(parser.ts:142)无 warnings 通道。
  spec 的 "warnings 数组,不 reject" 是签名变更 → 波及 CLI workflow validate、
  server 各 workflow 路由、web 编辑器校验的展示接线,spec 未列。
  ⚠ 判定源:运行时 engine 键 = `node.engine ?? workflow.engine ?? "claude"`
  (executor-factory.ts:186/325),spec 只写 "workflow.engine ≠ claude" ——
  节点级 engine 覆盖时漏报/误报。规则应取同一优先级链。
  ✅ 运行忽略:pi provider 只选择性读 options,多余键天然忽略;单 runner 类
  共享,executor 传新 opts 字段对非 claude provider 无感。
  ✅ 全仓库现状复核:core-pack YAML grep `planning` = 0,US6 影响面断言属实。
  ✅ 字段枚举复核:task-dispatch executor、composite/buildCompositeInputValues、
  harness detector 均不按 NodeDef 字段枚举 → planning 删除/新字段增加不炸它们。
  web-app src 无 planning 引用(.next 缓存产物除外)。
```

---

## 其余发现

| ID | 严重度 | 内容 |
|----|--------|------|
| J | MEDIUM | **R1 降级方案无跨包接口**:`supportedCommands()` 只存在于 SDK Query 对象(provider 流内, sdk.d.ts:2506);而 buildGoalPrompt 降级决策在 engine executor。spec 的"运行时探测、无 goal 时降级"没有任何 provider→engine 能力上报通道(SendQueryOptions/IAgentProvider 均无)。要么定义(如 provider 首 chunk 报 capabilities / `IAgentProvider.supportsSlashCommand?()`),要么明确 R1 为"另案",否则是写在 Risks 里的空中缓解。 |
| K | MEDIUM | **superpowers cr_status 联动面大于 R5 所述**:除 ship prompt(:155)外,还有 ① `variables.cr_status: ""` 默认声明(:52);② `superpowers-task-dev.test.yaml` 的 cr-fix mock(vars_update cr_status :22/:60)与 vars 断言(:32/:70)。只"grep ship"会留悬空引用 + sim 断言必挂(AC7)。 |
| L | MEDIUM | **AC8 grep=0 的范围自相矛盾**:`yaml-language-server` 现存于 ① 6 个 core-pack YAML 头(✅ spec 已列);② `.claude/skills/octo-workflow-test/SKILL.md` 及其 core-pack 镜像(spec 文档清理只列了 octo-workflow-dev);③ `octo-workflow-dev/references/testing.md`、`special-conventions.md`(部分已列);④ `.scratch/**` 历史 E2E fixture 十余个 + spec.md/decision 09 自身文本 —— 这些必然保留,AC8 必须写明 grep 排除 `.scratch/` 与本文档,否则永不可达。另:repo 里 `workflow-schema.json` **已不存在**(core-pack/workflows 无此文件),sync/setup 两处分支已被 existsSync 短路成 no-op;删除时注意 sync-builtin.mjs:70 的 console.log 还引用 `schemaSrc`。 |
| M | MEDIUM | **AC7 "耗尽=mock 节点 terminalReason" 机制不存在**:simulator 用 MockAgentExecutor **整体替换** executor(mock-factory.ts:103-126),`AgentRunResult.terminalReason` 在 runner 层,fixture 永远触不到。max_turns 耗尽场景只能 mock `status: failed + error: 'goal_not_met (max_turns)'`(验证编排,不验证映射);映射由单元 + AC3 真跑覆盖。spec 措辞需改,否则实现者会试图给 MockDef 加字段。 |
| N | LOW | 绑定对话框 `handleSelectWorkflow`(手动从"全部内置"选)不清空 `formInputs` —— 从 preset A 换到工作流 B 会带着 A 的输入值保存。 |
| O | LOW | `resolveNodeNumber` 无效值→undefined 与"不写该字段"不可区分(断点 Story2 注)。可接受,建议至少 warn。 |

## 已验证无问题的关键点(spec 断言 vs 代码,给决策表背书)

- engine inputs default **确实**在 input_values 缺 key 时生效(engine.ts:208-219),`$inputs.*` 与 `$vars.*` 共享 VarPool(substitute.ts:39-45),`this.inputs` 仅供 execute_when 表达式 —— K6 "max_turns 工作流参数默认 200" 的引擎侧地基成立。
- ready-gate/materialize/dispatch/SSE/JSONL/DB 同步全链对 `input_values` 与 `events` 都是**泛化透传**,无字段/事件类型白名单(server 侧三层逐一确认)。
- `SendQueryOptions.maxBudgetUsd` 存在但 provider 未映射(= 真死字段,spec "救活"表述准确);`tools/disallowedTools` provider 已直通(:285-286),runner 已合并 disallowedTools;缺口只在 run() opts 与 executor 传参 —— 与 spec 一致。
- `SDKActiveGoalMessage`、`error_max_turns`/`error_max_budget_usd` subtype、`Options.maxTurns/maxBudgetUsd` 在 SDK 0.3.235 类型里全部存在 —— K1/K3/K5 的外部前提成立。
- planning 全仓库 YAML 零使用、`PlanningDef/PlanningSchema` 除 shared 自身+agent.ts 外无消费者 —— K4 的"零 YAML 遗留"属实。
- task-dispatch/复合任务/harness 不枚举 agent 节点字段 —— Don't 列表"不动物化链路"可兑现。

## 修复建议汇总(按优先级)

1. **(A) active_goal**:providers/types.ts MessageChunk 新变体 + claude provider 顶层 `active_goal` 分支 + runner case + agent-types.ts AgentEvent 变体;spec providers 节补三行实现决策。
2. **(B) preset 刷新**:为 workflow-presets.yaml 增加"种子版本"机制(如 seed 常量旁 `PRESETS_SEED_VERSION`,文件头注释 `# seed-version: N`,init 时版本不同且内容===旧默认 → 覆盖;用户手改过 → 保留并 warn),或最低成本:把"替换 live catalog"做成 octopus setup / server 启动迁移步骤之一,并写进 Do。
3. **(C) tools 字段**:NodeDef+NodeSchema 补 `tools?: string[]`;validate 警告规则与 executor 传参同步引用。
4. **(D) task-dev inputs 写法**:每个 input 必须 `description: "…"`;`default: "200"` 必须带引号(z.string)。把最小合规示例直接写进 spec core-pack 节。
5. **(E) 终态证据**:provider 非 success result 改为携带 `numTurns/sessionId/costUsd/terminalReason`(扩展 error chunk 或新 chunk 型);runner 白名单命中时返回 `terminalReason` + 最后 assistant 文本 + sessionId;executor 组装 `goal_not_met (<subtype>, iterations=N)` error + `goal_evidence` outputs。
6. **(F) US5**:绑定表单初始化值 `formInputs[name] ?? existing ?? def.default ?? ""`(或至少 placeholder 显示默认值);注意与"留空走默认"的清理逻辑并存(预填默认值后保存会把 "200" 写进 input_values——可接受,语义一致)。
7. **(G/H) shared**:`planning` 用 pre-Zod 递归扫描报迁移错;`validateWorkflow` 定签名 `→ { warnings: string[] }` 并接 CLI/路由展示;engine 键判定用 `node.engine ?? workflow.engine ?? 'claude'`;明确 BuiltInWorkflowService 对 parse 失败文件"列出但标红"或至少保持现状+文档说明。
8. **(J–O)**:R1 探测接口要么定义要么移出本需求;cr_status 三处联动、AC8 排除范围、AC7 mock 措辞、sync-builtin log 清理、表单换选重置——均可在实现票内解决,但应写进 spec 对应小节,防止"grep ship 就行"的低估。

# Spec: goal-task-dev — goal 模式语义升级(/goal 原生适配器)+ task-dev 默认工作流

## Problem Statement

任务看板的设计是「draft 澄清 → 入队 → **无人值守执行** → 人验收」,但当前默认推荐的工作流(matt-dev-pipeline)含 interaction 节点,执行期要人守著答题;而引擎里为自治执行设计的 goal 模式是假的——它只是把 goal 文字拼进 prompt(`buildGoalPrompt`),`planning.max_turns/tools/disallowed_tools/verify` 全部无消费(死配置),自动注入的上下文被 100/200 字符腰斩截断(撒谎接口),没有任何收敛保证与不收敛保险丝。实践者需要的是 Claude Code `/goal` 那种语义:独立 evaluator 判达成、`error_max_turns` 硬保险丝、每轮证据可观测。

## Solution

goal 节点 = **SDK 原生 `/goal` + 薄适配器**:引擎把 goal 文本装配成 `/goal <condition>` 首 turn(headless/新会话/resume 会话均实测可用),收敛与 impossible 判定交给 Claude Code 内建 evaluator;节点级 `max_turns/max_budget_usd/disallowed_tools` 直通 SDK 硬终态;`active_goal` 事件透传进 SSE/JSONL 作为验收证据;上下文注入取消一切截断。新建两节点 skills-free 的 **task-dev** 工作流(goal 模式 develop + prompt 模式 ship)替换 general-dev fallback,跑通看板无人值守闭环。

## Projects Involved

- [x] packages/engine(goal 装配 / 字段解析 / 终态映射 / 事件透传)
- [x] packages/providers(SendQueryOptions + claude provider 直通)
- [x] packages/shared(NodeDef zod + validate 规则 + planning 移除)
- [x] packages/core-pack(task-dev.yaml 新建、superpowers-task-dev cr-fix goal 化、YAML schema 头清理)
- [x] packages/server(preset seed 换绑)
- [x] .claude/skills/octo-workflow-dev(文档:goal 新语义、planning 废弃、schema 路线变更)

## Feature Scope

**Do:**
- goal 节点执行改造:`/goal <condition>` 前置装配(condition = goal 字段全文插值后)
- 节点级新字段:`max_turns`、`max_budget_usd`、`disallowed_tools`(均 `number|string` / `string[]`);救活既有 `tools:` 死字段(→ SDK `tools` 可用工具基础集)
- `planning` 块整体废弃(parser 拒绝 + 清晰错误信息);`constraints` 保留
- agent-runner 特判 `error_max_turns` / `error_max_budget_usd` 终态 → 节点 failed + error 携证据,不再当异常 throw
- `active_goal` 事件(provider→runner→engine→SSE/JSONL)全链透传
- goal 模式上下文注入:移除 20-key/100字/200字全部截断,全量注入
- 非 claude engine 节点写了 budget/tools 字段:validate 警告,运行时静默忽略
- `task-dev` 工作流(develop goal + ship prompt,max_turns 工作流参数默认 200)+ general-dev fallback 换绑(seed 常量 + live catalog)
- superpowers-task-dev 的 cr-fix 节点改写为 goal 模式
- JSON schema 路线废弃:删 YAML 头引用、删 `~/.octopus/workflow-schema.json` 孤儿、移除 sync 脚本 schema 分支、octo-workflow-dev 文档补 goal 模式章节

**Don't:**
- 不发明引擎自己的 goal loop(不用引擎 loop 糖,不自建 evaluator agent)
- 不动 `context:` 机制(resume 会话内 /goal 实测可用)
- 不做看板/执行 UI 的 goal 状态专门呈现(证据链落盘即可,UI 另案)
- 不动 matt-dev-pipeline / xzf-dev 本体(退居手动绑定列表)
- 不动 task_dispatch/复合任务物化链路

## Key Decisions

| # | Decision | Conclusion | Reason |
|---|---------|-----------|--------|
| K1 | 执行架构 | 原生 `/goal` + 薄适配器 | loop 糖/自造执行器全部代价(SSE 幽灵 ID/simulator/编辑器/evaluator token)由原生路径规避;03/08 研究 + 3 组实测 |
| K2 | condition 来源 | goal 字段全文身兼二职;ac 经插值进文本 | 零新字段;判伪是作者责任;引擎零 ac 概念 |
| K3 | 不收敛终态 | evaluator impossible 判定为常规出口;`error_max_turns`→节点 **failed** 携 iterations/last_reason | 无人值守里未收敛必须响,不伪装 completed |
| K4 | planning | 整块废弃:max_turns/max_budget_usd 提为节点级通用字段;verify 删;tools 统一 node.tools | maxTurns 是 SDK 通用 option 不该挂 goal 专属;零 YAML 遗留(08 锤实) |
| K5 | turn 语义 | 1 turn = 1 assistant API 往返(并行 tool_use 计 1;tool_result 回传开新 turn;goal 续跑计 turn) | 实测 `--max-turns 3` 掐断 5 工具轮任务(error_max_turns, num_turns=4) |
| K6 | task-dev | 两节点:develop(goal)+ ship(prompt);max_turns=工作流参数默认 200 | 自查修正折进 condition+外置 evaluator,无需独立 cr 节点;cr+fix goal 化归 superpowers-task-dev |
| K7 | 截断 | 全部取消,全量注入 | 腰斩截断是撒谎接口;快照值正常场景不长(用户拍板) |
| K8 | 引擎兼容 | 非 claude engine:validate 警告 + 运行时静默忽略 | 如实报告能力差异,不炸老文件 |
| K9 | schema 路线 | JSON schema 废弃,权威 = shared Zod + skill references | 用户拍板("要来没用");双源断链是病根 |

## User Stories

1. 作为看板用户,我在 draft 确认 goal+ac 后入队,task-dev 无人值守跑完并给我 PR 与验收报告,不需要执行期守屏幕。
2. 作为工作流作者,我在 agent 节点写 `goal:` 即获得真收敛语义:worker 迭代到 evaluator 判 met/impossible,`max_turns` 兜底,行为与 Claude Code /goal 一致。
3. 作为运维/诊断者,我在执行日志(JSONL/SSE)里能看到 `active_goal`(含 condition/iterations/last_reason)证据;未收敛的节点是响的(failed)且携带证据。
4. 作为工作流作者,我给任何 agent 节点(不限 goal 模式)写 `max_turns`/`max_budget_usd`/`tools`/`disallowed_tools`,claude 引擎真实执行;其他引擎得到 validate 警告且运行不炸。
5. 作为看板用户,我在绑定对话框里能调整 task-dev 的 `max_turns` 参数(默认 200 渲染在输入表单)。
6. 作为老文件作者,我的 YAML 若含 `planning:` 会收到明确迁移错误信息;无 planning 的文件(全仓库现状)零影响。
7. 作为技能组=sperpowers-zh 的用户,superpowers-task-dev 的 cr-fix 现在是 goal 节点,对照 ac 审查修正直到 evaluator 判达成。

## Implementation Decisions

### shared(`packages/shared`)

- `types/workflow.ts` NodeDef/NodeSchema:
  - 新增 `max_turns?: number | string`、`max_budget_usd?: number | string`、`disallowed_tools?: string[]`(`z.union([z.number(), z.string()])`;budget 同)
  - **删除** `planning` 字段与 `PlanningSchema`;NodeSchema 改 `.strict()` 语义路径:检测到 `planning` 键时抛出带迁移指引的 ValueError("planning 已废弃:max_turns/max_budget_usd/disallowed_tools 提升为节点字段,verify 删除")
  - **(walkthrough C)** 补 `tools?: z.array(z.string())`——现状 NodeSchema 根本没有 tools 字段(非 strict 静默剥离,xzf-dev ship 的 tools: 从未到过引擎),救活 node.tools 的前提是 schema 声明它
  - **(walkthrough G)** planning 迁移错误:Zod 非 strict 会静默吞 `planning:`——parseWorkflow 前对 raw 对象**递归预扫**(含 loop 子节点),发现 planning 键即抛 ValueError("planning 已废弃: max_turns/max_budget_usd/disallowed_tools 提升为节点字段, verify 删除")(与 goal/prompt 互斥同级 pre-check)
  - 保留 goal/prompt 互斥、constraints-requires-goal 规则(parser.ts:108-124 现状);删 planning-requires-goal 规则
  - **(walkthrough H)** validateWorkflow 签名改 `→ { warnings: string[] }`(CLI 打印;web 不消费);警告判定链取 `node.engine ?? workflow.engine ?? "claude"`(executor-factory.ts:186 同链),≠"claude" 且节点含 max_turns/max_budget_usd/tools/disallowed_tools → warning 不 reject
- `types.ts` SendQueryOptions 在 providers,shared 的 `InputValues` 等不动

### providers(`packages/providers`)

- `types.ts` SendQueryOptions:新增 `maxTurns?: number`(`maxBudgetUsd` 已存在)
- `claude/provider.ts` sdkOptions 映射(:285 附近):`maxTurns: options?.maxTurns`、`maxBudgetUsd: options?.maxBudgetUsd`(救活)、tools/disallowedTools 已直通不动
- `toClaudeAgentDef`(provider.ts:175-183):补 `maxTurns`(现在被静默丢弃)、`background`;SDK AgentDefinition 支持的字段按 .d.ts 为准
- **(walkthrough A)active_goal 透传链**:`SDKActiveGoalMessage` 是 StdoutMessage 顶层 type,provider 的 if-chain(claude/provider.ts:306-572)不认即丢——MessageChunk 联合类型新增 `active_goal` 变体(携 condition/iterations/last_reason/set_at),provider 顶层分支识别转 chunk,runner 映射为 AgentEvent 进现有 events 管道(engine→SSE/JSONL 段已泛化,无需改)
- **(walkthrough E)error 终态保真**:provider :524-530 非 success result 现压成 {code,message}(num_turns/cost/session_id 丢失、errors[] 常空)→ error chunk 扩展 `numTurns?/costUsd?/sessionId?/terminalReason?`(subtype error_max_turns|error_max_budget_usd 时必带 terminalReason);runner 据此产终态元数据
- pi provider:不消费(现状即忽略,零改动)

### engine(`packages/engine`)

- `executors/agent.ts`:
  - 新增字段解析:`resolveNodeNumber(raw: number|string|undefined): number|undefined` —— string 走 `substituteVarsFull` 后 `Number()`,NaN/空→undefined(=不限制,与 CC headless 缺省一致)
  - run 调用(L107-120)追加:`maxTurns: resolveNodeNumber(node.max_turns)`、`maxBudgetUsd: resolveNodeNumber(node.max_budget_usd)`、`tools: node.tools`、`disallowedTools: node.disallowed_tools`
  - `buildGoalPrompt`(L360-433)重构:
    - 首行 `/goal <插值后 goal 全文>`(condition)
    - 移除 `## Allowed/Disallowed Tools` 段(SDK 硬执行,不再 prompt 装扮)
    - `## Previous Node Results` / `## Available Variables`:**删除 20-key/100字/200字全部截断逻辑**,全量
    - Instructions 保留精简自治指引 + (goal 场景)软退出提示
  - 终态处理:runner 返回 `goalTerminal` 元数据时,executor 产出 `{status:'failed', error: "goal_not_met (<reason 终态>)", outputs:{last_output, goal_evidence}}`
- `executors/agent-runner.ts`:
  - 终态白名单:`error_max_turns` / `error_max_budget_usd`(来自扩展后的 error chunk,E)**不再 throw**(现状 :174-176 见 is_error 即 throw);返回 `AgentRunResult` 附 `terminalReason?: 'max_turns'|'max_budget_usd'` + `terminalMeta`(numTurns/costUsd),finalText 用最后一条 assistant 文本
  - **(A)** switch 新增 `active_goal` chunk case → 映射为 AgentEvent `{type:'active_goal', ...}` 进 events(runner switch 现无 default 分支,未知类型丢弃——显式加 case,其余类型行为不变)
  - **(O)** resolveNodeNumber 无效值(string 替换后非数值)→ 视为未设置 + log warn 一次(区分于未写)
- 非 claude runner 实现(octopus_agent 等):忽略新 opts 字段,不报错

### core-pack(`packages/core-pack/workflows`)

- 新建 `task-dev.yaml`:两节点(K6 草案)。**(D) inputs 必须 WorkflowInputSchema 合规**:`goal: {description: "...", required: true}`、`ac: {description: "...", required: true}`、`max_turns: {description: "模型往返步数上限", required: false, default: "200"}`(**description 必填;default 是字符串**,engine.ts:208-219 String(default) 同池);develop `max_turns: $inputs.max_turns`,goal 文本含:产物目录自查指引 + `$inputs.ac` 逐条判据 + 软退出条款;ship=prompt 模式三阶段(ship-report.md 落 `$vars.task_artifacts_dir`、conventional commit 精确 add、gh pr create/edit、无 remote 降级 local)
- 新建 `task-dev.test.yaml`(simulator fixture:happy / max_turns 耗尽两场景;耗尽=mock 节点 terminalReason)
- `superpowers-task-dev.yaml`:cr-fix 节点改 `goal:`(对照 `$inputs.ac` + `$vars.plan_file` 审查修正直到无可修复问题;max_turns: 50);删 prompt 中 vars_update cr_status 协议(goal 化后 cr_status 由 ship 依据上游输出汇总,或保留 outputs?——cr_status 变量移除,ship 直接读 cr-fix 的 last_output)
- 删除全仓库 `# yaml-language-server: $schema=...` 头注释(grep 清)
- 各 workflow 加 `max_turns`?——**不加**,本需求不改既有工作流字段

### web-app(`packages/web-app`)

- **(F)** `workflow-box.tsx` 输入表单初始化显示工作流 inputs 默认值:`value={formInputs[name] ?? def.default ?? ""}`,保存时空值仍剔除(走 YAML default)
- **(N)** `handleSelectWorkflow` 换选时重置 `formInputs`(串值 bug,与 preset 换选手动列表同修)

### server(`packages/server`)

- `workflow-presets-seed.ts`:general-dev 条目 `workflow: built-in/task-dev`(inputs 保持 `{goal:"${goal}", ac:"${ac}"}`;max_turns 走 YAML default 不占位);新增 `PRESETS_VERSION` 常量 + 上一版默认内容常量
- **(walkthrough B)种子版本迁移**:`CloneInitService` skip-if-exists 导致存量安装永不刷新(老环境 general-dev 仍指 matt-dev-pipeline,US1 落空)。改为:文件存在时比较内容哈希——**≡ 旧内嵌默认(未被用户改过)** → 刷成新默认 + log;用户改过 → 保留并 warn 一次。新增单测:旧默认被刷、手改文件不被刷
- `scripts/sync-builtin.mjs` + `cli/setup-runner`(:1185):移除 workflow-schema.json 同步分支(随 K9);删 `~/.octopus/workflow-schema.json`

### skills(`.claude/skills/octo-workflow-dev`)

- SKILL.md 头部"Schema authority"改指 shared Zod parser + references
- `references/node-schema.md`:agent 节点表新增 goal(=/goal 语义)/max_turns/max_budget_usd/disallowed_tools;删 planning 块
- `references/variables.md`、`special-conventions.md`:goal 模式正确写法(可判伪句式、ac 插值进 condition、软退出条款、max_turns 默认);悬空 schema 引用清理
- `scripts/validate-workflow.js`:与 parser 规则同步(planning 报错、新字段合法、engine 警告)
- core-pack 内对应 skill 镜像副本同步(如有)

## Data Model Changes

无(数据库零改动;input_values/workflow_ref 链路复用 task-workflow-presets)。

## API Contracts

无新端点。变化均为数据面:
| Method | Path | 变化 |
|---|---|---|
| GET | /api/workflow-presets | general-dev.workflow = built-in/task-dev |
| GET | /api/workflows/built-in/:ref | 需 `octopus resource install builtin:task-dev`(交付步骤) |
| PUT | /api/tasks/:id | input_values 可含 max_turns(非 required,表单渲染) |

## Verification Strategy

### Verification Environment
| Item | Value |
|---|---|
| Environment | 本地 dev:`pnpm build` 后 server :3001;claude CLI ≥2.1.250 |
| Database | `~/.octopus/db/octopus.db`(dev 主库) |
| 真跑依赖 | claude CLI headless(实测已过三组探针) |

### Test Users & Data
| Item | Value |
|---|---|
| 数据前缀 | E2E_TEST_GTD_ |
| 最小真跑任务 | workspace=/tmp/goal-e2e-*,goal="创建 hello.txt 内容 X",ac 机械可判 |
| Cleanup | DELETE 任务行 + rm -rf 临时 workspace |

### AC to Verification Method Mapping
| US# | 验收条件 | Level | Method |
|-----|---------|-------|--------|
| AC1 | goal 节点装配 `/goal` 首行 + 全量注入(无 100/200 截断) | 单元 | executor prompt 装配断言(含 >200 字上游输出原样出现) |
| AC2 | claude 真跑收敛:最小 goal → 节点 completed + 目标文件存在 + JSONL 含 active_goal | **真实集成** | engine 直跑最小 YAML(不经看板),文件断言 + 日志 grep |
| AC3 | 不收敛响:`max_turns:3` + 永不满足 goal → failed,error 含 goal_not_met + iterations 证据 | **真实集成** | 镜像探针("说出7每轮说1");单元:runner 终态映射不 throw |
| AC4 | 节点字段直通:max_turns/max_budget_usd/tools/disallowed_tools → sdkOptions | 单元 | provider options mapping 断言;`$inputs.max_turns` string 解析数值化;无效→undefined |
| AC5 | planning 废弃:含 planning 的 YAML parse 报迁移错误;engine≠claude + budget 字段 → validate 警告 | 单元 | parser/validateWorkflow 用例 |
| AC6 | task-dev 默认推荐:GET presets 无过滤返回 general-dev=task-dev;绑定+入队物化 input_values(goal/ac 解析,max_turns 缺省) | API E2E | curl+DB 交叉(R3),PUT max_turns 覆盖生效 |
| AC7 | simulator:task-dev.test.yaml 两场景 pass——**耗尽场景 mock 节点 `status:failed + error:goal_not_met(max_turns)`**(walkthrough M:MockAgentExecutor 整体替换 executor,fixture 触不到 terminalReason;终态映射由 AC3 真跑+单元覆盖);superpowers cr-fix goal 化后 validate+sim 通过 | 单元/fixture | `octopus workflow simulate` |
| AC9 | preset 版本迁移:内容≡旧默认→刷新为 task-dev;用户手改→保留+warn | 单元 | CloneInitService 两用例 + 真机 live catalog 刷新验证 |
| AC8 | schema 清理(**范围限定,walkthrough K**):`grep -r yaml-language-server packages/core-pack/workflows/ .claude/skills/octo-workflow-dev .claude/skills/octo-workflow-test packages/core-pack/skills/octo-workflow-*` = 0(含 skill 镜像;`.scratch/**` 历史 fixture 与本 feature 文档除外);`~/.octopus/workflow-schema.json` 删除;sync-builtin.mjs schema 分支与 :70 残留 log 移除,跑 sync 不报错;repo 内文件本已不存在,无恢复 | 静态+脚本 | grep 断言 + 跑 sync |

### Anti-Fake-Run Standards (R1-R8)
R1 真 claude CLI(非 mock)跑 AC2/AC3;R2 断文件内容/subtype;R3 API↔DB↔JSONL↔文件系统交叉;R5 副作用断言;R7 前缀隔离;R8 脚本可重放。goal 真跑单任务成本 ~$0.1-0.3,可控。

### Prerequisites
- [ ] feat/task-workflow-presets 已合入或其代码为 base
- [ ] server 重建 + 重启(seed 常量与 live catalog 一致)
- [ ] task-dev `octopus resource install builtin:task-dev` + 验证 GET detail

## Risks & Notes

- R1:**/goal 属交互面能力,版本漂移风险**——headless 行为 Anthropic 无稳定承诺。决策(walkthrough I):**不做运行时探测/能力上报接口**,claude provider 信任 /goal 可用(2.1.250 三组实测);绊网=把 headless `/goal` 探针脚本纳入 weekly CI(pi-compat-check 同侧),漂移即红,而非引擎内降级路径。buildGoalPrompt 保留为装配器(condition 前置逻辑所在),不再有 fallback 分支语义。
- R2:全量注入 + 默认 max_turns 200 的 token 成本上界比现状高——condition 文本本身要求精炼(写作约定已入文档);预算轴另有 max_budget_usd。
- R3:agent-runner 终态白名单改动可能影响既有 is_error 路径——只增两 subtype,其余行为不变;回归跑 engine 测试基线(13 文件既有失败集不可新增)。
- R4:evaluator 判定质量取决于 condition 写法——task-dev 模板给的是"逐条+证据"句式;泛化 goal 写得模糊时表现为烧满 max_turns 后 failed(K3 兜底,可诊断)。
- R5:**cr_status 清理是三处(walkthrough J)**:① ship prompt 中 `$vars.cr_status` 引用;② `variables.cr_status: ""` 声明(yaml :52);③ `superpowers-task-dev.test.yaml` cr-fix mock 的 vars_update(:22/:60)与 vars 断言(:32/:70)——只清 ① 则 sim 必挂(AC7)。

## Glossary

| Term | Meaning |
|------|---------|
| condition | goal 字段插值全文,作为 `/goal` 的完成判据(evaluator 判 met/impossible 的对象) |
| turn | 1 个 assistant API 往返;并行 tool_use 计 1,tool_result 回传开新 turn,goal 续跑计 turn |
| 硬保险丝 | SDK maxTurns/maxBudgetUsd 确定性终态(error_max_*),与 evaluator 软判定正交 |
| active_goal | SDK 流事件 {condition, iterations, last_reason, set_at}——收敛进度证据 |
| 薄适配器 | 引擎只做 /goal 前置装配 + 字段直通 + 终态映射 + 事件透传,不自建 loop |
| 软退出条款 | condition 内"反复无进展→停止并输出阻塞清单"文本,教 evaluator 判 impossible 时给可验收解释 |

## Appendix: Core User Stories(闭环草图,待 walkthrough 校验)

### Story 1: 看板默认无人值守(K6+K2+K3)
[UI] SpecPanel WorkflowBox → 推荐"general-dev"(现指 task-dev)→ goal/ac 占位预填 → 绑定
[API] PUT /api/tasks/:id {workflow_ref, input_values} → ready-gate(goal/ac required 齐)→ confirm 入队
[Data] scheduler job config:workflow=built-in/task-dev, input_values{goal,ac 物化}
[Exec] develop 节点:prompt="/goal <goal+ac+软退出>…" → worker 编码+自查 → evaluator 逐轮判 → met 收敛(或 max_turns=200 响 failed)
[Exec] ship 节点:prompt 三阶段 → ship-report.md 落产物目录 + PR
[Event] 执行详情每轮 active_goal iterations 可查;验收:人对照 ac 看 PR+报告

### Story 2: 作者自定 goal 节点保险丝
[UI] YAML 编辑:`max_turns: 10` 或 `$inputs.my_cap`
[Exec] shared 预扫通过 → executor resolveNodeNumber=10 → provider sdkOptions.maxTurns=10 → 超限 error chunk(带 terminalReason/numTurns)→ runner 不 throw → 节点 failed + goal_evidence
[Event] 看板/执行日志响 + goal_not_met(max_turns)

### Story 3: 老 planning 文件迁移
[UI] 作者保留 `planning:{max_turns:5,verify:true}` → parse 报错指路新字段
[Exec] 改写后通过;engine: octopus_agent + max_turns → validate 警告,运行忽略

## Issues(DAG)
| Stage | Tickets |
|---|---|
| S1(并行) | 01 shared-schema, 02 providers, 06 web-app |
| S2(并行) | 03 engine 适配器(←01,02), 04 workflows 文档(←01) |
| S3 | 05 server preset 迁移(←04) |
| S4 | 07 E2E 全链(←03,04,05,06) |

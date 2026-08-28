# Map: goal-task-dev

## Destination

goal 模式 agent 节点按行业语义运行:**evaluator-gated loop**(worker 迭代 → 独立/半独立判据收敛 → 硬兜底),`planning` 字段全部真实消费,上下文注入无腰斩截断;并新建 **skills-free 的 task-dev 工作流**(goal 模式三节点)替换 general-dev fallback 预设,使任务看板跑通「入队 → 无人值守执行 → 人验收」闭环。

## Notes

- 现状调查(2026-08-28,本 session):goal 模式 = `agent.ts:318-467` 的 prompt 装配器,无 loop、无 evaluator、无上限;`planning.max_turns/tools/disallowed_tools` 全链路无消费;节点级 `tools:` 死字段(xzf-dev ship 在用);VarPool 快照 20 key × 100 字截断,前序输出 200 字截断。
- Provider 层:`SendQueryOptions` 无 maxTurns(仅 `OctopusAgentDef`:33 有);claude provider `:285-286` 已映射 tools/disallowedTools 到 SDK,**未映射 maxTurns**。
- 引擎已有 loop 原语:`break_when`/`while`/`max_iterations`/checkpoint/pause-resume/SSE(`loop.ts:82-100`)。
- 行业语义参考(Claude Code /goal、Codex goal mode):完成条件可判伪 + worker-evaluator 分离 + max_turns/budget 兜底 + 证据耗尽升级状态不死转。
- 用户既定偏好:看板执行期**零交互**(draft chat 完成澄清,验收在人侧);task_spec 是 WHAT 快照,HOW 归 workflow(ADR-0013 handoff、拒绝 ${projects}、拒绝测试方法字段)。
- schema source:`~/.octopus/workflow-schema.json`(repo 内无,octo-workflow-dev skill 头部描述过时)。

## Decisions so far

<!-- one line per resolved ticket -->
- (03) SDK 能力锤定:Options.maxTurns 存在且超限是 `error_max_turns` 终态(非 throw,agent-runner 现会误判失败);maxBudgetUsd SDK 原生但 provider 死字段;OctopusAgentDef.maxTurns 在 toClaudeAgentDef 被静默丢;tools/disallowedTools 管道直通;resume 已接(干预注入即先例)。改动清单 L2/L3/L6(provider+agent-runner)。
- (08) **goal 节点 YAML 消费面 = 零**(全仓库无人在 YAML 用 goal: 字段)→ 语义迁移无兼容包袱;web-app 不渲染 goal(只 Monaco+只读DAG);若走 loop 展开才有合成ID/SSE碎片风险——原生 /goal(D) 路径下全部规避。
- (01) **架构=D:goal 节点 = SDK 原生 /goal + 薄适配器**(condition 前置 / 事件透传 / error_max_turns 终态分类 / feature-detect 降级);loop 糖与自造执行器否决。
- (02) condition=goal 全文(插值约定携带 ac,引擎零 ac 概念);verify 删除;不收敛=evaluator impossible 常规出口 + error_max_turns→failed 带证据;软退出条款进写作约定。
- (05) planning 整块废弃→节点级 max_turns/max_budget_usd/disallowed_tools + 救活 node.tools(SDK 直通);实测 maxTurns 掐断 /goal 续跑成立;非 claude engine 静默忽略+validate 警告。
- (04) 截断全取消(全量注入);/goal 实测 resume 会话内可用 → context: 机制保留,不强制新会话。
- (06) task-dev=两节点(develop goal + ship prompt),max_turns 为工作流参数默认200(字段 number|string,executor 替换数值化);无独立 cr 节点(自查折进 condition);cr-fix goal 化归 superpowers-task-dev;general-dev fallback 换绑 task-dev。
- (09) JSON schema 废弃:删 YAML 头引用+孤儿文件,权威=Zod parser+skill references(goal 新语义写这)。
- (08-发现) **workflow-schema.json 同步已断**:源文件 2bc5951d 被删,sync 脚本 existsSync 静默跳过,~/.octopus 是 7-22 孤儿,3 个 YAML 头+2 个 SKILL 引用悬空 → 新增 09 号决策。

## Not yet specified

- 不收敛终态(error_max_turns 分类 + active_goal iterations 证据)在看板与执行 UI 的呈现(等 D1/D2 落地后可成形)

- `interaction_agent` 的 goal 字段语义是否同步治理(倾向 out of scope)
- superpowers-task-dev develop/cr-fix goal 化改造(已定方向,工单排期问题)
- matt-dev-pipeline / xzf-dev 的 interaction 节点在 task preset 下的最终去留(用户已否决 badge/文案方案,默认换绑后它们的定位)

## Out of scope

- evaluator 的结构化评分协议深化(阈值/置信度框架)——本次只到"能判伪收敛"
- 除 goal 模式外的其他节点类型 loop 化
- task_dispatch/复合任务的 goal 化(物化链路不变)
- 看板验收状态机改造(执行完成 → 待验收 → 通过/打回)——task-dev 交付物是 PR+报告,状态机另案
- 不收敛终态(error_max_turns/active_goal 证据)的看板与执行 UI 专门呈现——引擎侧证据链(SSE/JSONL/failed)本期打通,UI 强化另案
- `interaction_agent` 的 goal 字段语义治理(不同步,维持现状)

## Tickets

| # | Title | Type | Status | Blocked by |
|---|-------|------|--------|------------|
| 01 | D1 执行架构:loop 语法糖 vs 新执行器 | grilling | **resolved=D 原生/goal** | — |
| 02 | D2 done 条件协议与 evaluator 形态 | grilling | resolved | 01 |
| 03 | Research: Claude SDK/provider 管道缺口清单 | research | resolved | — |
| 04 | D3 上下文注入截断修复与预算策略 | grilling | resolved | — |
| 05 | D4 planning 字段语义表 + tools 救活范围 | grilling | resolved | 03 |
| 06 | D5/D6 task-dev 形态 + preset 换绑 | grilling | resolved | 01, 02, 05 |
| 07 | 验证策略(MANDATORY GATE,6 维度) | grilling | resolved | 06 |
| 08 | Research: goal/loop 既有消费方影响面(simulator/web-app/registry) | research | resolved | — |
| 09 | workflow-schema.json 路线:恢复源文件 vs 废弃 | grilling | resolved=B | 01 |

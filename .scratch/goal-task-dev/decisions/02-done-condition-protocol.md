# 02 — D2 done 条件协议与 evaluator 形态

Type: grilling
Status: resolved
Blocked by: 01

## Question

goal 收敛判定协议怎么定?

- worker 自报:输出约定 `{"goal_done":"true|false", ...}`(+ 可选 done_reason),loop break_when 消费——轻量,零额外 token。
- 独立 evaluator:`planning.verify: true` 启用第二 agent(不同会话、只读判据)对照 goal+ac 证据判伪——行业 /goal 语义,成本翻倍。
- 是否引入显式 `done_when` 表达式字段(YAML 直接写布尔表达式,不靠约定 JSON)?
- evaluator 的判据来源:goal 文本?$inputs.ac?节点 done_when?
- 未达上限但未收敛:failed 还是新增终态?

## Answer

**02a:condition = goal 字段全文,身兼二职**(用户确认)。ac 进 condition 走**插值约定**——task-dev 作者在 goal 文本里写 `$inputs.goal` + 验收标准清单 `$inputs.ac`;引擎零 ac 概念,只装配文本。goal/ac 全空由 ready-gate 双 required 拦截。
- 否决:新增 done_when 字段(双字段 90% 重复,goal 会被写随便);引擎自动拼模板(收敛问题无法归因)

**02b:终止与 verify**(用户确认):
- `planning.verify` **删除**(零遗留,octo-workflow-dev 文档补 goal 模式正确用法)
- 不收敛常规出口 = evaluator 的 **impossible 判定**(CC 内建);condition 写作约定带软退出条款("反复尝试无法达成→停止并输出阻塞原因清单")
- `error_max_turns` → 节点 **failed**,error 携带 iterations/last_reason(active_goal 证据)——无人值守里"未收敛必须响",下游不在烂摊子上续跑

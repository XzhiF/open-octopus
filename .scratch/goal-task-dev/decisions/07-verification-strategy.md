# 07 — 验证策略(MANDATORY GATE)

Type: grilling
Status: resolved
Blocked by: 06

## Question

覆盖 6 维度:验证层级(单测/集成/E2E/契约/手动)、中间件连接(DB/文件)、测试数据、断言方法、前置条件、反假跑 R1-R8。

核心难点预感:goal-loop 的 E2E 真跑需要 LLM,反假跑怎么定义收敛证据?(simulator fixture 断 $vars 终态;真跑用一个最小 goal 任务)

## Answer

双层验证方案(2026-08-28 呈报,随 spec 定稿):
- 单元:parser(新字段/max_turns string|number/planning 拒绝/goal-prompt 互斥)、provider 映射断言、executor 数值替换、error_max_turns→failed 映射、截断移除(全量注入)、validate 警告(非 claude+budget 字段)
- 真实执行集成(不 mock claude):①收敛向=hello-goal 最小任务(文件内容机械可判)→ completed + active_goal 事件在 JSONL/SSE;②不收敛向="说出7每轮说1" × max_turns 3 → failed + 证据。两向都真跑,goal 机制没测不收敛=没测。
- API E2E:presets fallback=task-dev、PUT 绑定+input_values.max_turns、ready-gate、物化断言(DB+API 交叉)。看板全链路真执行归 out-of-scope(成本),物化层断言覆盖。
- simulator fixture:task-dev/superpowers-task-dev 场景(单节点形状不变)。
- 环境:本地 claude CLI 2.1.250(dev server :3001)、E2E_TEST_GTD_ 前缀、cleanup DELETE+rm、R1-R8。

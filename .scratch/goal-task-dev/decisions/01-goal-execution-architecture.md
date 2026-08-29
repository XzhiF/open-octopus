# 01 — D1 goal 模式执行架构:loop 语法糖 vs 新执行器

Type: grilling
Status: resolved
Blocked by: None

## Question

goal 模式升级为 evaluator-gated loop 后,实现载体是什么?

- A. **语法糖**:goal 节点在 DAG 调度层展开为 loop(max_iterations=max_turns)+ [worker agent, evaluator] 子节点,break_when 判 done。复用 loop 的 checkpoint/恢复/SSE/前端布局,无新状态机。
- B. **新 GoalLoopExecutor**:executor 内部自持多轮会话(SDK resume),引擎只见一个节点。对外形状简单,但 checkpoint/心跳/终止语义全部重造。
- C. 混合:语法糖形状 + executor 内部轻量迭代(worker 会话 resume,evaluator 独立)。

约束:goal 节点的 vars_update 协议、$iteration 暴露与否、历史兼容(现存 YAML 里 goal 节点的运行形状会改变)。

## Answer

**D — 原生 /goal + 薄适配器**(用户确认 2026-08-28)。

goal 节点执行 =
1. condition 装配 → prompt 前置 `/goal <condition>`(headless 实测可用:claude -p 首 turn slash 被处理,synthetic "Goal set" 消息,1 turn 收敛)
2. provider 补 `SendQueryOptions.maxTurns` → sdkOptions(研究03 L2/L3);`error_max_turns` 终态在 agent-runner 特判,不再当异常 throw(L6)
3. `active_goal` 事件(condition/iterations/last_reason/tokens_at_start)透传 SSE → 执行详情与验收证据
4. feature-detect(`supportedCommands()` 或版本探测):不支持时降级现有 buildGoalPrompt 装配(保留兼容路径)

否决项:
- A 引擎 loop 语法糖:合成节点 ID/SSE 碎片/simulator 换形/编辑器空白全部代价(08),且自建 evaluator 每圈烧我们 token——/goal 已内建独立判据机
- B GoalLoopExecutor 重造轮子:同上,还失去 CLI 的 goal 状态机演进

依据:08=全仓库 goal YAML 消费面为零,无兼容包袱;03=SDK Options.maxTurns + error_max_turns 终态 + active_goal 在 StdoutMessage union(/goal 是面向宿主 surface 设计的);单会话连续执行保留多轮工作记忆(A/B 需 resume 拼接)。

# 04 — D3 上下文注入截断修复与预算策略

Type: grilling
Status: resolved
Blocked by: None

## Question

goal 模式自动注入的上下文(VarPool 快照 20key×100字、前序输出 200 字)如何修?

- 取消腰斩:值要么全量要么整条跳过?总字符/Token 预算多少?
- goal/ac 是否规定必须走 Goal 段全量替换(现状已如此),快照只作发现用途?
- 前序节点结果:完整 last_output 会爆(上游可能是万字报告)——截断+指引 agent 自查($node.output 全文可达?)还是分层摘要?
- 预算超出的可观测性(log/SSE 提示"已省略 N 个变量")?

## Answer

**4a(用户拍板)**:注入段(VarPool 快照/前序节点结果)**直接取消一切截断**——全量注入,无预算无腰斩。现状 100/200 字截断逻辑删除。

**4b(实测锤定,research 完成)**:`/goal` 在 **resume 会话内完全可用**——`--resume <sid>` 首 turn "Goal set" 正常处理,evaluator 拦停续跑,3 turns 收敛(subtype: success)。
→ **不强制新会话,YAML 的 `context:` 机制原样保留**(continue/new 由作者定)。连带收益:context: continue 的 goal 节点天然继承上游会话上下文。

## Answer(04b 落档)

resume 会话实测:session 建立后 `--resume` 发 `/goal …` → "Goal set" 处理正常,evaluator 拦停续跑,3 turns 收敛(subtype: success)。**context: 机制原样保留,goal 节点不强制新会话。**

**turn 语义(实测锤定)**:1 turn = 一个 assistant API 往返;tool_result 回传开新 turn(工具轮消耗额度),单响应内 N 个并行 tool_use = 1 turn;/goal evaluator 拦停续跑同样计 turn。证据:5 工具轮任务 × `--max-turns 3` → error_max_turns, num_turns=4。task-dev 默认 200 = 200 模型往返步,量级合理。

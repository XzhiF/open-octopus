# 03 — 干预动作协议：harness 能做什么？

Type: grilling
Status: open
Blocked by: 01

## Question

当 harness 检测到问题并决定要干预时，它能执行哪些动作？

候选干预动作：
- pause: 暂停当前节点
- skip: 跳过当前节点
- retry_with_strategy: 带不同策略重试（换方法/换模型）
- inject_message: 向 agent 注入纠正消息
- new_session_rerun: 保存 brief → 新开 session → 读取 brief → 重跑
- abort_branch: 终止当前分支
- fallback_node: 执行备用节点
- escalate: 上报人工

需要确定：哪些是 P0 必须有的？哪些是 P1/P2？

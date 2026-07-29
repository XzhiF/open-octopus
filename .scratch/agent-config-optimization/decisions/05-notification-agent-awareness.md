# 05 — 通知渠道 Agent 感知

Type: grilling
Status: resolved
Blocked by: None

## Question

通知渠道配置测试 OK，但 main agent 本身不知道自己有这个能力。这意味着：
1. Agent 不会主动使用通知（如任务完成通知用户）
2. Agent 的 system prompt 里没有注入通知能力说明
3. 没有对应的 skill/tool 让 agent 调用通知

需要让 agent 感知并利用通知渠道吗？如果是：
- 通过 System Prompt 注入通知说明？
- 创建一个 notify skill？
- 创建一个 notify tool？

## Answer

**决定**: 创建 `octo-notify` skill，让 agent 知道：
1. 通知渠道已配置（platform + target）
2. 何时应该主动通知（长时间任务完成、重要事件、错误告警）
3. 如何触发通知（通过 skill 指令调用 NotificationService）

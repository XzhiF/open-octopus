# Safety System Redesign — Decision Map

## Destination
安全系统从"假实现"变为"诚实的半成品" — 每个声称的安全能力要么真正生效，要么从 UI 移除。

## Notes
- 两个执行平面: Agent Chat (Claude SDK subprocess, 被动中继) vs Workflow Engine (服务器控制调度)
- `permissionMode: 'bypassPermissions'` 在 `packages/providers/src/claude/provider.ts:170` **硬编码**
- SafetyInterceptor 只审计用户消息文本，不拦截 tool 执行
- Evolution 已有 `classifyLevel()` 安全检查 (minor=自动应用, major=仅记录)
- Scheduler 用 node-cron + setInterval, 无 safe_mode 检查
- `POST /safety/confirm` 是事后审计更新，不是阻塞机制

## Not yet specified
- Agent Chat 平面的 tool 拦截是否需要实现？
- Workflow Engine 平面是否需要安全检查？
- 安全审计 UI 是否保留？
- bypassPermissions 是否需要可配置？

## Out of scope
- Claude SDK 源码修改
- 多租户安全隔离
- 合规审计 (SOC2/ISO27001)

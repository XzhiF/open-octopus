# 06 — 面板整体布局优化

Type: grilling
Status: resolved
Blocked by: 01

## Question

当前 7 个面板的排列顺序：
1. GeneralConfig (通用配置)
2. SafeModePanel (安全降级)
3. PersonaEditor (人格设定)
4. NotificationConfig (通知渠道)
5. MemoryStrategyConfig (记忆策略)
6. SafetyAudit (安全审计)
7. DebugLogViewer (调试日志)

这个顺序是否符合用户使用逻辑？是否需要重新分组或调整？

## Answer

**决定**: 按场景分组重排
1. GeneralConfig (通用配置) — 最常改的基础设置
2. PersonaEditor (人格设定) — Agent 个性定制
3. NotificationConfig (通知渠道) — 外部通信配置
4. MemoryStrategyConfig (记忆策略) — 数据管理策略
5. SafeModePanel (安全降级) ┐
6. SafetyAudit (安全审计)    ┘ 安全组放在一起
7. DebugLogViewer (调试日志) — 含 Debug Mode 开关，放最后

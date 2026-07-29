# 09 — Agent Evolution Tools

Type: grilling | Status: resolved

## Question
Agent 怎么执行进化操作？

## Answer
**注册进化工具集（MCP 或内置 tool）：**

| Tool | 作用 |
|------|------|
| `mark_insight` | 即时标记：「这次对话发现了 X，值得进化 Y skill」 |
| `evolve_skill` | 执行 skill 进化：修改 SKILL.md + 记录 evolution_log |
| `create_experience` | 记录经验：写入 experiences 表 |
| `merge_skills` | 合并重复/相似的 skill |
| `archive_skill` | 归档过时 skill |

会话结束/定时时，系统调用现有的 `reflect()` 机制批量处理标记。

# 08 — Grilling: octopus_agent Session Management

Type: grilling
Status: resolved
Blocked by: 06

## Question

octopus_agent 执行时，agent 的 session 与分身系统的关系？

## Answer

**Decision: New Delegate Session**

- 每次 octopus_agent 执行创建新的 `session_type: 'delegate'` session
- 关联字段：clone_name, version, parent_execution_id
- persona/skills/memory 从版本快照加载（非实时读取活跃目录）
- 对话上下文每次执行是干净的（不复用 clone 的直接对话 session）
- 执行完成后 session 保留（可审计、可追溯）
- 不影响 clone 后续的独立对话 session

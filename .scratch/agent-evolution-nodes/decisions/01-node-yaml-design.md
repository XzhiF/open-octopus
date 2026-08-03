# 01 — Node YAML Design

Type: grilling
Status: resolved

## Question
How should Main Agent and Clone nodes be represented in workflow YAML?

## Answer
Unified `type: system_agent` node with `role` field to distinguish:

```yaml
# Main Agent
- id: analyze
  type: system_agent
  role: main
  prompt: "分析代码"

# Clone
- id: schedule
  type: system_agent
  role: clone
  clone: scheduler
  prompt: "创建定时任务"
```

**Reason**: Single node type reduces schema complexity while `role` field provides clear semantics. Reuses existing node infrastructure with a routing layer.

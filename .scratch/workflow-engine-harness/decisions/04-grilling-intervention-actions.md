# 04 — 干预动作与节点状态

Type: grilling
Status: resolved
Blocked by: 01, 02

## Question

Harness Agent 分身怎么干预？节点需要什么新状态？

## Answer

### 四种干预模式

| # | 模式 | 场景 | 机制 |
|---|------|------|------|
| ① | inject_instruction | Agent 节点超时/方向错误 | 通过 repair/intervene API 注入消息，Agent 有上下文继续执行 |
| ② | agent_takeover | Bash/Python 脚本太复杂，改写不安全 | Harness Agent 分身直接接管执行，写回节点结果 |
| ③ | modify_varpool | 运行时变量值错误 (如 model: "soonet") | 通过 repair/varpool API 修改变量值，重试节点 |
| ④ | modify_definition | Workflow YAML 定义错误 | 修改 workflow 定义中的值，reload + 重试节点 |

### 干预模式选择逻辑

```
DiagnosisReport:
  → node_type == "agent" AND timeout → ① inject_instruction
  → node_type == "bash"/"python" AND complex_script → ② agent_takeover  
  → error matches varpool_pattern → ③ modify_varpool
  → error matches definition_pattern → ④ modify_definition
  → 不确定 → 委托给 Agent 分身，让它选择
```

### 节点状态扩展

现有: pending → running → success / failed / skipped / cancelled / paused

新增:
```
failed → harness_intervening → harness_modified (改了脚本/变量/定义后重试)
                             → harness_executed (Agent接管执行完成)
                             → failed (干预也失败了)
```

状态流:
```
harness_intervening: harness 正在分析和执行干预
harness_modified:    harness 修改了某些东西，节点将重试
harness_executed:    harness agent 接管执行了该节点
```

### Token 计费
- harness agent 分身的 token 使用独立记录到 token_usages 表
- 关联字段: execution_id + node_id + source: "harness"
- Workflow 总览中汇总: 原始执行 token + harness 干预 token
- UI 显示: 节点 token 用量中区分 "原始" vs "harness 干预"

### UI 干预历史
每个被干预的节点显示:
- 干预时间线: failed → intervening → modified → running → success
- 干预详情: 用了哪种模式、改了什么、为什么
- Token 消耗: 原始 vs harness

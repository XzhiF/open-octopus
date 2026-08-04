# 09 — Grilling: Harness Layer Scope

Type: grilling
Status: resolved
Blocked by: 06

## Question

本次开发中，Harness 层实现到什么程度？

## Answer

**Decision: Observation + 基础 Intervention**

### 本次交付
- **Layer 3 - Observation**: Heartbeat 事件（step, tokens_used, artifacts, issues, confidence）→ SSE 推送 → 写入 execution events
- **Layer 4 - 基础 Intervention**: `abort`（复用 AbortSignal）+ `pause`（复用 engine.pauseAtNode）

### 后续迭代（不在本次范围）
- `redirect`: 重定向 agent 行为（需 harness 规则引擎）
- `checkpoint`: 中间状态存档（需 harness 状态管理）
- `continue`: 带新指令继续（复用 intervention 机制）
- `harness_rules`: 自动判断规则（预算阈值、停滞检测、置信度等）

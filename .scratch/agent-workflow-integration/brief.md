# Brief: Agent Workflow Integration

## Overview
为 Octopus 系统构建 Agent 版本管理 + octopus_agent workflow 节点 + 四层委派协议栈，使 workflow 能结构化地委派任务给系统定义的专业分身，并具备实时监控和干预能力。

## Summary
- **10** key decisions → [spec.md § Key Decisions](./spec.md#key-decisions)
- **11** acceptance criteria stories → [spec.md § User Stories](./spec.md#user-stories)
- **3** core stories verified → [spec.md § Appendix](./spec.md#appendix-core-user-stories-closed-loop-verification)
- **6** DAG implementation tickets → [issues/](./issues/)
- **18** walk-through break points fixed → [story-walkthrough.md](./story-walkthrough.md)

## Key Architecture Decisions
1. **Release Tag + Maven 限定符** (alpha/beta/rc/stable) 版本模型
2. **组合模式 OctopusAgentExecutor** 包装现有 AgentExecutor
3. **四层协议栈**: Contract (入/出) + Observation (Heartbeat) + Intervention (abort/pause) + Transport (现有)
4. **DB + Filesystem 双存储**: DB 查询 + FS 运行时性能，补偿事务保证一致性
5. **New Delegate Session**: 每次 octopus_agent 执行创建隔离 session
6. **v1 Harness**: Observation (Heartbeat SSE) + 基础 Intervention (execution-level pause/abort)

## Risks
- **R1**: DB ↔ FS 双写一致性 → 补偿事务模式缓解
- **R2**: Heartbeat token 开销 → 默认 interval=3 步
- **R3**: v1 pause 是 execution-level 非 node-level → 后续迭代
- **R4**: dynamic_sub_workflow L3 whitelist 需更新 → 已纳入 ticket #06
- **R5**: Heartbeat confidence/issues v1 未实现 → -1/[] 占位，后续 heartbeat prompt 协议

## Implementation Phases (5 phases, 6 tickets)
| Phase | Ticket | Unblocks |
|-------|--------|----------|
| 1 | [#01 Version Foundation](./issues/01-version-foundation.md) | Stories 1-4, 11 |
| 2 | [#02 Types & Registration](./issues/02-types-and-registration.md) | Stories 5-10 |
| 3 | [#03 Executor & Sessions](./issues/03-executor-and-sessions.md) | Stories 5-7 |
| 4 | [#04 Heartbeat & Intervention](./issues/04-heartbeat-and-intervention.md) | Stories 8-9 |
| 5 | [#05 Frontend Versions Tab](./issues/05-frontend-versions-tab.md) | Stories 1-5 UI |
| 5 | [#06 Dynamic Compat](./issues/06-dynamic-sub-workflow-compat.md) | Story 10 |

## Full Spec
[spec.md](./spec.md)

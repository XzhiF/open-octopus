# Brief: WorkflowEngine Harness — Agentic 监督层

## Overview
为 Octopus WorkflowEngine 增加三层委托架构的 Agentic Harness 监督层，解决 agent 傻重试、进程冲突杀宿主、模型能力不匹配三大痛点。

## Summary
- 8 个关键决策 → [spec.md § Key Decisions](./spec.md)
- 8 个验收标准 → [spec.md § Verification Strategy](./spec.md)
- 3 个核心故事闭环验证 → [spec.md § Appendix](./spec.md)

## Risks
- R1: 引擎回调侵入性 — 3 个新回调需修改 engine.ts，需测试向后兼容
- R2: Agent 分身可靠性 — Layer 3 委托可能自身出错
- R4: Windows 沙箱限制 — 基础层 Wrapper 可被绕过，建议 Linux 部署

## Full Spec
[spec.md](./spec.md)

## Decision Map
[map.md](./map.md)

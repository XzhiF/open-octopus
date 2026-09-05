# Brief: v4 阶段衔接环 — handoff.md + prev_handoff_paths

## Overview

给 v4 多 phase 任务补上跨 phase 的自动上下文交接环：ship 每轮产三段式 handoff.md，accepted 时 server 自动把前序交接路径注入下一 phase 执行输入，消灭「人工转述」断点。

## Summary

- 6 key decisions（K1 范围 A+B+D / K2 ship 产每轮覆写 / K3 自动注入 prev_handoff_paths / K4 三段式契约 / K5 SKILL 纪律档 / K6 弹窗一行提示）→ [spec.md § Key Decisions](./spec.md)
- 3 execution decisions（walkthrough / E2E / 票执行模式）→ [spec.md § Execution Decisions](./spec.md)
- 7 acceptance criteria → [spec.md § Verification Strategy](./spec.md)
- 2 core stories traced → [spec.md § Appendix](./spec.md)
- 5 tickets / 2 DAG stages（01·02·04 并行 → 03·05）→ [issues/](./issues/)
- 决策权威 → [ADR-0019](../../docs/adr/0019-phase-handoff-channel.md)

## Risks

- R1: spec-resolve bash 读 home 绝对路径可能被 path-guard 挡（先小样验证；退路=seed 拷入，动 seed 协议）
- R2: ship 崩溃轮无 handoff.md → 信道静默缺一角（存在性过滤 + 批次清单可见性缓解）
- R4: 自定义流不消费注入键 = 静默失效（SKILL 负责提醒）

## Full Spec

[spec.md](./spec.md)

# Brief: 任务看板 Phase 化重构

## Overview

看板 coding 任务收敛为「四层契约」：内置升级版 spec agent（matt 惯例）产出多 Phase spec，一任务一 workspace、每 Phase 一次执行+一道人工验收（打回成 Round），产物 seed/collect 单向环，末 Phase 归档合并回各 project；技能组/preset/goal-ac 退场。

## Summary

- 17 项关键决策（K1-K17）→ [spec.md § Key Decisions](./spec.md)
- 3 项执行决策（walkthrough / E2E / mode）→ spec.md § Execution Decisions（出口批量一问回填）
- 20 条用户故事 / 20+ 条可执行 AC → [spec.md § User Stories / Verification Strategy](./spec.md)
- 决策全程留痕：[map.md](./map.md) + [decisions/](./decisions/)（11 票全 resolved，含 3 路 research 回填）

## Risks

- R1: 改造面大（server 域模型 + web + skill 重写），票间依赖串行度高
- R2: 验收账本与乐观锁并发窗口
- R3: 多 project 归档 PR 编排最易碎（archiving 可重试兜底）
- R4: SKILL.md 拆分质量无法全自动验证（靠 skill-evolution 回路）
- R5: v3 共存长尾（generic/composite 仍吃 goal/ac）

## Full Spec

[spec.md](./spec.md)

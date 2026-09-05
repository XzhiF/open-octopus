# 03 — ws 权威 collect 环反转

Status: done

## What
`task-artifact-sync.ts` 删 HOME_AUTHORITATIVE 跳过分支：批次目录全类（含 spec*.md）ws-mtime-strictly-newer 回流 home；头注释/seed 注释（executor、tasks-service）改「home=终态镜像」口径；ADR-0018 落文 + ADR-0011 状态注。

## Verification Method
- `npx vitest run tasks-v4-artifact-loop` AC3 反口断言：ws 改 spec.md → 轮终态后 home 内容=ws 版；未改动轮 re-collect 空集

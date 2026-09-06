# 01 — Sim Fixture Demo Ticket

## What to build

固定夹具票，供 spec-resolve 真执行场景核对 `issues/` 非空。永不实际执行
（simulate 中 ticket-dag 为 mock）。

## Blocked by

None — can start immediately.

## Status

ready-for-agent

## Acceptance Criteria

- [ ] AC1: 存在即满足（ls issues/*.md 计数 ≥ 1）

## Verification Method

**Verification type**: 文件存在性（由 spec-resolve 探测覆盖）

**Pass criteria**: ticket_count ≥ 1

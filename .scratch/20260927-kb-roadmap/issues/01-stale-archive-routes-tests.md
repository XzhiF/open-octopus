# 01 — 清理 stale 的 archive-routes 测试（10 例）

## What to build
`packages/server/src/routes/__tests__/archive-routes.test.ts` 有 10 例在 HEAD 即红：
`/stats` `/cost-trends` `/leaderboard` 端点在 `17a70a42 refactor(archive-v2) Phase 7` 被有意删除，测试未同步。

二选一裁决后执行：
- 若端点确认弃用 → 删对应测试例，测试文件转绿；
- 若产品仍需要这些只读统计 → 在 routes/archive.ts 恢复端点（读归档表，不引入新写路径）。

## Blocked by
无（P0 提交后即可开）

## Status
pending

## Triage labels
needs-triage

## Acceptance Criteria
- [ ] `pnpm --filter @octopus/server test archive-routes` 全绿
- [ ] 全量套件中该文件不再出现在失败集

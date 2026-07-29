# Issue 3: Scheduler auto-seed `system:daily-archive` task

## Summary
On server startup, check if `system:daily-archive` exists in `schedules` table. If not, insert it with cron `0 3 * * *`.

## Changes
1. `packages/server/src/index.ts` — add seed logic after DAO initialization
2. `packages/server/src/db/dao/schedule-config-dao.ts` — add `findByName()` helper

## Details
- Add `findByName(org, name)` to `ScheduleConfigDAO`
- In `index.ts`, after all DAOs and services are initialized, call seed function:
  ```
  if (!scheduleConfigDAO.findByName('system', 'system:daily-archive')) {
    scheduleConfigDAO.insertSchedule({ id: 'system:daily-archive', org: 'system', name: 'system:daily-archive', cron_expression: '0 3 * * *', timezone: 'Asia/Shanghai', job_type: 'agent', config: JSON.stringify({ prompt: 'Archive yesterday daily memory and refine long-term memory' }), enabled: 1 })
  }
  ```
- Seed is idempotent — safe to call on every startup
- Seed failure is non-fatal (log warning, continue)

## Verification Method
- Build: `pnpm build` succeeds
- Manual: start server, query schedules table, verify row exists

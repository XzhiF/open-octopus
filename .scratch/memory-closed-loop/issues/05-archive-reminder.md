# Issue 5: Archive reminder in SystemPromptAssembler (>3 days unarchived)

## Summary
In the SystemPromptAssembler daily memory segment, count daily files. If >3, add a reminder for the Agent to suggest archiving.

## Changes
1. `packages/server/src/services/agent/system-prompt-assembler.ts` — modify `buildDailyMemorySegment()` to include archive reminder

## Details
- Count `.md` files in the daily directory
- If count > 3, append reminder text:
  ```
  ⚠️ 有 {count} 个未归档的每日记忆文件。建议在合适的时机提醒用户执行归档操作。
  ```
- The reminder is part of the daily memory segment (priority 3)
- Count failure is silently ignored

## Verification Method
- Build: `pnpm build` succeeds
- Manual: create 4+ daily files, assemble prompt, verify reminder appears

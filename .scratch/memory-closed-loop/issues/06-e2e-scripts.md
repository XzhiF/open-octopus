# Issue 6: E2E test scripts

## Summary
Create automated E2E test scripts that verify the full closed-loop memory pipeline.

## Changes
1. `.scratch/memory-closed-loop/e2e-scripts/` — create test scripts

## Details
- `01-verify-record-daily.sh` — curl POST /api/agent/chat with a meaningful message, check daily file for new content
- `02-verify-scheduler-seed.sh` — curl GET /api/scheduler/jobs, verify system:daily-archive exists
- `03-verify-archive-refine.sh` — curl POST /api/memory/archive, verify long-term.md updated and .bak exists
- `04-verify-archive-reminder.sh` — create 4+ daily files, send chat message, check response for archive reminder

## Verification Method
- Scripts are executable and can be run manually against a running server

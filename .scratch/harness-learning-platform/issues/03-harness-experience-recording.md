# 03 — Harness Experience Recording (onExecutionEnd)

## What to build
在 HarnessController.onExecutionEnd() 中实现干预经验持久化：将所有干预记录写入 experiences 表（scope=harness），同时写入 clone daily memory。这是经验积累的写入端。

## Blocked by
01 — Schema Migration (needs new columns: scope, node_id, outcome, etc.)

## Status
ready-for-agent

## Acceptance Criteria
- [ ] AC-1: HarnessController.onExecutionEnd() 遍历 session interventions 并写入 experiences
- [ ] AC-2: 每条 experience 包含 scope='harness', scope_ref=detector, node_id, pattern_tags, execution_id
- [ ] AC-3: outcome 初始为 {label:'pending'}，后续由 ticket 04 更新
- [ ] AC-4: 同时写入 clone daily memory（MemoryService.recordDaily with cloneDir）
- [ ] AC-5: HarnessAgentSession.close() 扩展：记录干预摘要 + 调用持久化
- [ ] AC-6: content 字段包含结构化干预摘要（detector + pattern + decision + reasoning）
- [ ] AC-7: 现有 harness_events 写入不受影响（双写：raw events + distilled experience）

## Verification Method
**Verification type**: integration test

**Verification steps**:
```bash
# 1. Run harness lifecycle test
pnpm --filter @octopus/server exec vitest run --reporter=verbose src/__tests__/harness-experience-recording.test.ts

# 2. Verify DB after simulated execution
sqlite3 ~/.octopus/db/octopus.db "SELECT scope, scope_ref, node_id, outcome FROM experiences WHERE scope='harness' ORDER BY id DESC LIMIT 5"

# 3. Verify clone daily memory file
cat ~/.octopus/agent/built-in/harness-agent/memory/daily/$(date +%Y-%m-%d).md
```

**Pass criteria**: All 7 ACs pass
**Failure handling**: Max 3 fix attempts, then mark SKIP with reason

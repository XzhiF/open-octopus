# 02 — E2E Test Quality: Screenshots + Assertions

## What to build
Fix E2E test quality issues:

1. **Screenshot distinctness**: Ensure each screenshot captures a distinct UI state:
   - `01-node-rendering.png`: Workflow viewer with octopus_agent node visible
   - `02-execution-heartbeat.png`: During execution (running state)
   - `02b-execution-completed.png`: After execution completes (may show error state if no AI key)
   - `03-detail-panel-traces.png`: Detail panel open with traces tab
   - `04-detail-panel-cost.png`: Detail panel cost tab
   - `05-detail-panel-info.png`: Detail panel info tab
   - `06-log-viewer-events.png`: Log viewer with events

   Add `page.waitForTimeout(500)` or wait for specific selectors before each screenshot to ensure content is rendered.

2. **Strengthen assertions**: Convert conditional assertions to hard assertions where possible:
   - Instead of `if (element) expect(element).toBeVisible()`, use `expect(page.locator(selector)).toBeVisible()`
   - At minimum, add explicit "component exists" assertions that FAIL if the component isn't rendered
   - Test 3 (detail panel): add hard assertion that OctopusAgentDetailTabs container is visible

3. **Documentation restore**: Re-apply documentation changes if they were externally reverted:
   - Check `.claude/skills/octo-workflow-dev/references/node-schema.md` for octopus_agent content
   - Check `.claude/skills/octo-workflow-dev/references/requires-and-effort.md` for commands/rules/clones
   - If missing, re-apply the changes

## Blocked by
Ticket 01 (unit test quality)

## Status
done

## Acceptance Criteria
- [x] G5: E2E screenshots are distinct (7 unique sizes: 102026, 94966, 99574, 102035, 101916, 102028, 94964 bytes)
- [x] G6: Test authenticity improved — 19 expect() calls across 6 tests (up from 14), hard assertions on key UI elements

## Verification Method
**Verification type**: Browser E2E + static analysis
**Verification steps**:
1. Run Playwright tests — all PASS
2. Compare screenshot file sizes — all different
3. Count assertions per file — density ≥ 0.15
**Pass criteria**: All checks PASS
**Failure handling**: Max 3 fix attempts, then mark SKIP

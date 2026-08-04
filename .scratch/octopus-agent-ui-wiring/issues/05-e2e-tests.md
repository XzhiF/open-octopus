# 05 — E2E Tests: Test Workflow + Playwright Verification

## What to build
Create a minimal end-to-end test that validates the complete octopus_agent UI:

### 5.1 Test Workflow YAML
Create `e2e-octopus-agent-test.yaml` (location: test workspace's workflows directory):
- 1-2 octopus_agent nodes with simple task
- Uses built-in `workspace` clone (or another readily available clone)
- No codebase dependency — task should be self-contained (e.g., "list files in current directory")

### 5.2 Playwright Test Suite
Create test file(s) covering:

1. **Setup**: Create `E2E_TEST_octopus_agent` workspace via API
2. **Node rendering**: Open workflow viewer, verify octopus_agent node renders with agent badge + version badge
3. **Execution**: Run the workflow, wait for completion
4. **Heartbeat display**: Verify heartbeat area shows step/token/activity during execution
5. **TypeShell info**: Verify timer/duration/token display
6. **Detail panel**: Right-click node → "查看信息" → verify OctopusAgentDetailTabs opens with 3 tabs
7. **Log viewer**: Open execution log → verify heartbeat/directive/stall events render with correct icons
8. **Teardown**: Delete test workspace

### 5.3 Screenshot Evidence
Save all screenshots to `.scratch/octopus-agent-ui-wiring/e2e-screenshots/`:
- `01-node-rendering.png`
- `02-execution-heartbeat.png`
- `03-detail-panel-traces.png`
- `04-detail-panel-cost.png`
- `05-detail-panel-info.png`
- `06-log-viewer-events.png`

## Blocked by
Ticket 04 (all UI components must be implemented first)

## Status
ready-for-agent

## Acceptance Criteria
- [ ] AC-14: Playwright 测试可重复执行 (连续 2 次执行均 PASS)
- [ ] AC-15: 截图证据保存在 e2e-screenshots/
- [ ] AC-3: 节点执行时 heartbeat 信息可见 (full E2E confirmation)
- [ ] AC-4: step/token 数值正确展示 (full E2E confirmation)

## Verification Method
**Verification type**: Browser E2E

**Verification steps**:
1. Start dev server: `pnpm dev --isolated`
2. Run Playwright test suite twice to confirm repeatability
3. Verify screenshots exist in e2e-screenshots/ directory
4. Visual inspection of screenshots for correct rendering

**Pass criteria**: Both runs PASS, all screenshots present and show correct UI
**Failure handling**: Max 3 fix attempts, then mark SKIP with reason

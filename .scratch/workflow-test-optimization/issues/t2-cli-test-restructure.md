# Ticket T2: CLI `test` Command Restructure — Direct Run + `--fix` + Enhanced Output

**Status**: DONE
**Package**: `packages/cli`
**Files**: `src/commands/workflow.ts`
**Verification**: Manual test + build

## Description

Restructure the `test` command to check for `.test.yaml` fixture and run the simulator directly when found (bypassing Server), falling back to agent delegation only when no fixture exists or `--fix` is used. Add enhanced three-phase output rendering and `--fix` flag.

## Requirements

### R1: Fixture Detection & Path Selection

```typescript
.option("--fix", "强制走 agent 路径，智能修复/生成 fixture")
```

Decision logic:
1. If `--fix` → agent path (skip fixture detection)
2. If `discoverTestFixture()` finds a `.test.yaml` → direct run path
3. Otherwise → agent path

### R2: Direct Run Path

New async function `runDirectTest(workflowPath, fixturePath, displayPath)`:
- Import `loadWorkflow`, `loadTestFixture`, `runTestSuite` from `@octopus/engine` (dynamic import)
- Load workflow and fixture
- Call `runTestSuite(workflow, fixture, { strict: true })`
- Call `renderDirectTestResult(result, displayPath)` for enhanced output
- If failed: print `💡 Run with --fix to auto-fix via AI agent` and `process.exit(1)`

### R3: Enhanced Output Rendering

New function `renderDirectTestResult(result: TestRunnerResult, displayPath: string)`:

Output structure:
```
Testing: <displayPath>
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

📋 Phase 1: Syntax Check
  ✔ <nodeId>: syntax OK       (for each node without syntax errors)
  ✖ <nodeId>: <error>         (for each syntax error)

⚙️ Phase 2: Simulation
  ✔ Scenario "<name>"
    ✔ <nodeId>: <status> [<mocked|real>, <case/extra info>]
    ...

✅ Phase 3: Assertions
  ✔ <assertion message>
  ✖ <assertion message>

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Results: X passed, Y failed (N scenarios, Xms)
```

### R4: Agent Path Enhancements

The existing agent path already handles `tool_call` events. Add `tool_result` rendering:

```typescript
if (currentEvent === "tool_result" && payload.tool_name) {
  const short = (payload.content || "").slice(0, 120).replace(/\n/g, ' ')
  console.log(chalk.dim(`  → ${short}`))
}
```

### R5: `--fix` Flag

When `--fix` is set:
- Skip `discoverTestFixture()` (force null)
- Go to agent path with same message: `使用 octo-workflow-test skill 测试 ${absPath}`
- The agent (octo-workflow-test skill) will regenerate/fix the fixture

## Acceptance Criteria

- [ ] `workflow test xzf-dev.yaml` with existing `.test.yaml` runs direct (<2s, no Server)
- [ ] Direct run output includes "Phase 1", "Phase 2", "Phase 3" headers
- [ ] Direct run failure shows `💡 Run with --fix` suggestion
- [ ] `workflow test xzf-dev.yaml --fix` goes to agent path even with fixture present
- [ ] `workflow test nonexistent.yaml` (no fixture) goes to agent path
- [ ] Agent path renders `tool_result` events with `→` prefix
- [ ] `simulate` command behavior unchanged
- [ ] `pnpm build` succeeds

## Verification Method

```bash
# Direct run (fixture exists)
time pnpm exec octopus workflow test packages/core-pack/workflows/xzf-dev.yaml

# Verify Phase headers in output
pnpm exec octopus workflow test packages/core-pack/workflows/xzf-dev.yaml 2>&1 | grep "Phase"

# simulate unchanged
pnpm exec octopus workflow simulate packages/core-pack/workflows/xzf-dev.yaml

pnpm build
```

# Verified Spec: Workflow Test 优化 — 直跑优先 + SSE 事件转发

**Feature**: `workflow-test-optimization`
**Branch**: `feat/workflow-simulator`
**Status**: Synthesized

## Summary

Optimize the `octopus workflow test` command to prefer direct simulator execution when a `.test.yaml` fixture exists (<2s, no Server dependency), falling back to agent delegation only when no fixture is found or `--fix` is used. Additionally, fix the Server delegation path to forward `tool_call` and `tool_result` SSE events (currently only forwards `text_delta` + `error`).

## Scope

### In Scope
1. **CLI `test` command restructure** — fixture detection → direct run vs agent delegation
2. **Enhanced direct-run output** — Phase headers (Syntax Check / Simulation / Assertions), failure suggestions with `--fix`
3. **`--fix` flag** — forces agent path for intelligent fixture repair
4. **Server SSE forwarding fix** — delegation path forwards `tool_call_start`, `tool_call`, `tool_result` events
5. **CLI SSE rendering** — agent path correctly renders tool call names/args and results

### Out of Scope
- Changes to `runTestSuite` API or simulator engine
- Changes to `simulate` command (must remain unchanged)
- Changes to `octo-workflow-test` skill content
- Web UI integration
- Engine package modifications

## Architecture

### Decision Tree

```
workflow test <yaml-path> [--fix]
  │
  ├─ --fix flag set?
  │   └─ YES → agent path (requires Server)
  │
  ├─ discoverTestFixture() returns path?
  │   └─ YES → direct run (runTestSuite, no Server)
  │
  └─ NO fixture
      └─ agent path (requires Server)
```

### Direct Run Path

```
CLI → loadWorkflow() + loadTestFixture() → runTestSuite() → renderDirectTestResult()
```

- No Server connection needed
- Expected <2s execution
- Enhanced output with Phase headers

### Agent Path

```
CLI → fetch(Server /api/agent/chat) → SSE stream → render agent events
```

- Server must be running
- Forwards to workspace clone via `delegate_to: "workspace"`
- SSE events now include: text_delta + tool_call + tool_result + error

## Detailed Design

### 1. CLI `test` Command Restructure (`packages/cli/src/commands/workflow.ts`)

**Current**: Always delegates to Server agent.

**New flow**:

```typescript
.action(async (yamlPath, options) => {
  // 1. Validate workflow file exists
  const absPath = resolve(yamlPath)
  if (!existsSync(absPath)) { error; exit(1) }

  // 2. Determine execution path
  const { discoverTestFixture } = await import("@octopus/engine")
  const fixturePath = options.fix ? null : discoverTestFixture(absPath)

  if (fixturePath) {
    // Direct run path
    await runDirectTest(absPath, fixturePath, yamlPath)
  } else {
    // Agent delegation path (existing, enhanced)
    await runAgentTest(absPath, yamlPath, options)
  }
})
```

### 2. Direct Run Implementation

New function `runDirectTest()`:

```typescript
async function runDirectTest(workflowPath: string, fixturePath: string, displayPath: string) {
  const { loadWorkflow, loadTestFixture, runTestSuite } = await import("@octopus/engine")

  // Load + run
  const workflow = loadWorkflow(workflowPath)
  const fixture = loadTestFixture(fixturePath)
  const result = await runTestSuite(workflow, fixture, { strict: true })

  // Render enhanced output
  renderDirectTestResult(result, displayPath)

  if (!result.passed) {
    console.log(chalk.yellow(`\n💡 Run with --fix to auto-fix via AI agent`))
    process.exit(1)
  }
}
```

### 3. Enhanced Output Rendering

New function `renderDirectTestResult()`:

Output format follows three phases:
- **Phase 1: Syntax Check** — iterates `syntaxErrors` per node, shows ✔/✖
- **Phase 2: Simulation** — iterates `executionTrace` per scenario, shows node status + mock info
- **Phase 3: Assertions** — iterates `assertionReport.results`, shows each assertion pass/fail

Footer: `Results: X passed, Y failed (N scenarios, Xms)`

### 4. `--fix` Flag

Added to commander options:
```typescript
.option("--fix", "强制走 agent 路径，智能修复/生成 fixture")
```

When set, skip fixture discovery and go directly to agent path. The agent prompt remains the same: `使用 octo-workflow-test skill 测试 ${absPath}`.

### 5. Server SSE Event Forwarding (`packages/server/src/routes/agent/main-agent-route.ts`)

**Current code** (delegation path, line ~198-213):
```typescript
for await (const chunk of runtime.chat(...)) {
  if (chunk.type === 'text_delta') { /* forward */ }
  else if (chunk.type === 'error') { /* forward */ }
}
```

**New code** — add `shouldForwardEvent()` helper and forward additional events:

```typescript
function shouldForwardEvent(type: string): boolean {
  return ['text_delta', 'tool_call_start', 'tool_call', 'tool_result', 'error'].includes(type)
}

for await (const chunk of runtime.chat(...)) {
  if (chunk.type === 'text_delta') { /* existing: accumulate + forward */ }
  else if (chunk.type === 'tool_call_start') {
    await stream.writeSSE({ event: 'tool_call', data: JSON.stringify({ type: 'start', tool_call_id: chunk.toolCallId, tool_name: chunk.toolName }) })
  }
  else if (chunk.type === 'tool_call') {
    await stream.writeSSE({ event: 'tool_call', data: JSON.stringify({ type: 'input', tool_call_id: chunk.toolCallId, tool_name: chunk.toolName, input: chunk.toolInput }) })
  }
  else if (chunk.type === 'tool_result') {
    await stream.writeSSE({ event: 'tool_result', data: JSON.stringify({ tool_call_id: chunk.toolCallId, tool_name: chunk.toolName, content: chunk.content, is_error: chunk.isError }) })
  }
  else if (chunk.type === 'error') { /* existing */ }
  // thinking, message_start, message_stop, etc → silently discard
}
```

**Important**: This applies to BOTH delegation locations in `main-agent-route.ts`:
1. The deterministic `delegate_to` path (line ~198-213) — the primary target
2. The `executeDelegation()` function (line ~730-740) — tool-based delegation

### 6. CLI SSE Event Rendering Enhancement

The existing test command already handles `tool_call` events in the SSE reader (line 528-531). After the Server fix, `tool_result` events will also arrive. Add rendering:

```typescript
if (currentEvent === "tool_result" && payload.tool_name) {
  const short = (payload.content || "").slice(0, 100)
  console.log(chalk.dim(`  → ${short}`))
}
```

## Files Changed

| Package | File | Change |
|---------|------|--------|
| cli | `src/commands/workflow.ts` | Restructure `test` command: add fixture detection, direct run, `--fix`, enhanced output rendering |
| server | `src/routes/agent/main-agent-route.ts` | Add tool_call/tool_result forwarding in both delegation paths |

## Verification

### Unit Tests
- `shouldForwardEvent()` — test each event type returns correct boolean

### Manual Tests
1. `octopus workflow test packages/core-pack/workflows/xzf-dev.yaml` → direct run, <2s, Phase headers
2. Same with missing fixture → agent path, tool events visible
3. Same with `--fix` → agent path even with fixture present
4. Same with intentionally broken fixture → failure output + `--fix` suggestion
5. `octopus workflow simulate packages/core-pack/workflows/xzf-dev.yaml` → unchanged output

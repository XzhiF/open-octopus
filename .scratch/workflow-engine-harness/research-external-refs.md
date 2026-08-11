# External Reference Research: Harness / Guardian Systems

> **Date**: 2026-08-06
> **Purpose**: Research how pi-mono and Mastra implement harness/guardian patterns to inform Octopus workflow engine harness design.
> **Sources**: `C:\MiYuan\github\pi-mono`, `C:\MiYuan\github\mastra`

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Pi (pi-mono) Architecture](#pi-pi-mono-architecture)
3. [Mastra Architecture](#mastra-architecture)
4. [Comparative Analysis](#comparative-analysis)
5. [Design Implications for Octopus](#design-implications-for-octopus)

---

## Executive Summary

### Key Findings

| Dimension | Pi (pi-mono) | Mastra |
|-----------|-------------|--------|
| **Guardian model** | Extension event system (lifecycle hooks) | Processor pipeline + TripWire exception |
| **Block vs Correct** | `ToolCallEventResult.block` + mutable `event.input` | `abort(reason, { retry })` throws TripWire |
| **Dedicated overseer agent** | No — `ServerSupervisor` is a process manager, not an AI agent | No — processors are deterministic code, not LLM agents |
| **Status after intervention** | `stop` / `error` / `aborted` (3 states) | `success` / `failed` / `tripwire` / `suspended` / `paused` / `bailed` (10+ states) |
| **Retry strategy** | Exponential backoff in `AgentSession._prepareRetry()` | `retryConfig: { attempts, delay }` + `StreamErrorRetryProcessor` |
| **Error classification** | `stopReason`: `stop` / `error` / `aborted` + `isRetryableError()` | `MastraNonRetryableError` vs retryable + TripWire as "soft abort" |

**Neither project uses a dedicated LLM-based "overseer" agent for correction.** Both rely on deterministic code-level guards. This is an important signal: the industry consensus is that guardian logic should be **programmatic and predictable**, not LLM-driven.

---

## Pi (pi-mono) Architecture

### 1. Extension Event System — The Core Guardian Mechanism

Pi uses a rich **event-based extension system** where extensions can hook into every phase of the agent lifecycle. This is the closest analog to a "harness" in pi-mono.

**File**: `packages/coding-agent/src/core/extensions/types.ts` (1713 lines)
**File**: `packages/coding-agent/src/core/extensions/runner.ts` (1237 lines)

#### Event Lifecycle (ordered by execution phase):

```
session_start → context → before_agent_start → agent_start →
  turn_start →
    before_provider_request → before_provider_headers → after_provider_response →
    message_start → message_update → message_end →
    tool_call → tool_execution_start → tool_execution_update → tool_execution_end →
    tool_result →
  turn_end →
agent_end → agent_settled
```

#### "Block and Stop" vs "Correct and Continue"

Pi provides **two distinct mechanisms** for each approach:

**Block pattern** — `ToolCallEventResult.block`:
```typescript
// types.ts:1071-1075
export interface ToolCallEventResult {
  /** Block tool execution. To modify arguments, mutate `event.input` in place instead. */
  block?: boolean;
  reason?: string;
}
```

**Correct pattern** — Mutable `event.input` + `ToolResultEventResult`:
```typescript
// types.ts:899-901 (tool_call event comment):
// `event.input` is mutable. Mutate it in place to patch tool arguments before execution.
// Later `tool_call` handlers see earlier mutations. No re-validation after mutation.

// types.ts:1085-1090 (tool_result event result):
export interface ToolResultEventResult {
  content?: (TextContent | ImageContent)[];
  details?: unknown;
  isError?: boolean;
  usage?: Usage;
}
```

**Key insight**: Pi separates "block" from "modify" at the type level. Extensions can:
1. **Block** a tool call entirely (`return { block: true, reason: "..." }`)
2. **Modify** tool arguments (mutate `event.input` in place)
3. **Modify** tool results (return new `content`/`isError` from `tool_result` handler)
4. **Modify** messages (return replacement `message` from `message_end` handler)
5. **Modify** the LLM payload (`before_provider_request` can replace the entire payload)
6. **Cancel** session operations (`session_before_switch`, `session_before_fork`, `session_before_compact` all support `cancel: true`)

#### Runner Error Isolation

The `ExtensionRunner` catches errors from individual extension handlers and reports them without crashing the main agent loop:

```typescript
// runner.ts:819-832
for (const handler of handlers) {
  try {
    const handlerResult = await handler(event, ctx);
    // ... process result
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    this.emitError({
      extensionPath: ext.path,
      event: event.type,
      error: message,
      stack: err instanceof Error ? err.stack : undefined,
    });
  }
}
```

This is critical: **extension failures never crash the agent**. They are reported to error listeners and the agent continues.

### 2. ServerSupervisor — Process Lifecycle Manager (Not an AI Agent)

**File**: `packages/server/src/legacy/supervisor.ts` (355 lines)

The `ServerSupervisor` class manages **process lifecycle**, not AI-level correction. It is a singleton that manages RPC process instances.

**Status model**:
```typescript
type InstanceStatus = "starting" | "online" | "stopping" | "stopped" | "error";
```

**Key patterns**:
- `handleUnexpectedRpcExit()` — detects process crash, sets status to `"error"`, cleans up bindings
- `recoverAfterRestart()` — marks any `online`/`starting` instances as `stopped` after server restart
- `failSpawn()` — cascading cleanup: error → cleanup resources → stopped → delete from live map → throw
- `spawnInstance()` — wraps creation in try/catch, calls `failSpawn()` on any error

**Relevant pattern for Octopus**: The supervisor maintains a `liveInstances` Map separate from persisted state. This separates runtime state from storage cleanly.

### 3. Agent Session Retry & Recovery

**File**: `packages/coding-agent/src/core/agent-session.ts`

#### Auto-Retry with Exponential Backoff

```typescript
// agent-session.ts:2679-2729
private async _prepareRetry(message: AssistantMessage): Promise<boolean> {
  const settings = this.settingsManager.getRetrySettings();
  if (!settings.enabled) return false;

  this._retryAttempt++;
  if (this._retryAttempt > settings.maxRetries) {
    this._retryAttempt--;
    return false;
  }

  const delayMs = settings.baseDelayMs * 2 ** (this._retryAttempt - 1);

  this._emit({
    type: "auto_retry_start",
    attempt: this._retryAttempt,
    maxAttempts: settings.maxRetries,
    delayMs,
    errorMessage: message.errorMessage || "Unknown error",
  });

  // Remove error message from agent state (keep in session for history)
  const messages = this.agent.state.messages;
  if (messages.length > 0 && messages[messages.length - 1].role === "assistant") {
    this.agent.state.messages = messages.slice(0, -1);
  }

  // Wait with exponential backoff (abortable)
  this._retryAbortController = new AbortController();
  try {
    await sleep(delayMs, this._retryAbortController.signal);
  } catch {
    // Aborted during sleep
    this._retryAttempt = 0;
    this._emit({ type: "auto_retry_end", success: false, attempt, finalError: "Retry cancelled" });
    return false;
  }
  return true;
}
```

#### Context Overflow Recovery (Correct and Continue)

```typescript
// agent-session.ts:1976-2010
// Case 1: Recoverable failure — context overflow or truncated output
if (sameModel && (isContextOverflow(assistantMessage, contextWindow) || recoverableLength)) {
  const willRetry = assistantMessage.stopReason !== "stop";

  if (!willRetry) {
    return await this._runAutoCompaction("overflow", false);
  }

  if (this._overflowRecoveryAttempted) {
    this._emit({
      type: "compaction_end",
      reason: "overflow",
      result: undefined,
      aborted: false,
      willRetry: false,
      errorMessage: "Context overflow recovery failed after one compact-and-retry attempt...",
    });
    return false;
  }

  this._overflowRecoveryAttempted = true;
  // Remove failed message from agent state (stays in session history)
  const messages = this.agent.state.messages;
  if (messages.length > 0 && messages[messages.length - 1].role === "assistant") {
    this.agent.state.messages = messages.slice(0, -1);
  }
  return await this._runAutoCompaction("overflow", willRetry);
}
```

#### Post-Agent-Run Pipeline

```typescript
// agent-session.ts:1068-1096
private async _handlePostAgentRun(): Promise<boolean> {
  const msg = this._lastAssistantMessage;
  this._lastAssistantMessage = undefined;
  if (!msg) return false;

  // 1. Try retry on retryable errors
  if (this._isRetryableError(msg) && (await this._prepareRetry(msg))) {
    return true;  // Continue agent loop
  }

  // 2. Emit retry failure event if retries were exhausted
  if (msg.stopReason === "error" && this._retryAttempt > 0) {
    this._emit({ type: "auto_retry_end", success: false, attempt: this._retryAttempt, finalError: msg.errorMessage });
    this._retryAttempt = 0;
  }

  // 3. Try compaction (overflow recovery or threshold)
  if (await this._checkCompaction(msg)) {
    return true;  // Continue agent loop after compaction
  }

  // 4. Check for queued messages from extension handlers
  return this.agent.hasQueuedMessages();
}
```

**Key insight**: The post-agent-run pipeline has a **priority cascade**: retry → compact → queued messages. Each returns `true` to continue the loop, or falls through to the next recovery strategy.

### 4. Pi's Intervention Model Summary

| Intervention Type | Mechanism | Can Continue? | Status After |
|---|---|---|---|
| Tool block | `ToolCallEventResult.block = true` | Yes (agent continues with blocked result) | `tool_result` with error |
| Tool arg modification | Mutate `event.input` | Yes (tool runs with modified args) | Normal `tool_result` |
| Tool result modification | `ToolResultEventResult` | Yes (agent sees modified result) | Modified `tool_result` |
| Message replacement | `MessageEndEventResult.message` | Yes (replaced message enters context) | Normal flow |
| Context overflow | Auto-compact + retry | Yes (one attempt) | Continues or `error` |
| Transient API error | Auto-retry with backoff | Yes (up to maxRetries) | Continues or `error` |
| Session cancel | `session_before_*` events | No (session operation cancelled) | Previous state |
| Process crash | `handleUnexpectedRpcExit()` | No | `error` → `stopped` |

---

## Mastra Architecture

### 1. Processor Pipeline — The Core Guardian Mechanism

Mastra's guardian system is built around **Processors** — code modules that intercept and transform the agent's input/output at multiple stages.

**File**: `packages/core/src/processors/index.ts` (890 lines)

#### Processor Interface (simplified):

```typescript
// processors/index.ts:560-730
export interface Processor<TId extends string = string, TTripwireMetadata = unknown> {
  readonly id: TId;
  readonly name?: string;

  // === INPUT PHASE ===
  processInput?(args: ProcessInputArgs): ProcessInputResult;       // Once at start
  processInputStep?(args: ProcessInputStepArgs): ProcessInputStepResult;  // Every agent step

  // === OUTPUT PHASE ===
  processOutputStream?(args: ProcessOutputStreamArgs): ChunkType | null | undefined;  // Stream chunks
  processOutputResult?(args: ProcessOutputResultArgs): ProcessorMessageResult;        // Final result
  processOutputStep?(args: ProcessOutputStepArgs): ProcessorMessageResult;            // Every step

  // === ERROR PHASE ===
  processAPIError?(args: ProcessAPIErrorArgs): ProcessAPIErrorResult | void;

  // === STATE ===
  computeStateSignal?(): ProcessorStateSignal;
}
```

#### Processor Context — The `abort()` TripWire Mechanism:

```typescript
// processors/index.ts:53-97
export interface ProcessorContext<TTripwireMetadata = unknown> {
  abort: (reason?: string, options?: TripWireOptions<TTripwireMetadata>) => never;
  retryCount: number;
  requestContext?: RequestContext;
  agent?: Agent;
  writer?: ProcessorStreamWriter;
  abortSignal?: AbortSignal;
}
```

### 2. TripWire — The "Soft Abort" Exception

**File**: `packages/core/src/agent/trip-wire.ts` (112 lines)

TripWire is a custom Error class that represents a **controlled abort** — the processor signals "stop processing" with optional retry semantics.

```typescript
// agent/trip-wire.ts:36-46
export class TripWire<TMetadata = unknown> extends Error {
  public readonly options: TripWireOptions<TMetadata>;
  public readonly processorId?: string;

  constructor(reason: string, options: TripWireOptions<TMetadata> = {}, processorId?: string) {
    super(reason);
    this.options = options;
    this.processorId = processorId;
  }
}

export interface TripWireOptions<TMetadata = unknown> {
  retry?: boolean;      // If true, agent retries with the reason as feedback
  metadata?: TMetadata;  // Structured info about what triggered the tripwire
}
```

**How TripWire flows through the system**:

1. Processor calls `ctx.abort("reason", { retry: true })` → throws `TripWire`
2. `DefaultExecutionEngine.executeStepWithRetry()` catches it
3. TripWire data is preserved on the `StepFailure`:
   ```typescript
   // default.ts:509-518
   tripwire: e instanceof TripWire ? {
     reason: e.message,
     retry: e.options?.retry,
     metadata: e.options?.metadata,
     processorId: e.processorId,
   } : undefined
   ```
4. `fmtReturnValue()` detects tripwire and sets `status: 'tripwire'`:
   ```typescript
   // default.ts:625-638
   if (tripwireData instanceof TripWire) {
     base.status = 'tripwire';
     base.tripwire = { reason, retry, metadata, processorId };
   }
   ```
5. Stream emits `tripwire` chunk type to clients

### 3. Workflow Run Status — Rich State Model

**File**: `packages/core/src/workflows/types.ts:282-293`

```typescript
export type WorkflowRunStatus =
  | 'running'
  | 'success'
  | 'failed'
  | 'tripwire'    // ← Unique to Mastra: processor-triggered abort
  | 'suspended'   // ← Step called suspend(), waiting for resume
  | 'waiting'
  | 'pending'
  | 'canceled'
  | 'bailed'      // ← Step called bail() with early result
  | 'paused'
  | 'skipped';
```

**Key insight**: Mastra distinguishes **10 terminal/intermediate states**. The `tripwire` status is distinct from `failed` — it means "a processor deliberately rejected this, not a bug." The `bailed` status means "a step chose to exit early with a result, not an error."

### 4. Step Result States

```typescript
// workflows/types.ts:73-173
type StepResult =
  | StepSuccess     // { status: 'success', output, ... }
  | StepFailure     // { status: 'failed', error, tripwire?, nonRetryable? }
  | StepSuspended   // { status: 'suspended', suspendPayload, ... }
  | StepRunning     // { status: 'running', ... }
  | StepWaiting     // { status: 'waiting', ... }
  | StepPaused      // { status: 'paused', ... }
  | StepSkipped     // { status: 'skipped', ... }
```

**StepFailure** carries tripwire metadata:
```typescript
type StepFailure = {
  status: 'failed';
  error: Error;
  tripwire?: StepTripwireInfo;   // Present when processor triggered tripwire
  nonRetryable?: true;           // Present when MastraNonRetryableError
  // ...
};

interface StepTripwireInfo {
  reason: string;
  retry?: boolean;
  metadata?: Record<string, unknown>;
  processorId?: string;
}
```

### 5. Workflow Retry Configuration

```typescript
// workflows/types.ts:1025-1028
retryConfig?: {
  attempts?: number;  // Max retry attempts
  delay?: number;     // Delay between retries in ms
};
```

Plus per-step retries: `step.retries ?? executionContext.retryConfig.attempts ?? 0`

#### `MastraNonRetryableError` — Opt Out of Retry:

```typescript
// default.ts:475-477
const isNonRetryable = e instanceof MastraNonRetryableError;
if (isNonRetryable || i === params.retries) {
  // Return failure immediately, skip remaining retries
}
```

### 6. Concrete Processor Implementations

#### `StreamErrorRetryProcessor` — Smart API Error Retry

**File**: `packages/core/src/processors/stream-error-retry-processor.ts` (352 lines)

```typescript
export class StreamErrorRetryProcessor implements Processor<'stream-error-retry-processor'> {
  constructor(options: {
    maxRetries?: number;           // Default: 1
    matchers?: StreamErrorRetryMatcherEntry[];
    retryUnknownErrors?: boolean;   // Default: false
    delayMs?: number | ((args) => number);
    maxRetryAfterMs?: number;       // Default: 30000
  }) {}

  async processAPIError(args: ProcessAPIErrorArgs): Promise<ProcessAPIErrorResult | void> {
    const matchedPolicy = findMatchingPolicy(error, this.#entries);
    if (!policy) return;  // Don't retry
    if (retryCount >= effectiveMaxRetries) return;

    // Calculate delay from config + Retry-After header
    const delayMs = Math.max(configuredDelayMs, providerDelayMs);
    await waitDelay(delayMs, abortSignal);

    return { retry: true };
  }
}
```

**Built-in matchers**:
- Retryable OpenAI error codes: `rate_limit`, `server_error`, `timeout`, `overloaded`, etc.
- Terminal authorization errors: `access_denied`, `authentication_error`, `forbidden` — **never retried**
- Provider `isRetryable` metadata
- Custom matcher functions with per-matcher retry/delay overrides

#### `TrailingAssistantGuard` — Input Correction Processor

**File**: `packages/core/src/processors/trailing-assistant-guard.ts` (82 lines)

A "correct and continue" pattern — detects a problematic message ordering and fixes it transparently:

```typescript
export class TrailingAssistantGuard implements Processor<'trailing-assistant-guard'> {
  processInputStep({ messages, structuredOutput }): ProcessInputStepResult | undefined {
    // Only applies when using native structured output with Claude 4.6
    const willUseResponseFormat = structuredOutput?.schema && !structuredOutput?.model;
    if (!willUseResponseFormat) return;

    const lastMessage = messages[messages.length - 1];
    if (!lastMessage || lastMessage.role !== 'assistant') return;

    // CORRECT: Append a user message to fix the ordering
    return {
      messages: [...messages, {
        id: randomUUID(), role: 'user',
        content: { format: 2, parts: [{ type: 'text', text: 'Generate the structured response.' }] },
      }],
    };
  }
}
```

#### `ToolResultReminderProcessor` — Context Enrichment

**File**: `packages/core/src/processors/tool-result-reminder.ts`

Injects AGENTS.md/CLAUDE.md content into context after tool calls — a "correct and continue" pattern for missing context.

### 7. ExecutionEngine — Abstract Retry & Lifecycle Hooks

**File**: `packages/core/src/workflows/execution-engine.ts` (170 lines)
**File**: `packages/core/src/workflows/default.ts` (670+ lines)

The `ExecutionEngine` provides overridable hooks:

```typescript
abstract class ExecutionEngine {
  // Retry logic — Inngest overrides to throw RetryAfterError
  async executeStepWithRetry<T>(stepId, runStep, params): Promise<Result<T>>;

  // Sleep — platform-specific
  async executeSleepDuration(duration, sleepId, workflowId): Promise<void>;

  // Lifecycle callbacks
  async onStepExecutionStart(params): Promise<number>;

  // Snapshot control
  shouldPersistSnapshot(params): boolean;
  pruneSnapshot?(params): WorkflowRunState;

  // Lifecycle
  onFinish?(result: WorkflowFinishCallbackResult): Promise<void>;
  onError?(errorInfo: WorkflowErrorCallbackInfo): Promise<void>;
}
```

**`lastPersistedStatusByRun` guard** prevents overwriting a `suspended`/`paused` snapshot with a stale `running` update:

```typescript
// default.ts:92-107
protected lastPersistedStatusByRun = new Map<string, WorkflowRunStatus>();
```

---

## Comparative Analysis

### 1. Block-and-Stop vs Correct-and-Continue

| Approach | Pi Mechanism | Mastra Mechanism |
|----------|-------------|-----------------|
| **Block and Stop** | `ToolCallEventResult.block = true` | `ctx.abort(reason)` throws TripWire → `status: 'tripwire'` |
| **Correct and Continue** | Mutate `event.input`, return modified `ToolResultEventResult` | Return modified messages from `processInputStep`/`processOutputStep` |
| **Cancel operation** | `session_before_*` returns `{ cancel: true }` | TripWire without `retry: true` |
| **Self-correction with retry** | Auto-retry in `_prepareRetry()` (transparent) | `ctx.abort(reason, { retry: true })` (explicit) |

**Key difference**: Pi's correction is **implicit** (mutate data, continue). Mastra's is **explicit** (throw exception, system handles retry). Pi's approach is more flexible but harder to reason about. Mastra's is more structured but less granular.

### 2. Severity Classification

| Severity Level | Pi Representation | Mastra Representation |
|---|---|---|
| **Informational** | Extension error listener (logged, ignored) | Processor warning (logged via `logger.warn`) |
| **Warning / Auto-correct** | Auto-compaction (threshold), message modification | `TrailingAssistantGuard` (transparent fix) |
| **Error / Retry** | `_prepareRetry()` with backoff | `StreamErrorRetryProcessor` → `{ retry: true }` |
| **Fatal / Abort** | `stopReason: "error"` (no more retries) | TripWire without retry, `MastraNonRetryableError` |
| **Process crash** | `handleUnexpectedRpcExit()` → `status: "error"` | N/A (no process management) |

### 3. Dedicated Overseer Agent?

**Neither project uses a dedicated LLM-based overseer agent.**

- **Pi's `ServerSupervisor`** is a process lifecycle manager, not an AI agent. It tracks `starting` → `online` → `stopping` → `stopped` / `error` states and handles RPC process cleanup.
- **Mastra's Processors** are deterministic TypeScript code, not LLM calls. They run inline in the agent's execution pipeline.

This is a strong signal that **production-grade guardian systems prefer deterministic code over LLM-based oversight** for safety-critical decisions.

### 4. Execution Status After Intervention

| Scenario | Pi Status | Mastra Status |
|---|---|---|
| Normal completion | `stop` (stopReason) | `success` |
| Tool blocked | Agent continues (tool returns error result) | `failed` with `tripwire` info |
| Auto-corrected | Transparent — no status change | `success` (correction invisible) |
| Retry succeeded | Continues (retry transparent to caller) | `success` |
| Retry exhausted | `error` (stopReason) | `failed` |
| Non-retryable error | `error` (stopReason) | `failed` with `nonRetryable: true` |
| Processor abort (no retry) | N/A | `tripwire` |
| Processor abort (with retry) | N/A | Retries, then `success` or `tripwire` |
| Suspended (human-in-the-loop) | N/A | `suspended` |
| Early exit with result | N/A | `bailed` |
| Process crash | `error` → `stopped` | N/A |

### 5. Error Recovery Strategies Compared

| Strategy | Pi | Mastra |
|---|---|---|
| **Exponential backoff** | ✅ `baseDelayMs * 2^(attempt-1)` | ❌ Fixed delay only |
| **Abortable retry** | ✅ `AbortController` on retry sleep | ✅ `abortSignal` passed to processors |
| **Retry-After header** | ❌ Not handled | ✅ Parsed from HTTP headers, capped at `maxRetryAfterMs` |
| **Context overflow recovery** | ✅ Compact + retry (once) | ❌ No equivalent |
| **Non-retryable marker** | ❌ All errors retryable if settings say so | ✅ `MastraNonRetryableError` |
| **Error cause chain walking** | ❌ | ✅ `findMatchingPolicy()` walks `.cause` chain |
| **Terminal error classification** | `_isRetryableError()` | `isKnownTerminalAuthorizationError()` |

---

## Design Implications for Octopus

### 1. Adopt a TripWire-Like "Soft Abort" Pattern

Mastra's TripWire is the most elegant pattern found. For Octopus:

```typescript
// Proposed: packages/engine/src/harness/trip-wire.ts
export class TripWire extends Error {
  constructor(
    public readonly reason: string,
    public readonly options: {
      severity: 'warning' | 'error' | 'fatal';
      retry?: boolean;
      correctAndContinue?: boolean;
      metadata?: Record<string, unknown>;
    },
    public readonly sourceId?: string  // Which harness rule triggered this
  ) {
    super(reason);
  }
}
```

**Severity mapping**:
- `warning` → Log and continue (like `TrailingAssistantGuard`)
- `error` → Retry with feedback (like TripWire with `retry: true`)
- `fatal` → Abort execution, mark as `failed` (like TripWire without retry)

### 2. Add a "Correct and Continue" Hook to Each Executor

Following Pi's mutable `event.input` pattern, each executor should have pre/post hooks:

```typescript
// Proposed: packages/engine/src/harness/hooks.ts
export interface ExecutorHooks {
  beforeExecute?(ctx: ExecutionContext): Promise<ExecutionContext>;   // Modify context
  afterExecute?(result: StepResult): Promise<StepResult>;           // Modify result
  onError?(error: Error, ctx: ExecutionContext): Promise<'retry' | 'skip' | 'abort' | StepResult>;
}
```

### 3. Expand Execution Status Model

Current Octopus statuses are too few. Adopt Mastra's richer model:

```typescript
// Current Octopus: running | completed | failed | waiting_approval
// Proposed:
type ExecutionStatus =
  | 'pending'
  | 'running'
  | 'completed'     // Success
  | 'failed'        // Unrecoverable error
  | 'tripwire'      // Harness rule rejected this
  | 'suspended'     // Waiting for external input / human
  | 'retrying'      // Auto-retry in progress
  | 'skipped'       // Condition not met
  | 'bailed'        // Early exit with partial result
  | 'canceled';      // User/system canceled
```

### 4. Implement a Deterministic Harness Rule Engine (Not LLM-Based)

Both projects confirm: **guardian logic must be deterministic code, not LLM agents.**

```typescript
// Proposed: packages/engine/src/harness/rule.ts
export interface HarnessRule {
  id: string;
  name: string;
  phase: 'before_node' | 'after_node' | 'on_error' | 'on_timeout';

  // Evaluation — pure function, no LLM
  evaluate(ctx: HarnessContext): HarnessDecision;
}

export type HarnessDecision =
  | { action: 'allow' }
  | { action: 'block'; reason: string }
  | { action: 'modify'; patches: Record<string, unknown>; reason: string }
  | { action: 'retry'; delayMs?: number; reason: string }
  | { action: 'tripwire'; severity: 'warning' | 'error' | 'fatal'; reason: string };
```

### 5. Retry Strategy: Combine Pi's Backoff with Mastra's Error Classification

```typescript
// Proposed: packages/engine/src/harness/retry.ts
export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;  // Pi-style: delay * multiplier^(attempt-1)

  // Mastra-style: error classification
  retryableErrors?: Array<(error: Error) => boolean>;
  nonRetryableErrors?: Array<(error: Error) => boolean>;

  // Mastra-style: Retry-After header support
  respectRetryAfterHeader?: boolean;
  maxRetryAfterMs?: number;
}
```

### 6. Last-Persisted-Status Guard

Adopt Mastra's `lastPersistedStatusByRun` pattern to prevent status clobbering during concurrent updates:

```typescript
// Prevent: running → suspended → running (stale write overwrites suspension)
private lastPersistedStatus = new Map<string, ExecutionStatus>();

shouldPersistStatus(runId: string, newStatus: ExecutionStatus): boolean {
  const last = this.lastPersistedStatus.get(runId);
  if (last === 'suspended' && newStatus === 'running') return false;
  if (last === 'completed' && newStatus === 'running') return false;
  return true;
}
```

### 7. Extension Error Isolation (Pi Pattern)

Harness rule errors must never crash the workflow engine:

```typescript
// Run each rule in try/catch, report errors, continue execution
for (const rule of rules) {
  try {
    const decision = rule.evaluate(ctx);
    if (decision.action === 'block') return decision;
  } catch (err) {
    this.emitHarnessError(rule, err);
    // Continue — don't let rule bugs crash the engine
  }
}
```

---

## Appendix: Key File References

### Pi (pi-mono)
| File | Purpose |
|------|---------|
| `packages/coding-agent/src/core/extensions/types.ts` | Extension event types (1713 lines) — full lifecycle hook API |
| `packages/coding-agent/src/core/extensions/runner.ts` | Extension runner (1237 lines) — event dispatch, error isolation |
| `packages/coding-agent/src/core/agent-session.ts` | Agent session (2700+ lines) — retry, compaction, overflow recovery |
| `packages/server/src/legacy/supervisor.ts` | Process supervisor (355 lines) — lifecycle management |
| `packages/evals/src/pi-harness.ts` | Eval harness (258 lines) — test isolation pattern |

### Mastra
| File | Purpose |
|------|---------|
| `packages/core/src/processors/index.ts` | Processor interface (890 lines) — full guardian API |
| `packages/core/src/agent/trip-wire.ts` | TripWire class (112 lines) — soft abort with retry |
| `packages/core/src/workflows/types.ts` | Workflow types — 10 status states, step result types |
| `packages/core/src/workflows/default.ts` | DefaultExecutionEngine (670+ lines) — retry, tripwire handling |
| `packages/core/src/workflows/execution-engine.ts` | Abstract engine (170 lines) — overridable hooks |
| `packages/core/src/processors/stream-error-retry-processor.ts` | Smart retry (352 lines) — error classification, Retry-After |
| `packages/core/src/processors/trailing-assistant-guard.ts` | Input correction (82 lines) — correct-and-continue |
| `packages/core/src/processors/tool-result-reminder.ts` | Context enrichment — correct-and-continue |

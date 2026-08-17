# 13 — fix: Pi SDK session resume path（findSession 返 AgentSession 非 SessionManager）

## What to build
修 pre-existing latent bug（SPIKE S2 发现）：`packages/providers/src/pi/pi-sdk-adapter.ts:310 findSession` 返回 `SessionManager`（文件句柄）而非 `AgentSession`。resumed clone chat turn 2+ 时 `session.subscribe`/`session.prompt`（`provider.ts:284,298`）抛 TypeError 或 fall-through 到 fresh session（失历史）。修法（per SPIKE S2 Mechanism A 注）：重建 `AgentSession`——`createAgentSession` 传 `options.sessionManager = SessionManager.open(...)`，使 AgentSession 带 extensions（octopus-hooks）+ resumed 状态重建。把 `session-resume.test.ts` 改用**真实（非 mock）factory** 以捕获类型不匹配。

## Blocked by
None（providers 包，独立于 v2 tasks 域；与 01 同 Stage 0 并发，不同包无冲突）。

## Status
done (ticket 13, Stage 0)

## Verification Summary

### Files changed (providers-internal only)
- `packages/providers/src/pi/pi-sdk-adapter.ts` — added `sessionManager?` to `SessionOptions`; threaded into `createAgentSession`; refactored `findSession(cwd, id, opts?)` to open `SessionManager.open(match.path)` then route through `createSession({...opts, sessionManager})` so it returns an `AgentSession` (subscribe/prompt/abort/dispose) carrying resumed state.
- `packages/providers/src/pi/provider.ts` — `PiAgentProvider` SessionCache factory now passes the full `SessionOptions` (extensions/systemPrompt/customTools/skills/customProviders/filteredEnv/cwd) into `PiSdk.findSession(...)` so the reconstructed AgentSession matches a fresh session's wiring.
- `packages/providers/src/__tests__/pi/session-resume.test.ts` — replaced mock-only resume coverage with REAL `createSession`/`findSession` calls that catch the SessionManager-vs-AgentSession type mismatch; kept the original TC-038/TC-039 SessionCache mock tests (different seam).

### AC results
- AC1: `findSession` returns a usable `AgentSession` (subscribe/prompt/abort/dispose verified as functions), not a bare `SessionManager`. PASS.
- AC2: 2-turn resume — `session.subscribe(cb)` returns an unsub function (no TypeError), `session.prompt` is a function, and `session.agent.state.messages` contains the turn-1 assistant reply (history preserved). PASS.
- AC3: `session-resume.test.ts` uses a REAL factory (no mocks) for the resume path and asserts AgentSession methods exist — the exact test that was red before the fix (`TypeError: session.subscribe is not a function`) is now green. PASS.
- AC4: workspace clone chat resume does not regress — full providers suite shows 11 pre-existing failures (identical to baseline with changes stashed; all in unrelated files: connectivity/faux-provider/sub-agent-tool/system-prompt/session-cache mock tests) and 0 new failures. PASS.

### Test run
`pnpm vitest run src/__tests__/pi/session-resume.test.ts` → 5/5 PASS.
Full `pnpm vitest run` (providers) → 141 passed | 11 failed (all pre-existing, unchanged from baseline). `pnpm build` → success. `tsc --noEmit` → no errors in touched files.

## Exploration

### Analog studied
The closest existing feature is the **fresh session creation path** in the same file: `createSession()` (pi-sdk-adapter.ts:50-119). A resumed session must go through the same machinery so the returned object is identical in shape (an `AgentSession`, not a bare `SessionManager`).

### Bug confirmation (SDK type trace)
- `pi.SessionManager.open(path)` returns a `SessionManager` (session-manager.d.ts:166-331). `SessionManager` has NO `subscribe`/`prompt`/`abort`/`dispose` methods — only `appendMessage`/`buildSessionContext`/`getEntries`/etc.
- `pi.createAgentSession(options)` (sdk.d.ts:108, sdk.js:63-266) returns `{ session: AgentSession, extensionsResult, ... }` where `AgentSession` (agent-session.d.ts:163-607) HAS public `subscribe`/`prompt`/`abort`/`dispose`.
- `createAgentSession` reads `options.sessionManager` (sdk.js:73): `const sessionManager = options.sessionManager ?? SessionManager.create(...)`. So passing a pre-opened `SessionManager` makes the new `AgentSession` adopt the resumed state — exactly the SPIKE S2 Mechanism A fix.
- `createAgentSession` does NOT read `options.extensions` or `options.systemPrompt` (only `customTools`, `sessionManager`, `resourceLoader`, `modelRegistry`, etc.). The adapter passes `extensions`/`systemPrompt` via `as any` cast; `systemPrompt` is applied via the `resourceLoader.getSystemPrompt` override hack (pi-sdk-adapter.ts:99-112). Extensions come from `resourceLoader.getExtensions()` (sdk.js:260), and `noExtensions: true` is set in the adapter's DefaultResourceLoader — so the `octopus-hooks` `beforeToolCall` is a no-op in current code (pre-existing, OUT OF SCOPE for ticket 13). The resumed session routed through `createSession` inherits identical extension behavior to a fresh session → no AC4 regression.

### Files needing modification
1. `packages/providers/src/pi/pi-sdk-adapter.ts` — add `sessionManager?: any` to `SessionOptions`; thread it into `createAgentSession` options; refactor `findSession(cwd, id, opts?)` to open `SessionManager` then call `createSession({...opts, cwd, sessionManager})` so it returns an `AgentSession` with the resumed state + same extensions/systemPrompt/customTools wiring as a fresh session.
2. `packages/providers/src/pi/provider.ts` — pass the full `SessionOptions` (extensions, customTools, systemPrompt, skills, filteredEnv, customProviders, cwd) into `PiSdk.findSession(...)` so the reconstructed `AgentSession` matches a fresh session's wiring.
3. `packages/providers/src/__tests__/pi/session-resume.test.ts` — replace the mock-only factory with REAL `createSession`/`findSession` calls; assert `subscribe`/`prompt`/`abort`/`dispose` are functions on the resumed session (catches the SessionManager vs AgentSession type mismatch). Keep the existing SessionCache mock tests (different concern: caching).

### Specific functions chosen
- Use `pi.SessionManager.list(cwd)` + `pi.SessionManager.open(match.path)` to locate + open the resumed session file (unchanged from current `findSession`).
- Use `createSession({...opts, sessionManager})` (NOT calling `createAgentSession` directly) to rebuild the `AgentSession` — this reuses the existing model-registry/resource-loader/systemPrompt-override wiring and guarantees shape parity with fresh sessions.
- `subscribeEvents`/`promptSession`/`abortSession`/`disposeSession` (pi-sdk-adapter.ts:279-308) are unchanged — they now receive a real `AgentSession` and work correctly.



## Acceptance Criteria
- [ ] AC1: `findSession` 返回可用 `AgentSession`（有 subscribe/prompt/abort/dispose），非 bare `SessionManager`
- [ ] AC2: resumed clone chat turn 2+ 工作（无 TypeError，历史保留）
- [ ] AC3: `session-resume.test.ts` 用真实 factory（非 mock）+ 断言 resume 后 AgentSession 方法存在
- [ ] AC4: workspace clone chat resume（现有）不回归

## Verification Method
**unit + integration**：`session-resume.test.ts`（真实 factory）PASS；mock 2-turn clone chat → turn 2 resume → 无 TypeError + 历史在。Pass: AC1-4。

## Note
- 这是 pre-existing bug，非 v2 引入。v2 task-author 经 fresh-session（Mechanism B, ticket 07）绕开；但所有用 resume 的 clone chat（workspace clone 等）受影响。
- 修此 bug 也为未来 Mechanism A（`before_agent_start` hook per-turn 注入）扫除障碍。
- 同文件 pi-sdk-adapter.ts：ticket 07（getSystemPrompt 闭包）在 Stage 4，13 在 Stage 0，序避冲突（07 加 blocked-by 13）。

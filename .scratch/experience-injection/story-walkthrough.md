# Story Walk-Through: Experience Injection (ContextEnricher)

> Generated 2026-08-11 from `spec.md` + live codebase trace.
> No code was modified. This is a read-only analysis.

---

## Executive Summary

**The entire feature is unbuilt.** `ContextEnricher` does not exist anywhere in the codebase — not as a file, class, interface, or import. Every story in the spec depends on this missing service. Beyond that, the spec contains several assumptions about existing code that are factually wrong (e.g., `searchByScope` signature, `HarnessPromptAdapter` wiring, API endpoint existence, user message availability). This walkthrough identifies **23 break points** across 4 stories + cross-cutting concerns.

| Severity | Count |
|----------|-------|
| CRITICAL | 6 |
| HIGH     | 10 |
| MEDIUM   | 7 |

---

## Story 1: Main Agent 经验注入

### Spec Trace

```
[UI] 用户发送: "上次部署失败是怎么解决的？"
[API] POST /api/agent/chat
[Exec] SystemPromptAssembler.assemble()
[Exec]   → buildExperienceSegment() 检测到关键词 "上次" + "失败"
[Exec]   → ContextEnricher.enrich({scope:'agent', query:'部署失败', budget:1200})
[Data]   → EvolutionDAO.searchByScope('部署失败', ['agent','global'], 5)
[Data]   → 返回 2 条相关经验
[Exec]   → 格式化为 markdown segment (P3.5)
[Exec] System prompt 包含经验段 → LLM 生成回答时参考历史
```

### Actual Codebase Trace

| Step | Spec Says | Codebase Reality | File:Line |
|------|-----------|-----------------|-----------|
| API entry | `POST /api/agent/chat` | `POST /sessions/:id/chat` | `chat-routes.ts:33` |
| Prompt assembly | `SystemPromptAssembler.assemble()` | ✅ Correct — `new SystemPromptAssembler(org).assemble()` | `chat-routes.ts:85-86` |
| Experience segment | `buildExperienceSegment()` | ❌ **Does not exist** — `getSegments()` builds 7 segments, none for experience | `system-prompt-assembler.ts:195-227` |
| ContextEnricher | `enrich()` call | ❌ **Does not exist** — zero references in entire codebase | (grep confirms) |
| DAO search | `searchByScope('部署失败', ['agent','global'], 5)` | ❌ **Signature mismatch** — actual signature is `searchByScope(query, scope?: string, limit)` — takes a **single** optional string, not an array | `evolution-dao.ts:226-279` |
| P3.5 segment | Priority 3.5 between memory(3) and context(4) | ⚠️ `priority: number` type supports 3.5, but `PromptSegment.source` union lacks `'experience'` | `system-prompt-assembler.ts:13` |
| Truncation | Experience-specific degradation (5→3→1) | ❌ `applyDegradationRule()` has no `case 'experience'` — falls to `default` (no-op) | `system-prompt-assembler.ts:525-625` |

### Break Points

#### BP-1.1 — CRITICAL: `buildExperienceSegment()` does not exist

`SystemPromptAssembler.getSegments()` builds these segments:
1. `buildCoreSegment()` — P0
2. `buildPersonaSegment()` — P1
3. `buildMemorySegment()` — P3
4. `buildDailyMemorySegment()` — P3
5. `buildSkillsSegment()` — P2
6. `buildContextSegment()` — P4
7. `buildCloneSegment()` — P5 (conditional)
8. `buildScheduledSegment()` — P6 (conditional)

No experience segment builder exists. The entire injection point is missing.

**Fix**: Add `buildExperienceSegment()` method that:
1. Accepts the last user message as input
2. Runs keyword detection (regex match)
3. If triggered, calls `ContextEnricher.enrich({scope:'agent', query, budget:1200})`
4. Returns a `PromptSegment` with `priority: 3.5` and `source: 'experience'`

#### BP-1.2 — CRITICAL: `ContextEnricher` service does not exist

Zero references in the codebase. The spec treats it as a new service to create in `packages/server`, but nothing has been scaffolded.

**Fix**: Create `packages/server/src/services/agent/context-enricher.ts` with:
- `ContextEnricher` class implementing the `enrich()` method
- Keyword detection regex
- Scope-based search delegation to `EvolutionDAO`
- Markdown formatting logic
- Token budget management

#### BP-1.3 — HIGH: `searchByScope` signature mismatch

**Spec assumes**: `searchByScope('部署失败', ['agent','global'], 5)` — array of scopes  
**Actual signature**: `searchByScope(query: string, scope?: string, limit: number = 10)` — single optional string

The current SQL uses `WHERE e.scope = ?` (single equality). To support `['agent', 'global']`, the DAO needs:
- Either a new method `searchByScopes(query, scopes: string[], limit)`
- Or modify `searchByScope` to accept `string | string[]`

**Fix**: Add a `searchByScopes()` method to `EvolutionDAO`:
```typescript
searchByScopes(query: string, scopes: string[], limit: number = 10): ...
// SQL: WHERE e.scope IN (?, ?) with dynamic parameter binding
```

#### BP-1.4 — HIGH: No keyword detection logic

The spec lists trigger keywords (之前, 上次, 历史, 经验, error, failed, bug, fix, remember, last time) but no regex or detection code exists anywhere.

**Fix**: Implement as part of `ContextEnricher`:
```typescript
private static TRIGGER_PATTERN = /之前|上次|历史|经验|怎么解决|遇到过|error|failed|bug|fix|remember|last time/i
shouldSearch(message: string): boolean { return TRIGGER_PATTERN.test(message) }
```

#### BP-1.5 — CRITICAL: User message is NOT passed to SystemPromptAssembler

Both chat routes call `assembler.assemble()` **without the user's message text**:

- `main-agent-route.ts:298-299`: `assembler.assemble()` — no options at all
- `chat-routes.ts:86`: `assembler.assemble({ clone_name: session.clone_name ?? undefined })` — only clone_name

The `AssembleOptions` interface has no field for `user_message` or `query`. Even if `buildExperienceSegment()` existed, it would have **no input** to run keyword detection against.

**Fix**: 
1. Add `user_message?: string` to `AssembleOptions`
2. Both chat routes must pass `body.message` to the assembler:
```typescript
assembler.assemble({ clone_name: session.clone_name ?? undefined, user_message: body.message })
```
3. `buildExperienceSegment()` reads `options.user_message` for keyword detection

#### BP-1.6 — MEDIUM: `PromptSegment.source` type lacks `'experience'`

Current union: `'core' | 'persona' | 'daily_memory' | 'memory' | 'skills' | 'context' | 'scheduled' | 'clone'`

Adding an experience segment requires extending this type. Without it, TypeScript compilation fails.

**Fix**: Add `'experience'` to the `PromptSegment.source` union type.

---

## Story 2: Harness Agent FTS5 + Daily Memory

### Spec Trace

```
[Exec] 工作流节点失败 → 检测器触发
[Exec] AgentDelegationService.delegate()
[Exec]   → HarnessPromptAdapter.assemble()
[Exec]   → loadPersona() → persona.md
[Exec]   → loadLongTermMemory() → long-term.md
[Exec]   → ★ loadDailyMemory() → daily/YYYY-MM-DD.md (新增)
[Exec]   → ★ ContextEnricher.enrich({scope:'harness', query:'syntax_error', alwaysOn:true})
[Data]   → searchByScope('syntax_error', ['harness','global'], 5)
[Data]   → 返回 3 条历史案例
[Exec]   → getSuccessStats() → 成功率数据
[Exec]   → 完整 prompt: persona + memory + daily + 历史案例 + 成功率 + 诊断报告
```

### Actual Codebase Trace

| Step | Spec Says | Codebase Reality | File:Line |
|------|-----------|-----------------|-----------|
| Delegation entry | `AgentDelegationService.delegate()` | ✅ Correct | `agent-delegation.ts:538` |
| Prompt assembly | `HarnessPromptAdapter.assemble()` | ❌ **Wrong integration point** — `AgentDelegationService.buildPromptWithHistory()` builds prompts directly, never calls `HarnessPromptAdapter` | `agent-delegation.ts:652-694` |
| Persona loading | `loadPersona()` | ✅ Exists in `HarnessPromptAdapter` but ❌ NOT called by delegation flow | `prompt-assembler.ts:177-189` |
| Long-term memory | `loadLongTermMemory()` | ✅ Exists in `HarnessPromptAdapter` but ❌ NOT called by delegation flow | `prompt-assembler.ts:194-207` |
| Daily memory | `loadDailyMemory()` (NEW) | ❌ Does not exist in `HarnessPromptAdapter` | — |
| Experience search | `ContextEnricher.enrich()` | ❌ Does not exist | — |
| Success stats | `getSuccessStats()` | ✅ `buildStatsSectionForReport()` calls `evolutionDao.getSuccessStats()` | `agent-delegation.ts:702-715` |

### The Wiring Problem (CRITICAL)

The spec assumes this call chain:
```
AgentDelegationService.delegate()
  → HarnessPromptAdapter.assemble()   ← this is NOT what happens
    → loadPersona()
    → loadLongTermMemory()
    → loadDailyMemory()
    → ContextEnricher.enrich()
```

The actual call chain is:
```
AgentDelegationService.delegate()
  → buildPromptWithHistory(report, context)   ← direct prompt building
    → buildDelegationPrompt(report, context)  ← free function
    → buildStatsSectionForReport(report)      ← stats injection
  → executeCall(prompt, ...)
```

`HarnessPromptAdapter` is defined in `prompt-assembler.ts` (line 137-222) and is only used by `UnifiedPromptAssembler` when `type === 'harness'`. But `AgentDelegationService` constructs prompts independently — it never creates or calls a `HarnessPromptAdapter`.

This means:
1. Even though `HarnessPromptAdapter` has `loadPersona()` and `loadLongTermMemory()`, **these are never called in the delegation flow**
2. Adding `loadDailyMemory()` to `HarnessPromptAdapter` won't help — the delegation service doesn't use it
3. The persona and long-term memory are NOT currently part of the harness delegation prompt

### Break Points

#### BP-2.1 — CRITICAL: AgentDelegationService does not use HarnessPromptAdapter

The spec's integration strategy (add experience + daily memory to `HarnessPromptAdapter.assemble()`) will have zero effect because `AgentDelegationService` builds prompts via `buildPromptWithHistory()`, not through the adapter.

**Fix**: Two options:
- **Option A** (recommended): Wire `HarnessPromptAdapter` into `AgentDelegationService.buildPromptWithHistory()`. Call the adapter to get persona + memory + daily + experience, then prepend to the delegation prompt.
- **Option B**: Add daily memory + experience loading directly in `buildPromptWithHistory()`, bypassing the adapter.

#### BP-2.2 — CRITICAL: `loadDailyMemory()` does not exist in HarnessPromptAdapter

The adapter has `loadPersona()` and `loadLongTermMemory()` but no `loadDailyMemory()`.

**Fix**: Add `loadDailyMemory()` to `HarnessPromptAdapter`:
```typescript
loadDailyMemory(): string {
  const cloneDir = this.resolveCloneDir()
  if (!cloneDir) return ''
  const dailyDir = path.join(cloneDir, 'memory', 'daily')
  const today = new Date().toISOString().slice(0, 10)
  const todayFile = path.join(dailyDir, `${today}.md`)
  if (!fs.existsSync(todayFile)) return ''
  try { return `# 每日记忆\n\n${fs.readFileSync(todayFile, 'utf-8')}` }
  catch { return '' }
}
```

#### BP-2.3 — HIGH: No daily memory writer for harness-agent

Even if `loadDailyMemory()` is implemented, the daily file `~/.octopus/agent/built-in/harness-agent/memory/daily/YYYY-MM-DD.md` is never created. The harness delegation flow records events to `harness_events` table but never writes to the daily memory file system.

**Fix**: Add a daily memory writer that appends a summary after each delegation:
```typescript
// After successful delegation, append to daily memory
private appendDailyMemory(report: DiagnosisReport, result: DelegationResult): void {
  const today = new Date().toISOString().slice(0, 10)
  const filePath = path.join(dailyDir, `${today}.md`)
  const entry = `### ${new Date().toTimeString().slice(0,8)} ${report.detector}\n- 决策: ${result.decision}\n- 节点: ${report.nodeId}\n`
  fs.appendFileSync(filePath, entry)
}
```

#### BP-2.4 — HIGH: No experience search in delegation flow

Neither `AgentDelegationService` nor `HarnessPromptAdapter` calls any experience search. The `buildStatsSectionForReport()` provides aggregate statistics but not individual historical cases.

**Fix**: After BP-2.1 is resolved, add `ContextEnricher.enrich({scope:'harness', query: report.pattern, alwaysOn: true})` call in the prompt building chain.

#### BP-2.5 — MEDIUM: Hardcoded org in stats lookup

`buildStatsSectionForReport()` uses `org = "default"` (line 708). If the harness runs under a different org, stats will be wrong.

**Fix**: Pass `org` through `AgentDelegationServiceDeps` or `DelegationContext`.

---

## Story 3: Workflow Agent Node 经验注入

### Spec Trace

```
[Exec] 工作流 agent 节点开始执行
[Exec] AgentExecutor.buildPrompt()
[Exec]   → KnowledgeInjector.getInjectedPrompts() → 知识规则
[Exec]   → ★ ContextEnricher.enrich({scope:'workflow', query:nodePrompt, alwaysOn:true})
[Data]   → searchByScope(query, ['workflow','global'], 5)
[Data]   → 返回相关经验
[Exec]   → prompt = 知识规则 + 经验 + 原始 prompt
```

### Actual Codebase Trace

| Step | Spec Says | Codebase Reality | File:Line |
|------|-----------|-----------------|-----------|
| Entry | `AgentExecutor.buildPrompt()` | ✅ Exists | `agent.ts:318-357` |
| Knowledge injection | `KnowledgeInjector.getInjectedPrompts()` | ✅ Exists, called at line 339 | `agent.ts:339-343` |
| Experience injection | `ContextEnricher.enrich()` after knowledge | ❌ Does not exist | — |
| Goal mode | Not mentioned in spec | ❌ `buildGoalPrompt()` does NOT call `knowledgeInjector` — knowledge is only injected in standard mode | `agent.ts:360-433` |

### Break Points

#### BP-3.1 — CRITICAL: No experience injection in AgentExecutor

`buildPrompt()` calls `promptInjector.getInjectedPrompts()` and `knowledgeInjector.getInjectedPrompts()` but has no experience enrichment call.

**Fix**: Add after knowledge injection:
```typescript
// After knowledge injection
if (this.contextEnricher) {
  const enrichResult = this.contextEnricher.enrich({
    scope: 'workflow',
    query: prompt.slice(0, 200), // use prompt excerpt as query
    org: this.org ?? 'default',
    budget: 1200,
    alwaysOn: true,
  })
  if (enrichResult.segment) {
    prompt = enrichResult.segment + '\n\n---\n\n' + prompt
  }
}
```

#### BP-3.2 — HIGH: Cross-package dependency — engine cannot call server

`AgentExecutor` lives in `packages/engine/`. `ContextEnricher` would live in `packages/server/` (per spec section A). The `engine` package has no dependency on `server` — the dependency arrow is `server → engine`, not the reverse.

This is an **architectural constraint** the spec doesn't address.

**Fix**: Two options:
- **Option A**: Define `ContextEnricher` as an interface in `@octopus/shared` and implement it in `server`. Pass it to `AgentExecutor` via `AgentConfig` (dependency injection).
- **Option B**: Implement `ContextEnricher` in the `engine` package directly, giving it a DAO interface for injection.

The spec needs to explicitly decide this.

#### BP-3.3 — HIGH: Goal-mode agents skip knowledge injection entirely

`buildGoalPrompt()` (line 360) never calls `knowledgeInjector.getInjectedPrompts()`. If experience injection is added only to `buildPrompt()` (standard mode), goal-mode agents get neither knowledge nor experience.

**Fix**: Add knowledge + experience injection to `buildGoalPrompt()` as well.

#### BP-3.4 — MEDIUM: `workflow` scope experiences may not exist

The experiences table defaults `scope` to `'agent'` (schema.ts:173). Current writers (`create_experience` tool, harness reflection) may all write with `scope='agent'` or `scope='harness'`. If no writer creates `scope='workflow'` records, the workflow search returns empty.

**Fix**: Verify that the experience recording pipeline writes workflow-scoped experiences. Check `source_type` and `scope` values in the `insertExperienceV2()` callers.

---

## Story 4: 智能触发 — 不需要时不注入

### Spec Trace

```
[UI] 用户发送: "帮我创建一个新文件"
[API] POST /api/agent/chat
[Exec] SystemPromptAssembler.assemble()
[Exec]   → buildExperienceSegment() 检测关键词 → 无匹配
[Exec]   → segment = null（不搜索，不注入）
[Exec] System prompt 无经验段 → 节省 token
```

### Break Points

#### BP-4.1 — HIGH: Entire trigger mechanism is unbuilt

The keyword detection regex, the `alwaysOn` flag logic, and the conditional search — none of it exists. This is part of the missing `ContextEnricher` service.

**Fix**: Implement as part of `ContextEnricher` (see BP-1.2).

#### BP-4.2 — MEDIUM: `alwaysOn` semantics are contradictory in the spec

The spec says:
- Harness/workflow: `alwaysOn: true` → **skip** trigger detection, always search
- Chat: keyword detection → if matched, set `alwaysOn: true`

But if `alwaysOn: true` means "skip detection", then setting it when keywords match is redundant — the detection already happened. The parameter name is misleading.

**Fix**: Rename to `forceSearch: boolean` — when true, skip keyword detection and always search. Chat flow would NOT set `forceSearch`; instead, the `ContextEnricher.enrich()` method itself runs keyword detection when `forceSearch` is false.

---

## Cross-Cutting Break Points

### BP-X.1 — HIGH (Orphan Field): `/api/agent/experiences/search` endpoint does not exist

The spec says this is an "已有端点" (existing endpoint) that ContextEnricher internally reuses. Grep confirms no such route exists in `packages/server/src/routes/`.

**Fix**: Either:
- Create the endpoint if external access is needed
- Or update the spec to note that ContextEnricher calls `EvolutionDAO.searchByScope()` directly (no HTTP needed)

### BP-X.2 — HIGH (Missing Trigger): No daily memory file creation for harness-agent

The spec adds `loadDailyMemory()` reading from `daily/YYYY-MM-DD.md`, but no process writes these files. The harness flow writes to `harness_events` table but not to the file system.

**Fix**: Add a daily memory writer post-delegation (see BP-2.3).

### BP-X.3 — HIGH (Unconnected Feedback): Experience write path is disconnected from read path

**Write paths** (existing):
- `create_experience` tool in agent sessions → `EvolutionDAO.insertExperience()` → scope defaults to `'agent'`
- Harness reflection → `EvolutionDAO.insertExperienceV2()` → scope from reflection context
- Effectiveness tracker → outcome updates

**Read path** (proposed): `ContextEnricher.enrich()` → `searchByScope()`

The disconnect:
1. The write path defaults scope to `'agent'` for most records
2. The read path searches for `['workflow', 'global']` or `['harness', 'global']`
3. If most records are `scope='agent'`, harness and workflow searches return sparse results

**Fix**: Ensure the experience recording pipeline sets correct scope values. Audit all `insertExperience*` callers to verify scope assignment.

### BP-X.4 — MEDIUM (Silent Failure): All memory reads use empty catch blocks

`SystemPromptAssembler` and `CloneRuntime` consistently use:
```typescript
try { content = fs.readFileSync(path, 'utf-8') } catch { content = '' }
```

Every file read silently swallows errors. A permissions issue or corrupted file would produce an empty segment with no diagnostic trail.

**Fix**: Add `console.warn` in catch blocks:
```typescript
catch (err) {
  console.warn(`[SystemPromptAssembler] Failed to read ${path}:`, err instanceof Error ? err.message : String(err))
  content = ''
}
```

### BP-X.5 — MEDIUM (Unversioned State): Priority system has no extension guard

The priority values (0-6) are hardcoded in `SystemPromptAssembler`. Adding P3.5 works numerically, but:
- The `PromptSegment.source` type must be extended
- The `applyDegradationRule()` switch must add a new case
- No version/migration marker tracks this change

**Fix**: Add `'experience'` to the source type union. Add a `case 'experience'` to `applyDegradationRule()` implementing the spec's 5→3→1 truncation.

### BP-X.6 — HIGH (Magic Bridge): UnifiedPromptAssembler has zero production consumers

`UnifiedPromptAssembler` (defined in `prompt-assembler.ts:306-357`) routes to `HarnessPromptAdapter`, `ClonePromptAdapter`, or `ChatPromptAdapter` based on `type`/`cloneName`. However, **no production code calls `UnifiedPromptAssembler.assembleForAgent()`**. It is only referenced in tests.

The actual callers build prompts directly:
- `main-agent-route.ts` → `new SystemPromptAssembler(org).assemble()`
- `chat-routes.ts` → `new SystemPromptAssembler(org).assemble()`
- `AgentDelegationService` → `buildDelegationPrompt()` + `buildPromptWithHistory()`
- `CloneRuntime.chat()` → `this.assembleContext()`

This means `HarnessPromptAdapter` is **doubly orphaned** — not only does `AgentDelegationService` bypass it (BP-2.1), but the entire `UnifiedPromptAssembler` that would route to it has no production consumers.

**Fix**: The spec should decide whether to:
- **Option A**: Make `UnifiedPromptAssembler` the single entry point for all prompt assembly (requires migrating all callers)
- **Option B**: Keep the current direct-calling pattern and integrate experience injection at each call site independently

### BP-X.7 — HIGH (Magic Bridge): Engine VarPool bridge pattern not mentioned in spec

The engine package is DB-free. The established pattern for injecting server-side data into engine executors is the **VarPool bridge**:
1. `precomputeHook(pool, workflowName, inputs)` runs before `engine.run()` in the server
2. It populates VarPool keys like `__knowledge_rule_cache`, `__relevant_rule_ids`
3. `KnowledgeInjector` reads these keys inside the engine to build prompt segments

The spec proposes calling `ContextEnricher.enrich()` directly from `AgentExecutor.buildPrompt()`, but this breaks the established pattern. The correct approach would be:
1. Add an experience precompute hook on the server side that searches experiences and stores results in VarPool (e.g., `__experience_segment`)
2. Add an `ExperienceInjector` in the engine that reads `__experience_segment` from VarPool and prepends it to the prompt

**Fix**: Update the spec's Story 3 implementation to use the VarPool bridge pattern:
```
[Server] precomputeExperienceHook(pool, workflowName, nodePrompt)
  → ContextEnricher.enrich({scope:'workflow', query:nodePrompt})
  → pool.set('__experience_segment', enrichResult.segment)

[Engine] AgentExecutor.buildPrompt()
  → read pool.get('__experience_segment')
  → prepend to prompt if non-null
```

### BP-X.8 — MEDIUM (Orphan Field): Scope values in code don't match spec's documented union

The `ExperienceRowV2` JSDoc documents scope as `'agent' | 'workflow' | 'harness' | 'global'`. However, actual runtime usage includes additional values: `'project'`, `'workspace'`, `'org'` (used by the archive subsystem in `archive-analysis-service.ts`, `experience-merger.ts`, `prompts.ts`).

The spec's visibility rules only cover three scopes: `agent`, `harness`, `workflow` (each seeing own + `global`). If archive-created experiences use `scope='project'` or `scope='org'`, they would be invisible to the ContextEnricher's search.

**Fix**: Either:
- Extend the ContextEnricher's scope visibility rules to include `'project'` and `'org'`
- Or document that archive-scoped experiences are intentionally excluded from injection

---

## Story 5-8 (System Stories) — Summary

| Story | Status | Key Issue |
|-------|--------|-----------|
| 5. Scope 隔离 | ⚠️ DAO supports single scope only | `searchByScope` takes one scope string, not array. Cross-scope search (own + global) needs DAO extension. |
| 6. 智能触发 | ❌ Not implemented | Entirely depends on ContextEnricher (BP-1.2, BP-4.1) |
| 7. Harness daily memory | ❌ Not implemented | No writer + no loader (BP-2.2, BP-2.3, BP-X.2) |
| 8. 统一接口 | ❌ Not implemented | ContextEnricher interface doesn't exist (BP-1.2) |

---

## Anti-Pattern Summary

| Anti-Pattern | Instances | Severity |
|-------------|-----------|----------|
| **Magic Bridge** | BP-2.1 (delegation flow vs adapter), BP-3.2 (engine→server dependency), BP-X.1 (non-existent API endpoint), BP-X.6 (UnifiedPromptAssembler orphaned), BP-X.7 (VarPool bridge ignored) | CRITICAL, HIGH, HIGH, HIGH, HIGH |
| **Orphan Field** | BP-1.6 (`experience` source type), BP-X.1 (API endpoint), BP-X.8 (scope values mismatch) | MEDIUM, HIGH, MEDIUM |
| **Silent Failure** | BP-X.4 (empty catch blocks) | MEDIUM |
| **Missing Trigger** | BP-2.3/X.2 (no daily memory writer), BP-X.3 (scope mismatch between writers and readers) | HIGH, HIGH |
| **Unversioned State** | BP-X.5 (priority system extension) | MEDIUM |
| **Unconnected Feedback** | BP-X.3 (write path scope vs read path scope) | HIGH |

---

## Recommended Implementation Order

1. **Add `user_message` to `AssembleOptions`** (BP-1.5) — without this, keyword detection has no input
2. **Create `ContextEnricher` service** (BP-1.2) — foundation for all stories
3. **Extend `EvolutionDAO.searchByScope()`** to accept scope arrays (BP-1.3)
4. **Add `'experience'` to `PromptSegment.source`** (BP-1.6, BP-X.5)
5. **Wire into `SystemPromptAssembler`** — add `buildExperienceSegment()` (BP-1.1)
6. **Wire into `AgentDelegationService`** — NOT `HarnessPromptAdapter` (BP-2.1)
7. **Add `loadDailyMemory()`** to `HarnessPromptAdapter` (BP-2.2)
8. **Add daily memory writer** for harness-agent (BP-2.3, BP-X.2)
9. **Use VarPool bridge pattern** for workflow experience injection (BP-X.7) — precompute hook + engine-side reader
10. **Wire into `AgentExecutor.buildPrompt()`** via VarPool (BP-3.1)
11. **Add goal-mode knowledge + experience injection** (BP-3.3)
12. **Audit experience writers for correct scope values** (BP-X.3, BP-X.8)
13. **Add keyword detection** as part of ContextEnricher (BP-1.4, BP-4.1)
14. **Decide UnifiedPromptAssembler fate** (BP-X.6) — either adopt or remove

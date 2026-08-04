# T1 — Schema + Type Expansion + Preflight Check

## What to build
Add `commands`, `rules`, `clones` to the workflow `requires` schema, expand all resource manifest/check types to carry the new types, and implement preflight check logic for commands (`.claude/commands/{name}.md`), rules (`.claude/rules/{name}.md`), and clones (`~/.octopus/agent/clones/{name}/` OR `~/.octopus/agent/built-in/{name}/`).

This is the foundational layer — T2 depends on these types being correct.

## Blocked by
None — can start immediately.

## Status
done

## Exploration
- `packages/shared/src/types/workflow.ts:382-385` — current requires schema (only skills + agent_files)
- `packages/shared/src/resource/resource-preflight.ts:7-18` — ResourceManifest and ResourceCheckResult types
- `packages/shared/src/resource/resource-preflight.ts:144-171` — check() method (only agents + skills)
- `packages/engine/src/engine-init.ts:7-19` — ResourceManifestLike, ResourceCheckResultLike interfaces
- `packages/shared/src/__tests__/requires-schema.test.ts` — existing schema tests
- `packages/server/src/services/__tests__/resource-preflight.test.ts` — existing preflight tests

## Acceptance Criteria
- [x] AC-1: WorkflowSchema.requires accepts `commands: string[]`, `rules: string[]`, `clones: string[]` (all optional)
- [x] AC-2: Old workflows without new fields still parse correctly (backward compat)
- [x] AC-3: `ResourceManifest` has `commands`, `rules` fields (clones excluded — gate-only in engine-init)
- [x] AC-4: `ResourceCheckResult` type union includes `'command' | 'rule' | 'clone'`
- [x] AC-5: `ResourceManifestLike` and `ResourceCheckResultLike` in engine-init expanded to match (no clones in manifest)
- [x] AC-6: `check()` checks commands at `.claude/commands/{name}.md`
- [x] AC-7: `check()` checks rules at `.claude/rules/{name}.md`
- [x] AC-8: `check()` checks clones at both `~/.octopus/agent/clones/{name}/` AND `~/.octopus/agent/built-in/{name}/`
- [x] AC-9: Clone path resolution uses `os.homedir()` (cross-platform, no dependency on packages/server)
- [x] AC-10: `analyze()` is unchanged — no command/rule/clone scanning from workflow nodes

## Verification Method
**Verification type**: Unit tests

**Verification steps**:
1. Run `pnpm test -- packages/shared/src/__tests__/requires-schema.test.ts` — all existing + new tests pass
2. Run `pnpm test -- packages/server/src/services/__tests__/resource-preflight.test.ts` — all existing + new tests pass
3. New test cases:
   - Schema: accepts `{commands: ["x"], rules: ["y"], clones: ["z"]}`, rejects non-string arrays, backward compat
   - Preflight check(): command available/missing, rule available/missing, clone available (user path), clone available (built-in path), clone missing (neither path)
   - analyze(): returns same manifest as before (no new types in analyze result)

**Pass criteria**: All unit tests PASS
**Failure handling**: Max 3 fix attempts, then mark SKIP with reason

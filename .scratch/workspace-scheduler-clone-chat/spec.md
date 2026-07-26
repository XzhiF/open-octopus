# Verified Spec: Workspace & Scheduler Clone Chat Integration

> Source: brief.md + ADR-005-clone-context-assembly.md + codebase analysis
> Status: Verified

## Problem Statement

The `/workspaces/:id` and `/scheduler` page chatbots need to operate under their respective clone identities (workspace / scheduler). Three architectural fractures must be fixed:

1. **SkillLoader path model**: Currently uses a 3-tier model (local evolved / core-pack builtin / prod copy) that does not know about clone-specific skill directories (`built-in/{name}/skills/` or `clones/{name}/skills/`).
2. **CWD design**: All clones currently default to `~/.octopus/agent` -- no isolation, no ownership.
3. **Skill output format**: Lists skills as name+description only; does not tell the agent where to read full SKILL.md content via base directory declaration.

## Scope

### In Scope (Backend only)
- `paths.ts` -- add `getCloneSkillsDir(name, type)`
- `clone-runtime.ts` -- rewrite `loadSkills()` to two-tier model with base directory + grouped list output; add `getDefaultCwd()` returning clone's own directory
- `builtin-clones.ts` -- fix scheduler skill name `octo-schedule-manager` -> `octo-scheduler`
- `chat.ts` -- replace `SystemPromptAssembler.assembleForClone('workspace')` with `CloneRuntime(workspaceDef, org).assembleContext()` (cwd stays `workspace.path`)
- `global-chat.ts` -- replace `SystemPromptAssembler.assembleForClone('scheduler')` + `loadSchedulerSystemPrompt()` with `CloneRuntime(schedulerDef, org).assembleContext()` (cwd = `getBuiltInCloneDir('scheduler')`)
- Deprecate `SystemPromptAssembler.assembleForClone()` (mark deprecated, do not delete -- other callers may exist)

### Out of Scope
- Frontend changes (web-app)
- Old chat history migration
- SSE event format changes
- Agent Tab behavior changes
- Resource module `installed/skills/` path usage

## Architectural Decisions (from ADR-005)

### Decision 1: Two-Tier Skill Model

```
Tier 1 (shared):  ~/.octopus/agent/skills/                  -- global, all clones inherit
Tier 2 (clone):   ~/.octopus/agent/built-in/{name}/skills/  -- built-in clone specific
                  ~/.octopus/agent/clones/{name}/skills/    -- user clone specific

Same-name priority: clone > shared
```

**Filtering rule**: `cloneDef.skills` acts as a whitelist. `[]` (empty) means no filtering -- include all found skills. Non-empty means only include skills whose names appear in the list.

### Decision 2: Skill Output Format -- Base Directory Declaration + Grouped List

```markdown
# Available Skills
When you need a skill, use Read tool to read {base_dir}/{skill_name}/SKILL.md

Shared: ~/.octopus/agent/skills
- **skill-name**: description

Clone: ~/.octopus/agent/built-in/{name}/skills
- **skill-name**: description
```

When a group has zero skills, that group section is omitted entirely. When both groups are empty, output the empty-skills fallback `(no installed skills)`.

### Decision 3: CWD Strategy

```
built-in clone -> ~/.octopus/agent/built-in/{name}/   (clone's own directory)
user clone     -> ~/.octopus/agent/clones/{name}/     (clone's own directory)
Workspace page -> workspace.path                       (caller override)
```

`CloneRuntime` exposes `getDefaultCwd()` that returns the clone's own directory. Callers can override by passing their own `cwd` to `sendQuery`.

## Changes Detail

### Phase 1: Infrastructure

#### 1.1 `paths.ts` -- `getCloneSkillsDir()`

```typescript
export function getCloneSkillsDir(name: string, type: 'built-in' | 'user'): string {
  if (type === 'built-in') {
    return path.join(getBuiltInCloneDir(name), 'skills')
  }
  return path.join(getCloneDir(name), 'skills')
}
```

#### 1.2 `clone-runtime.ts` -- `loadSkills()` rewrite

Replace current `loadSkills()` (which delegates to `SkillLoader.buildPromptSegment()`) with a new implementation:

1. Scan shared skills: `~/.octopus/agent/skills/` -- read all subdirectories with `SKILL.md`
2. Scan clone skills: `getCloneSkillsDir(name, type)` -- read all subdirectories with `SKILL.md`
3. Apply filter: if `cloneDef.skills` is non-empty, keep only skills whose names are in the list
4. Same-name dedup: clone skills override shared skills
5. Output: base directory declaration + grouped list (name + description only)

Also add `getDefaultCwd()`:
```typescript
getDefaultCwd(): string {
  return this.cloneDef.type === 'built-in'
    ? getBuiltInCloneDir(this.cloneDef.name)
    : getCloneDir(this.cloneDef.name)
}
```

The `chat()` method should use `getDefaultCwd()` as fallback instead of `getAgentDir()`.

#### 1.3 `builtin-clones.ts` -- Fix scheduler skill name

```typescript
skills: ['octo-scheduler'],  // was 'octo-schedule-manager'
```

### Phase 2: Page Integration

#### 2.1 `chat.ts` -- Workspace clone (cwd = workspace.path)

Replace:
```typescript
const assembler = new SystemPromptAssembler('default')
workspaceClonePrompt = assembler.assembleForClone('workspace')
```

With:
```typescript
import { CloneRuntime } from '../services/agent/clone-runtime'
import { getBuiltinCloneDef } from '../services/agent/builtin-clones'

const cloneDef = getBuiltinCloneDef('workspace')
const workspaceClonePrompt = cloneDef
  ? new CloneRuntime(cloneDef, 'default').assembleContext()
  : ''
```

CWD stays as `workspace.path` (already correctly set).

#### 2.2 `global-chat.ts` -- Scheduler clone (cwd = built-in/scheduler/)

Replace:
```typescript
const assembler = new SystemPromptAssembler('default')
schedulerClonePrompt = assembler.assembleForClone('scheduler')
// fallback to SYSTEM_PROMPT
```

With:
```typescript
import { CloneRuntime } from '../services/agent/clone-runtime'
import { getBuiltinCloneDef } from '../services/agent/builtin-clones'
import { getBuiltInCloneDir } from '../services/agent/paths'

const cloneDef = getBuiltinCloneDef('scheduler')
const schedulerClonePrompt = cloneDef
  ? new CloneRuntime(cloneDef, 'default').assembleContext()
  : SYSTEM_PROMPT  // keep as fallback

const cwd = getBuiltInCloneDir('scheduler')  // clone's own directory
```

Pass `cwd` (the scheduler's directory) to `agent.sendQuery()` instead of `process.cwd()`.

### Phase 3: Cleanup

- Mark `SystemPromptAssembler.assembleForClone()` as `@deprecated` with JSDoc comment
- Keep `loadSchedulerSystemPrompt()` + `SKILL_SEARCH_PATHS` in `global-chat.ts` as fallback (do not delete)
- Remove unused `SystemPromptAssembler` import from `chat.ts` (no longer used there)
- Remove unused `SystemPromptAssembler` import from `global-chat.ts` (no longer used there)

## Verification

### Unit Tests
- `clone-runtime.test.ts`: Test `loadSkills()` with two-tier scanning, same-name dedup, filtering, and output format
- `paths.test.ts` (new or extend): Test `getCloneSkillsDir()` returns correct paths for both types

### Integration (Manual)
- Workspace page: "who are you" -> workspace persona; "ls" -> project files; memory -> shared
- Scheduler page: "who are you" -> scheduler persona; "pwd" -> built-in/scheduler/; skills -> octo-scheduler; memory -> isolated
- Agent Tab: unchanged

## Risks
- R1: `cloneDef.skills: []` means "no filter" (include all). When both tiers are empty, skills section is empty -- expected.
- R2: workspace clone memoryScope=shared reads global memory. Large memory may affect prompt size; `truncateToBudget` in `SystemPromptAssembler` is not used by `CloneRuntime` -- but `CloneRuntime` reads files directly without budget truncation. This is acceptable for now as memory files are typically small.
- R3: scheduler directory has no `CLAUDE.md`; `claude_code` preset silently skips missing files.

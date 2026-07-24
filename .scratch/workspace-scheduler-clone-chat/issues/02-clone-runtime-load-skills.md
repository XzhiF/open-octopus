# Ticket 2: clone-runtime.ts -- loadSkills() rewrite + getDefaultCwd()

**Phase**: 1 (Infrastructure)
**Status**: done
**File**: `packages/server/src/services/agent/clone-runtime.ts`

## Description

Rewrite `CloneRuntime.loadSkills()` from the current `SkillLoader`-delegated approach to a two-tier scanning model with base directory declaration + grouped list output. Add `getDefaultCwd()` method.

## Implementation

### loadSkills() rewrite

Replace the current implementation that delegates to `SkillLoader.buildPromptSegment()`:

```typescript
private loadSkills(): string {
  try {
    const loader = getSkillLoader(this.org)
    const { content } = loader.buildPromptSegment(this.cloneDef.skills)
    return content
  } catch {
    return ''
  }
}
```

With a new two-tier implementation:

1. Scan shared skills from `getAgentSkillsDir()` (~/.octopus/agent/skills/)
2. Scan clone skills from `getCloneSkillsDir(name, type)` (built-in/{name}/skills/ or clones/{name}/skills/)
3. Apply filter: if `cloneDef.skills` is non-empty, only include listed skills
4. Same-name dedup: clone skills override shared skills
5. Output format:
   ```
   # Available Skills
   When you need a skill, use Read tool to read {base_dir}/{skill_name}/SKILL.md

   Shared: ~/.octopus/agent/skills
   - **skill-name**: description

   Clone: ~/.octopus/agent/built-in/{name}/skills
   - **skill-name**: description
   ```
6. Empty group sections are omitted. Both empty -> fallback message.

### getDefaultCwd()

```typescript
getDefaultCwd(): string {
  return this.cloneDef.type === 'built-in'
    ? getBuiltInCloneDir(this.cloneDef.name)
    : getCloneDir(this.cloneDef.name)
}
```

### chat() method update

Change the CWD fallback in `chat()` from `getAgentDir()` to `getDefaultCwd()`:

```typescript
const effectiveCwd = cwd || this.getDefaultCwd()
```

## Verification Method

- **Unit test**: Two-tier scanning with shared + clone skills, verify same-name dedup (clone wins)
- **Unit test**: Filter with non-empty skills list only includes listed skills
- **Unit test**: Empty skills list `[]` includes all found skills (no filtering)
- **Unit test**: Output format contains base directory declaration and grouped list
- **Unit test**: `getDefaultCwd()` returns correct directory for built-in and user clones
- **TypeScript**: `tsc --noEmit` passes

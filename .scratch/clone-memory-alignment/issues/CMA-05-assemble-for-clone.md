# Ticket: SystemPromptAssembler.assembleForClone() Full Budget Truncation

## ID
CMA-05

## Status
done

## Summary
Restore `SystemPromptAssembler.assembleForClone()` from deprecated status and implement full priority-based budget truncation for clone system prompts.

## Scope
- Remove `@deprecated` annotation
- Implement `getCloneSegments()` — build clone-specific segments (persona, memory, daily, skills)
- Implement clone-specific segment builders:
  - `buildClonePersonaSegment()` — read from `{cloneDir}/persona.md`
  - `buildCloneMemorySegment()` — read from `{cloneDir}/memory/long-term.md`
  - `buildCloneDailyMemorySegment()` — read from `{cloneDir}/memory/daily/{today}.md`
- Use existing `truncateToBudget()` for budget enforcement
- Add `resolveCloneDir()` helper to find clone directory (built-in or user)

## Files
- `packages/server/src/services/agent/system-prompt-assembler.ts` — update assembleForClone() and add helpers

## Acceptance Criteria
- AC1: `assembleForClone()` returns truncated prompt within token budget
- AC2: Clone persona loaded from correct path (built-in or user)
- AC3: Clone long-term memory included with priority-based truncation
- AC4: Clone daily memory included
- AC5: Fallback to main agent assembly if clone not found

## Verification Method
```bash
# Unit test
pnpm test -- --run packages/server/src/services/agent/__tests__/system-prompt-assembler.test.ts

# Verify token budget enforcement
# Create clone with very long memory, verify output truncated to max_tokens
```

## Dependencies
None

## Implementation Notes
- Priority order: persona (0) > memory (1) > daily (2) > skills (3)
- Reuse existing `truncateToBudget()` — it already handles per-segment degradation
- `resolveCloneDir()`: check built-in first, then user clone dir
- Keep deprecated warning in JSDoc for non-migrated callers but remove @deprecated tag

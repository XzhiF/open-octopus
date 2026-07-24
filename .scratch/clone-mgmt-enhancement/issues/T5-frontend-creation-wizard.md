# T5: Frontend — Creation Wizard (2-Step + Dynamic Skills)

## Status: pending

## Summary

Refactor the 4-step creation wizard into 2 steps: Step 1 (required: name + display_name + persona) and Step 2 (optional: skills + workspace + memory). Skills loaded dynamically from API instead of hardcoded list. Skills not required for creation.

## Scope

### Frontend changes

1. **Rewrite `CloneCreateWizard.tsx`**:
   - Step 1 (required):
     - `name`: English ID, lowercase + hyphens only, validated
     - `display_name`: Display name (supports Chinese)
     - `persona`: Textarea for persona description
   - Step 2 (optional):
     - Skills: fetched from `GET /api/agent/skills`, checkbox list, none required
     - Workspace: optional workspace name + projects
     - Memory scope: shared or isolated (radio)
   - Create button enabled when Step 1 is valid (Step 2 can be skipped)

2. **Dynamic skills loading**:
   - Call `api.listSkills()` on wizard open
   - Show loading skeleton while fetching
   - Show "暂无可用技能" if empty
   - Allow creation with zero skills selected

3. **API call update**:
   - `CreateCloneRequest` type updated to include `display_name`
   - `api.createClone()` posts to new unified endpoint

4. **Update `lib/agent/types.ts`**:
   - `CreateCloneRequest` add `display_name: string`

## Verification

### Manual checklist

- [ ] Step 1: name validation works, display_name field present, persona textarea
- [ ] Step 2: skills loaded from API, can select none, can select multiple
- [ ] Create with only Step 1 filled → success
- [ ] Create with both steps → success
- [ ] Skills list matches API response

## Dependencies

- T1 (unified API + new types)

## Files to modify

- `packages/web-app/components/agent/clone/CloneCreateWizard.tsx`
- `packages/web-app/lib/agent/types.ts` — update CreateCloneRequest

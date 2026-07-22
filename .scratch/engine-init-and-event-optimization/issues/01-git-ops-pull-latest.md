# Ticket 1: Add git-ops pullLatest method

## Status: DONE

## Description

Add `pullLatest(projectPath)` method to GitOps class that fetches from origin and merges the default branch.

## Files

- `packages/server/src/services/git-ops.ts`

## Implementation

```typescript
/** Fetch from origin and merge the default branch. Returns merge commit SHA or throws on conflict. */
async pullLatest(projectPath: string): Promise<string> {
  await runGit(projectPath, ["fetch", "origin"])
  const { stdout: defaultBranch } = await runGit(projectPath, ["symbolic-ref", "refs/remotes/origin/HEAD"])
  const branch = defaultBranch.replace("refs/remotes/origin/", "")
  await runGit(projectPath, ["merge", `origin/${branch}`, "--no-edit"])
  return this.getHeadCommit(projectPath)
}
```

## Verification

- `pnpm test -- packages/server` passes (no regressions)
- Method is typed correctly and follows existing patterns

## Acceptance Criteria

- [ ] `pullLatest` method exists on GitOps class
- [ ] Method fetches from origin, detects default branch, merges
- [ ] Method returns the new HEAD commit SHA
- [ ] Method throws on merge conflict (caller handles warning)

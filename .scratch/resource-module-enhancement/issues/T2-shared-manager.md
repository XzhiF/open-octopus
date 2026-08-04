# T2: Shared Manager — Activate/Deactivate + Uninstall Guard + Backup

## Status: in_progress

## Problem

`ResourceManager` currently only supports install/uninstall. The new types (rule, command, clone) require an activation lifecycle: after installation, users activate (copy to runtime target), and deactivate (remove from target). Uninstall must be blocked when a resource is activated. Clone uninstall needs backup support.

## Solution

1. Add `activate(name, type, caller)` method to `ResourceManager`
2. Add `deactivate(name, type, caller)` method to `ResourceManager`
3. Modify `uninstall()` to check `activated` state and support `keepBackup`
4. Add private `getActivationTarget(type, name)` helper
5. Add private `createBackup(name, installPath)` helper
6. Update `getInstallPath()` to handle new type subdirs
7. Update `detectType()` to check for rule/command in builtin
8. Update `registerBuiltins()` to handle new types from core-pack
9. Update `install()` and `installOrUpgrade()` to set `activated: false` on new entries

## Acceptance Criteria

- [ ] `activate("my-rule", "rule", "cli")` copies `.md` file to `.claude/rules/my-rule.md`
- [ ] `activate("my-cmd", "command", "cli")` copies `.md` file to `.claude/commands/my-cmd.md`
- [ ] `activate("my-clone", "clone", "cli")` copies full bundle to `~/.octopus/agent/clones/my-clone/`
- [ ] `activate` on already-activated resource throws `ACTIVATION_BLOCKED`
- [ ] `activate` on skill/agent/workflow throws `INVALID_TYPE`
- [ ] `deactivate` removes file from activation target
- [ ] `deactivate` on non-activated resource throws `DEACTIVATION_BLOCKED`
- [ ] `uninstall` on activated resource throws `UNINSTALL_BLOCKED`
- [ ] `uninstall` clone with `keepBackup: true` creates backup at `backups/clones/{name}-{timestamp}/`
- [ ] `uninstall` clone with `keepBackup: false` performs clean removal
- [ ] `getInstallPath` returns correct paths for rules/commands/clones
- [ ] Install sets `activated: false` in registry entry
- [ ] All existing tests still pass
- [ ] TypeScript compiles without errors

## Files to Change

- `packages/shared/src/resource/resource-manager.ts` — activate, deactivate, modified uninstall, helpers

## Tests to Write

- `packages/shared/src/__tests__/resource.test.ts` — extend:
  - activate rule → file at .claude/rules/{name}.md, registry updated
  - activate command → file at .claude/commands/{name}.md
  - activate clone → directory at ~/.octopus/agent/clones/{name}/
  - activate already-activated → throws ACTIVATION_BLOCKED
  - activate skill/agent/workflow → throws INVALID_TYPE
  - deactivate → file removed, registry cleared
  - deactivate non-activated → throws DEACTIVATION_BLOCKED
  - uninstall activated → throws UNINSTALL_BLOCKED
  - uninstall clone with backup → backup dir exists
  - uninstall clone without backup → no backup dir

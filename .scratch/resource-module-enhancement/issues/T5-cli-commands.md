# T5: CLI Commands — activate/deactivate Subcommands + Updated list/info

## Status: done

## Problem

The CLI `resource` command currently has install/uninstall/list/info/search/stats/audit subcommands but no activate/deactivate. The list command doesn't show activation status. The info command doesn't show activation fields. The type description strings are hardcoded to "skill/agent/workflow".

## Solution

1. Add `activate` subcommand — `octopus resource activate <name> --type <type>` → POST /activate
2. Add `deactivate` subcommand — `octopus resource deactivate <name> --type <type>` → POST /deactivate
3. Update `list` — add ACTIVATED column for new-type resources
4. Update `info` — show `Activated`, `Activated At`, `Activated To` fields
5. Update `search` — support `--type rule`, `--type command` filters
6. Update `uninstall` — add `--keep-backup` flag
7. Update command description strings to include all 6 types
8. Update `source info` — show new type counts (rules, commands, clones)
9. Update `source add` — show new type counts in output

## Acceptance Criteria

- [ ] `octopus resource activate my-rule --type rule` sends POST /activate and shows success
- [ ] `octopus resource deactivate my-rule --type rule` sends POST /deactivate and shows success
- [ ] `octopus resource list --type rule` shows rules with ACTIVATED column
- [ ] `octopus resource info my-rule --type rule` shows activation fields
- [ ] `octopus resource search <query> --type rule` filters by rule type
- [ ] `octopus resource uninstall my-clone --type clone --keep-backup` sends keepBackup: true
- [ ] Command descriptions mention all 6 types
- [ ] Source commands show new type counts
- [ ] All existing tests still pass
- [ ] TypeScript compiles without errors

## Files to Change

- `packages/cli/src/commands/resource.ts` — new subcommands, updated output formats

## Tests to Write

- `packages/cli/src/__tests__/resource-cmd.test.ts` — extend:
  - activate subcommand sends correct POST request
  - deactivate subcommand sends correct POST request
  - list with --type rule shows filtered results
  - info shows activation fields
  - uninstall with --keep-backup passes flag

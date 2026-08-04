# T7: Core-Pack — rules/ and commands/ Directories + Sample Resources

## Status: pending

## Problem

Core-pack currently has `skills/`, `agents/`, and `workflows/` directories but no `rules/` or `commands/` directories. BuiltinProvider needs these directories to exist with at least one sample resource each for testing and demonstration purposes. The `index.js` exports need updating to expose the new directory paths.

## Solution

1. Create `packages/core-pack/rules/` directory with sample rule `.md` file
2. Create `packages/core-pack/commands/` directory with sample command `.md` file
3. Update `packages/core-pack/index.js` to export `rulesDir` and `commandsDir`
4. No `clones/` directory (built-in clones are code-managed, not resource-managed per brief)

## Acceptance Criteria

- [ ] `packages/core-pack/rules/` directory exists with at least 1 `.md` file
- [ ] `packages/core-pack/commands/` directory exists with at least 1 `.md` file
- [ ] `index.js` exports `rulesDir` and `commandsDir`
- [ ] Sample rule file has valid markdown content
- [ ] Sample command file has valid markdown content (with Claude Code command format)
- [ ] BuiltinProvider can discover the sample resources
- [ ] All existing tests still pass

## Files to Change

- `packages/core-pack/rules/code-style.md` — new sample rule
- `packages/core-pack/commands/cmd-review.md` — new sample command
- `packages/core-pack/index.js` — new exports

## Tests to Write

- Verified through T3 BuiltinProvider tests (discovers from real core-pack dirs)
- Manual: `octopus resource search <query> --type rule` finds the sample

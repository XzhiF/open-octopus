# T3: Shared Providers — BuiltinProvider Rules/Commands + SourceDiscovery New Patterns

## Status: in_progress

## Problem

`BuiltinProvider` only discovers skills, agents, and workflows from core-pack. It needs to also discover rules and commands (`.md` files in `rules/` and `commands/` directories). `SourceDiscovery` only scans for skills/agents/workflows in git repos — it needs patterns for rules (`rules/*.md`), commands (`commands/*.md`), and clones (`clones/*/persona.md`).

## Solution

### BuiltinProvider
1. Extend `typeToSubdir()` to handle `rule`, `command`, `clone`
2. Extend `getSourcePath()` to find `.md` files for rules/commands
3. Add `scanRuleFiles()` and `scanCommandFiles()` methods
4. Update `list()` to call new scan methods
5. Update `install()` to handle new types (single-file copy like agents)
6. Update `getCorePackBase()` to detect rules/commands dirs

### SourceDiscovery
1. Add `scanRules()` method — scan `rules/` for `*.md` files
2. Add `scanCommands()` method — scan `commands/` for `*.md` files
3. Add `scanClones()` method — scan `clones/` for dirs with `persona.md`
4. Call new methods from `discoverFromConventions()`
5. Update `skipDirs` in `scanRootCategories()`
6. Update `ManifestResourceSchema` inline type enum

## Acceptance Criteria

- [ ] `BuiltinProvider.list()` includes rules from `core-pack/rules/`
- [ ] `BuiltinProvider.list()` includes commands from `core-pack/commands/`
- [ ] `BuiltinProvider.getSourcePath(name, "rule")` returns path to `.md` file
- [ ] `BuiltinProvider.getSourcePath(name, "command")` returns path to `.md` file
- [ ] `BuiltinProvider.install(name, "rule", path)` copies `.md` file correctly
- [ ] `SourceDiscovery.discover()` detects `rules/*.md` as type `rule`
- [ ] `SourceDiscovery.discover()` detects `commands/*.md` as type `command`
- [ ] `SourceDiscovery.discover()` detects `clones/*/persona.md` as type `clone`
- [ ] Manifest-based discovery accepts new types
- [ ] Existing skill/agent/workflow discovery still works
- [ ] All existing tests still pass
- [ ] TypeScript compiles without errors

## Files to Change

- `packages/shared/src/resource/builtin-provider.ts` — new type support
- `packages/shared/src/resource/source-discovery.ts` — new scanning patterns

## Tests to Write

- `packages/shared/src/__tests__/resource.test.ts` — extend:
  - BuiltinProvider discovers rules from test fixtures
  - BuiltinProvider discovers commands from test fixtures
  - BuiltinProvider installs rule .md file
  - SourceDiscovery detects rules/ dir with .md files
  - SourceDiscovery detects commands/ dir with .md files
  - SourceDiscovery detects clones/ dir with persona.md
  - SourceDiscovery manifest with new types parses correctly
  - Existing discovery still works (no regression)

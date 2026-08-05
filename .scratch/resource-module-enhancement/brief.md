# Requirement Brief: Resource Module Enhancement — Rules, Commands & Clones

## Overview
Expand the Octopus resource module from 3 types (skill, agent, workflow) to 6 types by adding rule (Claude Code rules), command (Claude Code custom slash commands), and clone (Octopus agent clone definitions), with a new install → activate/deactivate → uninstall lifecycle for the 3 new types.

## Projects Involved
- [x] @octopus/shared (core domain — ResourceType enum, ResourceManager, schemas, providers)
- [x] @octopus/server (API endpoints — activate/deactivate, updated middleware)
- [x] @octopus/cli (CLI commands — activate, deactivate subcommands)
- [x] @octopus/web-app (UI — type filters, activate/deactivate buttons, badges)
- [x] @octopus/core-pack (builtin resources — rules/, commands/ directories)

## Feature Scope

**Do:**
- Add 3 new ResourceType values: `rule`, `command`, `clone`
- Implement install → activate/deactivate → uninstall lifecycle for new types
- Rules activate to workspace `.claude/rules/{name}.md`
- Commands activate to workspace `.claude/commands/{name}.md`
- Clones activate to `~/.octopus/agent/clones/{name}/` (full bundle: persona, config, skills, memory, etc.)
- Track activation state with separate `activated` boolean + metadata in registry
- Backup on clone uninstall (`~/.octopus/resources/backups/{type}/{name}-{timestamp}/`)
- Block uninstall of activated resources (require deactivate first)
- Source discovery for new types in git repos
- BuiltinProvider for rules and commands (core-pack `rules/`, `commands/`)
- CLI `activate` and `deactivate` subcommands
- Web UI: new type filters, activate/deactivate buttons, activated badge
- Full test coverage: unit + integration + CLI + Web UI

**Don't:**
- Add activate/deactivate to existing types (skill, agent, workflow)
- Create a separate clone management page (use existing resource page)
- Make clones available as builtin resources (built-in clones stay in code at `~/.octopus/agent/built-in/`)
- Change the existing clone runtime system (clone-resolver, clone-runtime, clone-init-service)
- Modify the existing clone API at `/api/clones` (keep separate from resource API)

## Key Decisions

| # | Decision | Conclusion | Reason |
|---|---------|-----------|--------|
| 1 | Resource types | 6 types: skill, agent, workflow, rule, command, clone | Expand module to cover Claude Code config ecosystem |
| 2 | Install pattern | New types: registry-only + activate | Separate installation from activation — user controls when resources go live |
| 3 | Activate targets | rule → `.claude/rules/`, command → `.claude/commands/`, clone → `~/.octopus/agent/clones/` | Matches Claude Code and Octopus clone conventions |
| 4 | Rules/commands scope | Current workspace `.claude/` | Project-scoped activation, not global |
| 5 | Clone source | local + git only | Built-in clones (workspace, scheduler, archive, resource) are code-managed, not resource-managed |
| 6 | Clone bundle | Full directory (persona, config, skills, agents, commands, memory, rules) | Clone is a complete agent identity package |
| 7 | State model | Separate `activated: boolean` + `activatedAt` + `activatedTo` | Clean separation: status = file integrity, activated = is it live |
| 8 | Backup location | `~/.octopus/resources/backups/{type}/{name}-{timestamp}/` | Centralized, managed by resource module |
| 9 | Uninstall guard | Activated → block (deactivate first). Clone → ask "keep backup?" | Prevent data loss, support manual restore |
| 10 | Core-pack dirs | `rules/` + `commands/` (no `clones/`) | User custom clones only; built-in clones are code-defined |
| 11 | Source discovery | `rules/*.md`, `commands/*.md`, `clones/*/persona.md` | Convention-based detection matching existing patterns |
| 12 | Verification | Full coverage: unit + integration + CLI + Web UI | All layers must work end-to-end |
| 13 | Web UI | Update existing `/resources` page | Consistent UX, no new navigation surface |

## Data Model Changes

| Table/Schema | Operation | Details |
|-------------|-----------|---------|
| `ResourceType` (Zod enum) | **Extend** | Add `"rule"`, `"command"`, `"clone"` → 6 values |
| `ResourceEntry` (Zod schema) | **Add fields** | `activated: boolean` (default false), `activatedAt?: string`, `activatedTo?: string` |
| `registry.json` | **Schema change** | Entries may now include activation fields |
| `installed/` directory | **Add subdirs** | `rules/{group}/{name}/`, `commands/{group}/{name}/`, `clones/{group}/{name}/` |
| `backups/` directory | **New** | `~/.octopus/resources/backups/{type}/{name}-{timestamp}/` |
| `SAFE_NAME_RE` | **Verify** | Ensure regex allows rule/command/clone naming conventions |

## API Contracts

| Method | Path | Side | Params | Response | Notes |
|--------|------|------|--------|----------|-------|
| POST | /api/resources/activate | Server | `{ name, type }` | `{ name, type, activatedTo }` | **NEW** — copies to target dir |
| POST | /api/resources/deactivate | Server | `{ name, type }` | `{ name, type }` | **NEW** — removes from target dir |
| POST | /api/resources/uninstall | Server | `{ name, type, keepBackup? }` | `{ name, type, backupPath? }` | **MODIFIED** — add keepBackup param, block if activated |
| GET | /api/resources | Server | `?type=rule\|command\|clone` | existing + activated field | **MODIFIED** — filter supports new types |
| GET | /api/resources/:type/:name | Server | type + name | existing + activated fields | **MODIFIED** — supports new types |
| GET | /api/resources/builtin | Server | — | existing + rules/commands | **MODIFIED** — includes builtin rules/commands |
| GET | /api/resources/stats | Server | — | existing + new type counts | **MODIFIED** — includes new types |

## Acceptance Criteria

| # | User Story | AC | Verification Method |
|---|-----------|----|-------------------|
| AC-1 | As a user, I can install a rule from builtin | `octopus resource install builtin:my-rule` succeeds, registry shows `type: rule, activated: false` | Integration: POST /install → GET registry |
| AC-2 | As a user, I can activate a rule | `octopus resource activate my-rule` copies `.md` to `.claude/rules/my-rule.md`, registry shows `activated: true` | Integration: POST /activate → file exists at target |
| AC-3 | As a user, I can deactivate a rule | `octopus resource deactivate my-rule` removes `.md` from `.claude/rules/`, registry shows `activated: false` | Integration: POST /deactivate → file removed from target |
| AC-4 | As a user, I can install a command from builtin | Same as AC-1 but for command type, target is `.claude/commands/` | Integration: POST /install → GET registry |
| AC-5 | As a user, I can activate/deactivate a command | Same as AC-2/AC-3 but for command type | Integration: file at `.claude/commands/{name}.md` |
| AC-6 | As a user, I can install a clone from a git source | `octopus resource source add <url>` discovers clones, `octopus resource install git:source/clone-name` installs full bundle | Integration: source discover → install → registry entry |
| AC-7 | As a user, I can activate a clone | `octopus resource activate my-clone` copies full bundle to `~/.octopus/agent/clones/my-clone/` | Integration: POST /activate → directory exists with all files |
| AC-8 | As a user, I cannot uninstall an activated resource | `octopus resource uninstall my-rule` returns error: "Deactivate first" | Integration: POST /uninstall → 409 error |
| AC-9 | As a user, I can uninstall a deactivated clone with backup | Uninstall with `keepBackup: true` → backup at `backups/clones/name-timestamp/` | Integration: POST /uninstall → backup dir exists |
| AC-10 | As a user, I can uninstall a deactivated clone without backup | Uninstall with `keepBackup: false` → clean removal, no backup | Integration: POST /uninstall → no backup dir |
| AC-11 | As a user, I can list resources filtered by new types | `octopus resource list --type rule` shows only rules with activation status | CLI: output includes ACTIVATED column |
| AC-12 | As a user, I can see resource info with activation details | `octopus resource info my-rule` shows activated status, target path | CLI: info output includes activation fields |
| AC-13 | As a user, source discovery detects new types in git repos | `octopus resource source analyze <url>` lists rules, commands, clones | CLI: output includes new types |
| AC-14 | As a user, the web UI shows new type filters | `/resources` page has rule/command/clone filter buttons | E2E: filter buttons visible, filtering works |
| AC-15 | As a user, I can activate/deactivate from web UI | Activate button on inactive cards, Deactivate on activated cards | E2E: click activate → badge appears |
| AC-16 | As a user, web UI blocks uninstall of activated resources | Uninstall button shows "Deactivate first" tooltip or dialog | E2E: uninstall blocked with message |
| AC-17 | As a user, clone uninstall shows backup confirmation dialog | Web UI asks "Keep backup?" with Yes/No options | E2E: dialog appears, both paths work |
| AC-18 | As a user, audit log records activate/deactivate actions | `octopus resource audit` shows activate/deactivate entries | Integration: activate → GET /audit → records present |
| AC-19 | As a user, verify works for new types | `GET /resources/rule/my-rule/verify` returns verification result | Integration: verify passes for installed resources |
| AC-20 | As a user, stats include new type counts | `octopus resource stats` shows rule/command/clone counts | CLI: stats output includes all 6 types |

## Verification Strategy

### Global Config
- Environment: local dev (`pnpm dev`, server:3001, web:3000)
- Test user: default org
- Data prefix: `E2E_TEST_` for test resources
- Cleanup: remove test resources after each test suite

### Per-layer Methods

#### Unit Tests
- `packages/shared/src/resource/__tests__/`:
  - `types.test.ts` — ResourceType includes 6 values, ResourceEntry with activated fields
  - `resource-manager.test.ts` — activate/deactivate logic, uninstall guard, backup creation
  - `builtin-provider.test.ts` — discovers rules/commands from core-pack
  - `source-discovery.test.ts` — detects rules/commands/clones patterns
  - `registry-store.test.ts` — handles activated field CRUD
  - `verifier.test.ts` — verifies new types (file existence + registry)

#### Integration Tests
- `packages/server/src/routes/resource/__tests__/resource-routes.test.ts`:
  - POST /activate — success, not-found, already-activated, invalid-type
  - POST /deactivate — success, not-found, not-activated
  - POST /uninstall — block if activated, keepBackup flag, backup creation
  - GET / with new type filters
  - GET /builtin includes rules/commands
  - GET /stats includes new types
  - Source discovery includes new types

#### CLI Tests
- `packages/cli/src/__tests__/resource-cmd.test.ts`:
  - `activate` subcommand — sends POST /activate
  - `deactivate` subcommand — sends POST /deactivate
  - `list --type rule` — filters correctly
  - `info` — shows activation fields
  - `source analyze` — shows new types

#### Browser E2E
- `packages/web-app/e2e/tests/resource-management.spec.ts`:
  - Type filter buttons include rule/command/clone
  - Activate button visible on inactive new-type resources
  - Deactivate button visible on activated resources
  - Activated badge shows on cards
  - Uninstall blocked for activated resources (tooltip/dialog)
  - Clone uninstall shows backup confirmation dialog
  - Backup Yes → backup created, No → clean removal

### Prerequisites
- [ ] Server running on localhost:3001
- [ ] Web app running on localhost:3000
- [ ] Core-pack has at least 1 builtin rule and 1 builtin command for testing
- [ ] A test git repo with rules/commands/clones for source discovery testing

## Risks & Notes
- **R1: Activation target path resolution** — The server needs to know the current workspace path to activate rules/commands to `.claude/`. Must resolve from org config, not hardcoded.
- **R2: Clone bundle size** — Clones with memory can be large. Install from git should handle large bundles gracefully.
- **R3: Concurrent activation** — Two users activating same resource to different workspaces should not conflict. Lock per-resource, not global.
- **R4: Source discovery backward compatibility** — Existing git sources with only skills/agents/workflows should continue working. New type detection is additive.
- **R5: Web UI performance** — Adding 3 more type filters to the resource list. Card rendering needs to handle activation state efficiently.

## Glossary (new domain terms)

| Term | Meaning |
|------|---------|
| **Activation (激活)** | Copying an installed resource from the registry to its runtime target directory |
| **Deactivation (停用)** | Removing an activated resource from its runtime target directory |
| **Rule (规则)** | A Claude Code `.claude/rules/*.md` file — modular, path-scoped instructions |
| **Command (命令)** | A Claude Code `.claude/commands/*.md` file — custom slash command definition |
| **Clone resource (分身资源)** | A user-created agent clone definition package (persona + config + skills + memory) installable via the resource module |
| **Backup (备份)** | Archived copy of an uninstalled clone at `~/.octopus/resources/backups/` for manual restore |

## Appendix: Core User Stories (闭环验证)

### Story 1: Install and Activate a Rule
```
[UI]  User navigates to /resources page
[UI]  User selects "rule" type filter → sees builtin rules in "安装" tab
[API] User clicks install on "code-style" rule → POST /api/resources/install { ref: "builtin:code-style" }
[Data] BuiltinProvider copies from core-pack/rules/code-style.md → installed/rules/builtin/code-style/
[Data] RegistryStore creates entry: { name: "code-style", type: "rule", status: "installed", activated: false }
[Event] Install success response → UI updates card to show "Activate" button
[API] User clicks "Activate" → POST /api/resources/activate { name: "code-style", type: "rule" }
[Exec] ActivationService resolves workspace path from org config → copies to {workspace}/.claude/rules/code-style.md
[Data] RegistryStore updates: activated: true, activatedAt: timestamp, activatedTo: "/path/.claude/rules/code-style.md"
[UI]  Card shows green "activated" badge, button changes to "Deactivate"
[API] User clicks "Deactivate" → POST /api/resources/deactivate { name: "code-style", type: "rule" }
[Exec] ActivationService removes file from {workspace}/.claude/rules/code-style.md
[Data] RegistryStore updates: activated: false
[UI]  Badge removed, button changes back to "Activate"
```
✅ No break points — complete closed loop.

### Story 2: Install and Activate a Clone from Git Source
```
[CLI] octopus resource source add https://github.com/team/my-clones --name team-clones
[API] POST /api/resources/source/add { url, name: "team-clones" }
[Exec] GitProvider clones repo → ~/.octopus/resources/sources/team-clones/
[Exec] SourceDiscovery scans: finds clones/code-reviewer/persona.md → type: clone
[Data] SourcesStore saves discovered resources list
[CLI] Output: "1 clone(s) discovered"

[CLI] octopus resource install git:team-clones/code-reviewer
[API] POST /api/resources/install { ref: "git:team-clones/code-reviewer" }
[Exec] Copies full bundle (persona.md, config.json, skills/, memory/) → installed/clones/team-clones/code-reviewer/
[Data] RegistryStore: { name: "code-reviewer", type: "clone", status: "installed", activated: false }
[CLI] Output: "✓ Installed code-reviewer (clone) from git"

[CLI] octopus resource activate code-reviewer --type clone
[API] POST /api/resources/activate { name: "code-reviewer", type: "clone" }
[Exec] Copies full bundle → ~/.octopus/agent/clones/code-reviewer/
[Data] RegistryStore: activated: true, activatedTo: "~/.octopus/agent/clones/code-reviewer/"
[CLI] Output: "✓ Activated code-reviewer → ~/.octopus/agent/clones/code-reviewer/"
```
✅ No break points — source → install → activate chain complete.

### Story 3: Uninstall Activated Clone with Backup
```
[UI]  User navigates to /resources → selects clone filter → sees "code-reviewer" with "activated" badge
[UI]  User clicks "Uninstall" → system shows warning: "Resource is activated. Deactivate first."
[UI]  User clicks "Deactivate" → POST /api/resources/deactivate { name: "code-reviewer", type: "clone" }
[Exec] Removes ~/.octopus/agent/clones/code-reviewer/ directory
[Data] RegistryStore: activated: false
[UI]  Badge removed, "Uninstall" button now enabled

[UI]  User clicks "Uninstall" → system shows dialog: "Keep backup for future restore?"
[UI]  User selects "Yes, keep backup" → POST /api/resources/uninstall { name: "code-reviewer", type: "clone", keepBackup: true }
[Exec] BackupService copies installed/clones/team-clones/code-reviewer/ → backups/clones/code-reviewer-20260804T100000/
[Exec] Removes installed/clones/team-clones/code-reviewer/
[Data] RegistryStore removes entry, writes audit record with backupPath
[UI]  Card removed from list, toast: "Uninstalled. Backup at ~/.octopus/resources/backups/clones/code-reviewer-20260804T100000/"
```
✅ No break points — guard → deactivate → uninstall → backup chain complete.

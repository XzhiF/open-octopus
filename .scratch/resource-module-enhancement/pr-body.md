## Resource Module Enhancement — Rules, Commands & Clones

Expand the Octopus resource module from 3 types (skill, agent, workflow) to 6 types by adding **rule** (Claude Code rules), **command** (Claude Code custom slash commands), and **clone** (Octopus agent clone definitions), with a new install → activate/deactivate → uninstall lifecycle.

### Key Changes

**Data Model:**
- `ResourceType` expanded from 3 → 6 values: `skill`, `agent`, `workflow`, `rule`, `command`, `clone`
- `ResourceEntry` gained `activated`, `activatedAt`, `activatedTo` fields
- 3 new error codes: `ACTIVATION_BLOCKED`, `DEACTIVATION_BLOCKED`, `UNINSTALL_BLOCKED`

**Business Logic:**
- `ResourceManager.activate()` — copies rule/command to `.claude/` or clone to `~/.octopus/agent/clones/`
- `ResourceManager.deactivate()` — removes from activation target
- Modified `uninstall()` — blocks if activated, supports backup for clones
- `BuiltinProvider` discovers `rules/` and `commands/` from core-pack
- `SourceDiscovery` detects `rules/*.md`, `commands/*.md`, `clones/*/persona.md`

**API:**
- `POST /api/resources/activate` — activate a resource
- `POST /api/resources/deactivate` — deactivate a resource
- Modified `POST /api/resources/uninstall` — activation guard + backup support

**CLI:**
- `octopus resource activate <name> --type <type>`
- `octopus resource deactivate <name> --type <type>`
- `octopus resource uninstall <name> --type <type> --keep-backup`

**Web UI:**
- 7 type filter buttons (all + 6 types) with counts
- Activate (⚡) and Deactivate (⚡) buttons on hover
- Green "Activated" badge on activated resources
- Uninstall disabled with tooltip when activated
- Clone uninstall shows "keep backup" checkbox

### E2E Verification
| AC | Condition | Status |
|----|-----------|--------|
| AC-1 | Install rule from builtin | ✅ PASS |
| AC-2 | Activate rule | ✅ PASS |
| AC-3 | Deactivate rule | ✅ PASS |
| AC-4 | Install command from builtin | ✅ PASS |
| AC-5 | Activate/deactivate command | ✅ PASS |
| AC-8 | Block uninstall activated | ✅ PASS |
| AC-11 | List with type filter | ✅ PASS |
| AC-12 | Info with activation details | ✅ PASS |
| AC-18 | Audit log records | ✅ PASS |
| AC-19 | Verify for new types | ✅ PASS |
| AC-20 | Stats include new types | ✅ PASS |
| AC-6,7,9,10 | Clone lifecycle | ⏭️ SKIP (no git fixture) |
| AC-13 | Source discovery | ⏭️ SKIP (no git fixture) |
| AC-14-17 | Web UI | ⏭️ SKIP (no browser E2E) |

### Changed Files (39 files, +4,823 / -85 lines)
- `packages/shared/` — types, manager, providers, discovery, registry
- `packages/server/` — routes, middleware
- `packages/cli/` — activate/deactivate commands, updated list/info
- `packages/web-app/` — type filters, activate/deactivate UI, badges
- `packages/core-pack/` — rules/code-style.md, commands/cmd-review.md

<!-- MANUAL-START -->
<!-- MANUAL-END -->

# Resource Module Enhancement — Verified Spec

> Branch: `feat/resource-module-enhancement`
> Brief: `.scratch/resource-module-enhancement/brief.md`

## 1. Overview

Expand the Octopus resource module from 3 types (`skill`, `agent`, `workflow`) to 6 types by adding `rule`, `command`, and `clone`. The 3 new types follow an **install → activate/deactivate → uninstall** lifecycle, separating installation (registry + file storage) from activation (copying to the runtime target directory).

## 2. Data Model Changes

### 2.1 ResourceType Enum Expansion (3 → 6)

**File**: `packages/shared/src/resource/types.ts`

```typescript
// Before:
export const ResourceType = z.enum(["skill", "agent", "workflow"])

// After:
export const ResourceType = z.enum(["skill", "agent", "workflow", "rule", "command", "clone"])
```

### 2.2 ResourceEntry Schema — Activated Fields

**File**: `packages/shared/src/resource/types.ts`

Add three new optional fields to `ResourceEntrySchema`:

```typescript
export const ResourceEntrySchema = z.object({
  // ... existing fields ...
  activated: z.boolean().default(false),
  activatedAt: z.string().optional(),
  activatedTo: z.string().optional(),
})
```

- `activated`: boolean — whether the resource is currently active at its target location
- `activatedAt`: ISO timestamp of when it was last activated
- `activatedTo`: absolute path of the activation target directory/file

### 2.3 ResourceAuditAction — New Actions

Add `"activate"` and `"deactivate"` to the `ResourceAuditAction` enum:

```typescript
export const ResourceAuditAction = z.enum([
  "install", "uninstall", "verify", "install_blocked",
  "verify_warn", "verify_fail",
  "source_add", "source_remove", "source_update",
  "source_install", "source_sync", "install_or_upgrade",
  "activate", "deactivate",
])
```

### 2.4 UninstallRequest — keepBackup Field

Add optional `keepBackup` to `UninstallRequestSchema`:

```typescript
export const UninstallRequestSchema = z.object({
  name: z.string().regex(SAFE_NAME_RE, "Invalid resource name"),
  type: ResourceType,
  caller: ResourceAuditCaller.default("cli"),
  keepBackup: z.boolean().default(false),
})
```

### 2.5 UninstallResponse — backupPath Field

Add optional `backupPath` to `UninstallResponseSchema`:

```typescript
export const UninstallResponseSchema = z.object({
  name: z.string(),
  type: ResourceType,
  status: z.literal("uninstalled"),
  verified: z.boolean(),
  backupPath: z.string().optional(),
})
```

### 2.6 New Request/Response Schemas

```typescript
export const ActivateRequestSchema = z.object({
  name: z.string().regex(SAFE_NAME_RE),
  type: ResourceType,
  caller: ResourceAuditCaller.default("cli"),
})

export const ActivateResponseSchema = z.object({
  name: z.string(),
  type: ResourceType,
  activatedTo: z.string(),
})

export const DeactivateRequestSchema = z.object({
  name: z.string().regex(SAFE_NAME_RE),
  type: ResourceType,
  caller: ResourceAuditCaller.default("cli"),
})

export const DeactivateResponseSchema = z.object({
  name: z.string(),
  type: ResourceType,
})
```

### 2.7 ResourceCountSchema Expansion

```typescript
export const ResourceCountSchema = z.object({
  skills: z.number().int().nonnegative(),
  agents: z.number().int().nonnegative(),
  workflows: z.number().int().nonnegative(),
  rules: z.number().int().nonnegative(),
  commands: z.number().int().nonnegative(),
  clones: z.number().int().nonnegative(),
})
```

### 2.8 New Error Codes

Add to `ResourceErrorCode`:
- `ACTIVATION_BLOCKED` (409) — resource cannot be activated (e.g., already activated)
- `DEACTIVATION_BLOCKED` (409) — resource cannot be deactivated (e.g., not activated)
- `UNINSTALL_BLOCKED` (409) — resource is activated, must deactivate first

### 2.9 SourceDiscovery Manifest Schema

Update `ManifestResourceSchema` to accept new types:

```typescript
const ManifestResourceSchema = z.object({
  name: z.string(),
  type: z.enum(["skill", "agent", "workflow", "rule", "command", "clone"]),
  path: z.string(),
})
```

## 3. ResourceManager — Activate/Deactivate

**File**: `packages/shared/src/resource/resource-manager.ts`

### 3.1 Activation Targets

| Type | Activation Target |
|------|-------------------|
| `rule` | `{workspace}/.claude/rules/{name}.md` |
| `command` | `{workspace}/.claude/commands/{name}.md` |
| `clone` | `~/.octopus/agent/clones/{name}/` |

### 3.2 activate(name, type, caller) → ActivateResponse

1. Look up registry entry — throw `RESOURCE_NOT_FOUND` if missing
2. Verify entry is installed — throw `ACTIVATION_BLOCKED` if not installed
3. Verify not already activated — throw `ACTIVATION_BLOCKED` if `activated: true`
4. Only allow activation for types: `rule`, `command`, `clone` — throw `INVALID_TYPE` for skill/agent/workflow
5. Resolve target path based on type (workspace from org config or cwd)
6. Copy files from installPath to activatedTo
7. Update registry: `activated: true`, `activatedAt: now`, `activatedTo: targetPath`
8. Write audit record: action = "activate"
9. Emit "activate" event
10. Return `{ name, type, activatedTo }`

### 3.3 deactivate(name, type, caller) → DeactivateResponse

1. Look up registry entry — throw `RESOURCE_NOT_FOUND` if missing
2. Verify entry is activated — throw `DEACTIVATION_BLOCKED` if `activated: false`
3. Remove files from activatedTo path
4. Update registry: `activated: false`, clear `activatedAt` and `activatedTo`
5. Write audit record: action = "deactivate"
6. Emit "deactivate" event
7. Return `{ name, type }`

### 3.4 Modified uninstall — Activation Guard + Backup

The existing `uninstall` method must:

1. **Before** deleting files, check if `entry.activated === true` — throw `UNINSTALL_BLOCKED` with message "Resource is activated. Deactivate first."
2. For `clone` type with `keepBackup: true`:
   - Create backup at `~/.octopus/resources/backups/clones/{name}-{timestamp}/`
   - Copy installPath contents to backup location
   - Include `backupPath` in the response
3. For all other cases, proceed with existing uninstall logic

### 3.5 getInstallPath — Updated for New Types

```typescript
private getInstallPath(type, name, group) {
  const subdir = type === "skill" ? "skills"
    : type === "agent" ? "agents"
    : type === "workflow" ? "workflows"
    : type === "rule" ? "rules"
    : type === "command" ? "commands"
    : "clones"
  return path.join(this.basePath, "installed", subdir, group, name)
}
```

### 3.6 Workspace Path Resolution

For rules and commands, the activation target needs the current workspace path:

```typescript
private getActivationTarget(type, name): string {
  if (type === "rule") {
    const workspace = process.cwd()
    return path.join(workspace, ".claude", "rules", `${name}.md`)
  }
  if (type === "command") {
    const workspace = process.cwd()
    return path.join(workspace, ".claude", "commands", `${name}.md`)
  }
  if (type === "clone") {
    return path.join(os.homedir(), ".octopus", "agent", "clones", name)
  }
  throw new ResourceError("INVALID_TYPE", `Type ${type} does not support activation`)
}
```

## 4. BuiltinProvider — Rules & Commands Discovery

**File**: `packages/shared/src/resource/builtin-provider.ts`

### 4.1 typeToSubdir — Add New Types

```typescript
function typeToSubdir(type: ResourceType): string {
  switch (type) {
    case "skill": return "skills"
    case "agent": return "agents"
    case "workflow": return "workflows"
    case "rule": return "rules"
    case "command": return "commands"
    case "clone": return "clones"  // won't be used for builtin, but exhaustive
  }
}
```

### 4.2 getSourcePath — Handle New Types

Rules and commands are `.md` files like agents:

```typescript
// In getSourcePath, add:
case "rule":
case "command": {
  const filePath = path.join(basePath, `${name}.md`)
  return fs.existsSync(filePath) ? filePath : null
}
```

### 4.3 list() — Scan New Directories

Add `scanRuleFiles()` and `scanCommandFiles()` methods that scan `rules/` and `commands/` directories for `.md` files, similar to `scanAgentFiles()`.

### 4.4 install() — Handle New Types

Rules and commands install like agents (single `.md` files):

```typescript
// In install method, rules and commands use the same copy logic as agents:
if (type === "skill" || type === "clone") {
  fileCount = copyDirSync(sourcePath, installPath)
} else {
  // agent, workflow, rule, command — single files
  const fileName = path.basename(sourcePath)
  const destPath = path.join(installPath, fileName)
  fs.copyFileSync(sourcePath, destPath)
  fileCount = 1
}
```

### 4.5 getCorePackBase — Detect rules/ and commands/ dirs

Update the core-pack detection to also check for `rules` directory existence:

```typescript
// Add "rules" to the existence check
for (const c of candidates) {
  if (fs.existsSync(path.join(c, "skills")) || fs.existsSync(path.join(c, "rules"))) {
    return c
  }
}
```

## 5. SourceDiscovery — New Type Patterns

**File**: `packages/shared/src/resource/source-discovery.ts`

### 5.1 Convention-Based Scanning

Add three new scanning methods:

- **scanRules(dir, resources)**: scan `rules/` for `*.md` files
- **scanCommands(dir, resources)**: scan `commands/` for `*.md` files
- **scanClones(dir, resources)**: scan `clones/` for directories containing `persona.md`

### 5.2 discoverFromConventions — Call New Scanners

```typescript
private discoverFromConventions(dir) {
  // ... existing scans ...
  this.scanRules(dir, resources)
  this.scanCommands(dir, resources)
  this.scanClones(dir, resources)
  // ... disambiguation ...
}
```

### 5.3 skipDirs Update

Add `"rules"`, `"commands"`, `"clones"` to the `skipDirs` set in `scanRootCategories`.

## 6. API Endpoints

**File**: `packages/server/src/routes/resource/index.ts`

### 6.1 POST /activate

```
Request:  { name: string, type: ResourceType }
Response: { name: string, type: ResourceType, activatedTo: string }
Errors:   RESOURCE_NOT_FOUND (404), ACTIVATION_BLOCKED (409), INVALID_TYPE (400)
Lock:     withResourceLock(name)
```

### 6.2 POST /deactivate

```
Request:  { name: string, type: ResourceType }
Response: { name: string, type: ResourceType }
Errors:   RESOURCE_NOT_FOUND (404), DEACTIVATION_BLOCKED (409)
Lock:     withResourceLock(name)
```

### 6.3 Modified POST /uninstall

Add `keepBackup` param support. Map `UNINSTALL_BLOCKED` error code.

### 6.4 Modified GET / (list)

Update type filter validation to accept new types: `rule`, `command`, `clone`.

### 6.5 Modified GET /builtin

Results now include rules and commands from core-pack.

### 6.6 Modified GET /stats

Stats now include counts for new types (already handled by RegistryStore.stats()).

### 6.7 Modified GET /audit

Add `activate` and `deactivate` to VALID_ACTIONS set.

## 7. Middleware Updates

**File**: `packages/server/src/routes/resource/middleware.ts`

### 7.1 VALID_TYPES Set

```typescript
const VALID_TYPES = new Set(["skill", "agent", "workflow", "rule", "command", "clone"])
```

### 7.2 Error Message Update

```typescript
suggestion: "Type must be one of: skill, agent, workflow, rule, command, clone"
```

## 8. CLI Commands

**File**: `packages/cli/src/commands/resource.ts`

### 8.1 activate Subcommand

```
octopus resource activate <name> --type <type>
→ POST /api/resources/activate { name, type }
→ Output: "✓ Activated {name} → {activatedTo}"
```

### 8.2 deactivate Subcommand

```
octopus resource deactivate <name> --type <type>
→ POST /api/resources/deactivate { name, type }
→ Output: "✓ Deactivated {name} ({type})"
```

### 8.3 Updated list Command

Add ACTIVATED column to output for new types. Show `activated`/`inactive` status.

### 8.4 Updated info Command

Show activation fields: `Activated`, `Activated At`, `Activated To`.

### 8.5 Updated search Command

Support `--type rule` and `--type command` filters.

### 8.6 Updated uninstall Command

Add `--keep-backup` flag for clone type.

### 8.7 Updated Description

```typescript
.description("统一资源管理 (skill/agent/workflow/rule/command/clone)")
```

### 8.8 Updated source info Command

Show new type counts: rules, commands, clones.

## 9. Web UI Changes

### 9.1 Type Filters

**File**: `packages/web-app/components/resource/resource-list.tsx`

Add 3 new filter buttons:

```typescript
const TYPE_FILTERS = [
  { label: "全部", value: "all" },
  { label: "Skills", value: "skill" },
  { label: "Agents", value: "agent" },
  { label: "Workflows", value: "workflow" },
  { label: "Rules", value: "rule" },
  { label: "Commands", value: "command" },
  { label: "Clones", value: "clone" },
]
```

Add count tracking for new types.

### 9.2 Resource Card — Activation Badge & Buttons

**File**: `packages/web-app/components/resource/resource-card.tsx`

- Add icon mapping for `rule`, `command`, `clone` types
- Add badge variant styles for new types
- Show "Activated" green badge when `entry.activated === true`
- Show "Activate" button for inactive new-type resources
- Show "Deactivate" button for activated resources
- Disable/block uninstall button when resource is activated (tooltip: "Deactivate first")

### 9.3 UninstallConfirm — Backup Dialog for Clones

**File**: `packages/web-app/components/resource/UninstallConfirm.tsx`

- For `clone` type: add "Keep backup?" checkbox/radio
- Pass `keepBackup` to uninstall API call
- For activated resources: show "Deactivate first" warning instead of uninstall confirmation

### 9.4 API Client — New Methods

**File**: `packages/web-app/lib/resource/api.ts`

Add:
- `activateResource(name, type)` → POST /activate
- `deactivateResource(name, type)` → POST /deactivate
- Updated `uninstallResource` to accept `keepBackup` param

### 9.5 Web-App Types

**File**: `packages/web-app/lib/resource/types.ts`

- Update `ListQuery.type` to include new types
- Re-export new types from `@octopus/shared`

## 10. Core-Pack — New Directories

**File**: `packages/core-pack/`

### 10.1 Add Directories

```
packages/core-pack/
├── rules/          ← .md rule files
│   └── (sample-rule.md)
├── commands/       ← .md command files
│   └── (sample-command.md)
```

### 10.2 index.js — Export New Dirs

```javascript
module.exports = {
  skillsDir: path.join(ROOT, "skills"),
  agentsDir: path.join(ROOT, "agents"),
  scriptsDir: path.join(ROOT, "scripts"),
  templatesDir: path.join(ROOT, "templates"),
  presetsDir: path.join(ROOT, "presets"),
  configDir: path.join(ROOT, "config"),
  rulesDir: path.join(ROOT, "rules"),
  commandsDir: path.join(ROOT, "commands"),
}
```

### 10.3 Sample Resources

Create at least 1 sample rule and 1 sample command for testing:
- `packages/core-pack/rules/code-style.md` — coding style rule
- `packages/core-pack/cmd-review.md` — code review command

## 11. Ticket Dependency Order

```
T1-shared-types → T2-shared-manager → T3-shared-providers → T4-server-routes → T5-cli-commands → T6-webapp-ui → T7-core-pack
```

T1 is the foundation (types used by everything). T2 adds business logic. T3 adds discovery. T4 exposes API. T5 wraps CLI. T6 builds UI. T7 adds sample data (can be parallel with T5/T6).

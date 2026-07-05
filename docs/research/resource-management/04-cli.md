# 4. CLI 设计

## 4.1 命名

| 命令 | 职责 |
|------|------|
| `octopus repos` | Git 仓库管理（clone/pull/index，**已有，不改**） |
| `octopus resource` | Octopus 资源管理（skill/agent/workflow 的注册/安装/发现） |

**为什么用 `resource` 而非 `repo`**：
- `repos` 管的是用户项目的 git 仓库（"我 clone 了哪些项目"）
- `resource` 管的是 Octopus 平台的可安装资源（"我装了哪些 skill/agent"）
- 两个概念完全不同，不应共享名称

## 4.2 命令族

```
octopus resource
├── init            # 初始化 ~/.octopus/resources/ 目录结构
├── register <ref>  # 从外部来源注册资源到全局 registry
├── install <names...>  # 安装资源到当前 workspace
├── uninstall <name>    # 从当前 workspace 卸载资源
├── list                # 列出已注册/已安装资源
├── search <query>      # 搜索资源
├── info <name>         # 查看资源详情
├── deps <name>         # 查看依赖树
├── gc                  # 清理未使用的缓存
├── sync                # 检测 config.json vs lock 漂移
├── audit               # 查看操作审计日志
└── doctor              # 自检 + 修复
```

## 4.3 各命令详细设计

### `octopus resource init`

```
用法: octopus resource init [--force] [--repo-dir <path>]

作用:
  创建 ~/.octopus/resources/ 目录结构:
    registry.json, trusted-sources.yaml, audit.jsonl
    manifests/{skill,agent,workflow}/
    cache/{skill,agent,workflow}/

  如果已有 registry.json 且未 --force，报错退出。

输出:
  Rich: ✓ Resources initialized at ~/.octopus/resources/
  JSON: { status: "initialized", path: "..." }
```

### `octopus resource register <ref>`

```
用法: octopus resource register <ref> --type <type> [options]

参数:
  <ref>              来源引用 (npm:xxx | github:xxx | builtin:xxx | ./path)
  --type <type>      资源类型 (skill | agent | workflow)  [必填]
  --name <name>      自定义名称 (默认从来源推断)
  --tag <tags...>    标签
  --force            覆盖已注册的同名资源
  --trust            自动信任来源 (TOFU)

流程:
  1. parseSourceRef(ref) → SourceRef
  2. SecurityContext.checkCallerPermission("register")
  3. SourceProvider.validate(ref)
  4. SecurityContext.checkSourceTrust(ref)  [TOFU: 首次信任确认]
  5. SourceProvider.fetch(ref, tempDir)
  6. computeContentHash → hash
  7. RegistryStore.add(entry)
  8. AuditLogger.log("resource.registered")

输出:
  ✓ Registered: brainstorming [skill] v1.2.0
    Source:  npm:superpowers-zh
    Hash:    a1b2c3d4e5f6
    Size:    4.0 KB
```

### `octopus resource install <names...>`

```
用法: octopus resource install <names...> [options]

参数:
  <names...>         资源名称列表
  --workspace <dir>  目标 workspace (默认 ".")
  --dry-run          仅显示安装计划，不执行
  --yes              人类确认 (跳过交互确认)
  --confirmed        Agent 确认 (OCTOPUS_CALLER=agent 时必须)

流程:
  1. SecurityContext.checkAgentConfirmation("install", opts)
  2. 从 RegistryStore 查找每个 name → manifest
  3. DependencyResolver.resolve(manifests) → InstallPlan (拓扑排序)
  4. 如果 --dry-run: 输出 InstallPlan 并退出
  5. 对 InstallPlan.ordered 中的每个 step:
     a. 从 cache 复制到 workspace/.claude/{type}s/{name}/
     b. 记录到 resources.lock
  6. AuditLogger.log("resource.installed") for each

输出:
  Install Plan:
    + skill:brainstorming          will install
    + skill:tdd-workflow           will install

  [1/2] ✓ brainstorming           → .claude/skills/brainstorming
  [2/2] ✓ tdd-workflow            → .claude/skills/tdd-workflow

  ✓ Install complete: 2/2 succeeded
  Lock file generated: .octopus/resources.lock
```

### `octopus resource list`

```
用法: octopus resource list [options]

参数:
  --type <type>      按类型过滤
  --tag <tag>        按标签过滤
  --installed        仅显示当前 workspace 已安装的
  --json             JSON 输出

输出 (Rich):
  skills (3):
    Name                           Version    Deps  Source
    ────────────────────────────   ────────   ────  ────────────────
    brainstorming                  1.2.0      0     npm:superpowers-zh
    tdd-workflow                   0.5.0      1     builtin:tdd-workflow
    octo-dev-copilot               builtin    0     builtin:octo-dev-copilot

  agents (1):
    Name                           Version    Deps  Source
    ────────────────────────────   ────────   ────  ────────────────
    code-reviewer                  1.0.0      0     github:XzhiF/agents

  Total: 4 resources (3 skills, 1 agent).
```

### `octopus resource search <query>`

```
用法: octopus resource search <query> [--type <type>] [--page <n>]

输出:
  Name                           Type       Version   Source
  ────────────────────────────   ────────   ────────  ────────────────
  brainstorming                  skill      1.2.0     npm:superpowers-zh
  bug-hunter                     workflow   1.0.0     builtin:bug-hunter

  2 results total.
```

### `octopus resource sync`

```
用法: octopus resource sync [--workspace <dir>] [--fix]

作用:
  对比 config.json 声明 vs resources.lock 已安装项，检测漂移:
    - declared but not installed → 需要安装
    - installed but not declared → 需要移除
    - hash mismatch → 需要更新

输出:
  Drift Report:
    + brainstorming (skill)     declared but not installed
    - old-skill (skill)         installed but not declared
    ~ tdd-workflow (skill)      hash mismatch (a1b2 → c3d4)
    3 unchanged.

  Run with --fix to apply changes.
```

### `octopus resource gc`

```
用法: octopus resource gc [--dry-run]

作用:
  扫描 cache/ 目录，找出未被任何 registry entry 引用的缓存，清理。

输出:
  Scanning cache...
  Found 3 unused entries:
    · cache/skill/old-skill@abc123 (2.1 KB)
    · cache/agent/removed-agent@def456 (1.5 KB)
    · cache/workflow/old-flow@ghi789 (0.8 KB)
  Total: 4.4 KB reclaimable.

  Run without --dry-run to clean up.
```

## 4.4 Agent 门控设计

所有写操作（register/install/uninstall/gc）检查 `OCTOPUS_CALLER` 环境变量：

| 操作 | human (默认) | agent (OCTOPUS_CALLER=agent) |
|------|-------------|------------------------------|
| register | ✅ 允许 | ❌ 拒绝（admin 操作） |
| install | ✅ 需 `--yes` | ✅ 需 `--confirmed` |
| uninstall | ✅ 需 `--yes` | ✅ 需 `--confirmed` |
| gc | ✅ 允许 | ❌ 拒绝（admin 操作） |
| list/search/info/deps | ✅ 允许 | ✅ 允许 |
| audit/doctor/sync | ✅ 允许 | ✅ 允许 |

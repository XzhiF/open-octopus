# 3. 存储层设计

## 3.1 核心原则

**文件为主，DB 为辅。**

- `~/.octopus/resources/` 是 source of truth
- SQLite `resources.db` 是查询索引，可从文件重建
- 用户可以直接编辑 JSON/YAML 文件，CLI 和 Server 都能识别

## 3.2 目录结构

```
~/.octopus/orgs/{org}/resources/
├── registry.json                    # 资源注册表（所有已注册资源的元数据）
├── resources.lock                   # 锁文件：已安装资源 + hash + 来源
├── audit.jsonl                      # 操作审计日志（链式哈希，追加写入）
└── cache/                           # 内容寻址缓存（按 hash 存储）
    ├── resources/
    │   ├── brainstorming/
    │   │   ├── SKILL.md
    │   │   └── scripts/
    │   └── code-reviewer/
    │       └── code-reviewer.md
    └── sources/                     # 集合源缓存（git clone 的仓库）
        ├── agency-agents-zh/        # git clone --depth 1
        │   ├── octopus-resource.json  # 自动/手动生成的 manifest
        │   └── agents/
        │       ├── code-reviewer.md
        │       └── architect.md
        ├── superpowers-zh/
        │   ├── octopus-resource.json
        │   └── skills/
        │       ├── brainstorming/SKILL.md
        │       └── tdd-workflow/SKILL.md
        └── gstack/
            ├── octopus-resource.json
            └── skills/
```

> **注意**：相比原设计，移除了 `trusted-sources.yaml`（信任列表在 config.yaml 的 `resource_sources.trusted` 中）、
> `manifests/` 子目录（manifest 数据直接存储在 registry.json 中）。
> 目录从 `~/.octopus/resources/` 改为 `~/.octopus/orgs/{org}/resources/`（per-org 隔离）。
> 新增 `cache/sources/` 存放集合源的 git clone 缓存。

### Workspace 级别

```
workspace/
├── .claude/
│   ├── skills/                      # 安装目标：skill 文件
│   │   ├── brainstorming/SKILL.md
│   │   └── tdd-workflow/SKILL.md
│   └── agents/                      # 安装目标：agent 文件
│       └── code-reviewer.md
└── workflows/                       # 安装目标：workflow 文件
    └── bug-hunter.yaml
```

> **注意**：相比原设计，移除了 `.octopus/resources.lock`（lock 文件存储在 org 级别
> `~/.octopus/orgs/{org}/resources/resources.lock`，而非 workspace 级别）和
> `config.json`（声明式配置由 registry.json 替代）。
> workflow 安装到 `workspace/workflows/` 而非 `workspace/.octopus/workflows/`。

## 3.3 文件格式

### registry.json — 资源注册表

```jsonc
{
  "version": 1,
  "updated_at": "2026-07-05T10:00:00Z",
  "entries": {
    "skill:brainstorming": {
      "name": "brainstorming",
      "type": "skill",
      "version": "1.2.0",
      "source": { "protocol": "npm", "package": "superpowers-zh" },
      "hash": "a1b2c3d4e5f6",
      "description": "在任何创造性工作之前进行需求分析和设计探索",
      "tags": ["design", "planning"],
      "dependencies": [],
      "size": 4096,
      "manifest_path": "manifests/skill/brainstorming.yaml",
      "cache_path": "cache/skill/brainstorming@a1b2c3d4e5f6/",
      "registered_at": "2026-07-05T10:00:00Z"
    }
  }
}
```

### octopus-resource.json — 集合源清单

存在于集合源 git repo 根目录，声明包含哪些资源以及如何安装。
由 repo 作者编写（Layer 1），或由 AI 分析生成（Layer 2），或由约定扫描生成（Layer 3）。

```jsonc
{
  "name": "superpowers-zh",
  "version": "1.0.0",
  "description": "中文 Claude Code 技能包",
  // 可选：安装前执行一次（npm 包构建、代码生成等）
  // ResourceManager 使用 execFileSync 在 source 缓存目录中执行
  "setup": "npx superpowers-zh@latest --tool claude --force",
  // 声明包含的资源（路径相对于 repo 根目录）
  "resources": {
    "skills": [
      "skills/brainstorming",
      "skills/chinese-code-review",
      "skills/test-driven-development"
    ],
    "agents": [],
    "workflows": []
  }
}
```

### config.yaml — 组织配置（含信任源列表）

信任列表存储在组织配置文件中，而非独立文件：

```yaml
# ~/.octopus/orgs/{org}/config.yaml
name: xzf
prefix: xzf-
platform: github

# 信任的集合源（allowlist 模型）
resource_sources:
  trusted:
    - url: https://github.com/jnMetaCode/agency-agents-zh
      name: agency-agents-zh
      added_at: "2026-07-07"
      discovery_method: convention-scan   # manifest | ai-analysis | convention-scan
    - url: https://github.com/jnMetaCode/superpowers-zh
      name: superpowers-zh
      added_at: "2026-07-07"
      discovery_method: ai-analysis
    - url: https://github.com/garrytan/gstack
      name: gstack
      added_at: "2026-07-07"
      discovery_method: convention-scan
```

### resources.lock — 锁文件

```jsonc
{
  "version": 1,
  "generated_at": "2026-07-05T10:00:00Z",
  "resources": [
    {
      "name": "brainstorming",
      "type": "skill",
      "hash": "a1b2c3d4e5f6",
      "source": { "protocol": "npm", "package": "superpowers-zh" },
      "installed_at": "2026-07-05T10:00:00Z",
      "target": ".claude/skills/brainstorming",
      "installed_by": "human"
    }
  ]
}
```

### manifests/skill/brainstorming.yaml — 资源清单

```yaml
name: brainstorming
type: skill
version: "1.2.0"
description: "在任何创造性工作之前进行需求分析和设计探索"
source:
  protocol: npm
  package: superpowers-zh
dependencies: []
tags: [design, planning]
```

## 3.4 SQLite 索引层

DB 是可选的查询加速层，可从文件重建：

```sql
-- 资源索引表（从 registry.json 同步）
CREATE TABLE resources (
  name        TEXT NOT NULL,
  type        TEXT NOT NULL,
  version     TEXT NOT NULL DEFAULT '0.0.0',
  source_json TEXT NOT NULL,          -- SourceRef JSON
  hash        TEXT NOT NULL,
  description TEXT DEFAULT '',
  tags_json   TEXT DEFAULT '[]',
  deps_json   TEXT DEFAULT '[]',
  size        INTEGER DEFAULT 0,
  registered_at TEXT NOT NULL,
  PRIMARY KEY (type, name)
);

-- 审计日志表（从 audit.jsonl 同步）
CREATE TABLE audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp   TEXT NOT NULL,
  action      TEXT NOT NULL,
  caller      TEXT NOT NULL DEFAULT 'human',
  resource_name TEXT,
  resource_type TEXT,
  status      TEXT NOT NULL DEFAULT 'success',
  detail_json TEXT
);

-- 全文搜索索引
CREATE VIRTUAL TABLE resources_fts USING fts5(
  name, description, tags_json,
  content=resources, content_rowid=rowid
);
```

### 同步策略

```
文件写入 ──→ 同步更新 DB（在同一事务中）
     │
     └──→ registry.add(entry)
              ├── 写 registry.json（AtomicJsonStore）
              └── INSERT INTO resources（SQLite）
```

DB 丢失时可重建：
```bash
$ octopus resource doctor --rebuild-db
```

## 3.5 与 PR #12 的对比

| 维度 | PR #12 | 本设计 |
|------|--------|--------|
| 主存储 | `~/.octopus/repository/registry.json` | `~/.octopus/resources/registry.json` |
| DB | 无 | SQLite 可选索引 |
| 缓存 | `cache/{type}/{name}@{hash}/` | 同（吸纳） |
| 锁文件 | `.octopus/resources.lock` | 同（吸纳） |
| 清单 | `manifests/{type}/{name}.yaml` | 同（吸纳） |
| 信任 | `trusted-sources.yaml` | 同（吸纳） |
| 审计 | `audit.jsonl` | 同 + DB 索引 |

# 3. 存储层设计

## 3.1 核心原则

**文件为主，DB 为辅。**

- `~/.octopus/resources/` 是 source of truth
- SQLite `resources.db` 是查询索引，可从文件重建
- 用户可以直接编辑 JSON/YAML 文件，CLI 和 Server 都能识别

## 3.2 目录结构

```
~/.octopus/resources/
├── registry.json                    # 资源注册表（所有已注册资源的元数据）
├── trusted-sources.yaml             # 信任来源列表（TOFU）
├── audit.jsonl                      # 操作审计日志（追加写入）
├── manifests/                       # 资源清单文件（按类型分子目录）
│   ├── skill/
│   │   ├── brainstorming.yaml
│   │   └── tdd-workflow.yaml
│   ├── agent/
│   │   ├── code-reviewer.yaml
│   │   └── security-auditor.yaml
│   └── workflow/
│       ├── prd-impl.yaml
│       └── bug-hunter.yaml
└── cache/                           # 内容寻址缓存（按 hash 存储）
    ├── skill/
    │   ├── brainstorming@a1b2c3d4e5f6/
    │   │   ├── SKILL.md
    │   │   └── scripts/
    │   └── tdd-workflow@f6e5d4c3b2a1/
    │       └── SKILL.md
    ├── agent/
    │   └── code-reviewer@c1d2e3f4a5b6/
    │       └── code-reviewer.md
    └── workflow/
        └── prd-impl@d1e2f3a4b5c6/
            └── prd-impl.yaml
```

### Workspace 级别

```
workspace/
├── .octopus/
│   └── resources.lock               # 锁文件：已安装资源 + hash + 来源
├── .claude/
│   ├── skills/                      # 安装目标：skill 文件
│   │   ├── brainstorming/SKILL.md
│   │   └── tdd-workflow/SKILL.md
│   └── agents/                      # 安装目标：agent 文件
│       └── code-reviewer.md
└── config.json                      # 声明式配置：需要哪些资源
```

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

### trusted-sources.yaml — 信任来源

```yaml
trusted:
  - protocol: npm
    package: superpowers-zh
    trusted_at: "2026-07-05"
  - protocol: github
    repo: XzhiF/octopus-skills
    trusted_at: "2026-07-05"

blocked:
  - protocol: npm
    package: malicious-skill
    reason: "Reported by community"
    blocked_at: "2026-07-05"
```

### resources.lock — Workspace 锁文件

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

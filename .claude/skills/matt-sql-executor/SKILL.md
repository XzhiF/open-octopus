---
name: matt-sql-executor
description: SQLite executor for Octopus project. Executes SQL files or statements against the project's SQLite database. Auto-detects DB path based on startup mode (dev/worktree/prod).
version: 2.0.0
---

# SQLite Executor (Octopus)

针对 Octopus 项目的 SQLite 执行器，根据启动模式自动定位数据库文件。

## 数据库路径规则

| 启动模式 | 数据库路径 |
|----------|-----------|
| `pnpm dev`（主仓库） | `~/.octopus/db/octopus.db` |
| `pnpm dev`（worktree） | `~/.octopus/db/octopus-{branch}.db` |
| `pnpm prod` | `~/.octopus/db/octopus-prod.db` |

## 依赖

项目已安装 `better-sqlite3`（在 `@octopus/server` 包中），无需额外安装。

## Usage

### 执行 SQL 文件

```bash
node .claude/skills/matt-sql-executor/scripts/sql-executor.js path/to/file.sql
```

### 执行 SQL 语句

```bash
node .claude/skills/matt-sql-executor/scripts/sql-executor.js --sql "SELECT * FROM workflows LIMIT 10"
```

### 指定数据库路径

```bash
# 显式指定
node .claude/skills/matt-sql-executor/scripts/sql-executor.js --db ~/.octopus/db/octopus-prod.db --sql "SELECT count(*) FROM workflows"

# 通过环境变量
OCTOPUS_DB_PATH=~/.octopus/db/octopus.db node .claude/skills/matt-sql-executor/scripts/sql-executor.js file.sql
```

### 指定启动模式

```bash
# 自动使用主仓库 DB
node .claude/skills/matt-sql-executor/scripts/sql-executor.js --mode dev --sql "SELECT * FROM workflows"

# 自动使用 prod DB
node .claude/skills/matt-sql-executor/scripts/sql-executor.js --mode prod --sql "SELECT * FROM workflows"

# 自动使用当前 worktree 的 DB（从 git branch 推断）
node .claude/skills/matt-sql-executor/scripts/sql-executor.js --mode worktree --sql "SELECT * FROM workflows"
```

## DB 路径解析优先级

1. `--db <path>` 显式指定
2. `OCTOPUS_DB_PATH` 环境变量
3. `--mode <dev|worktree|prod>` 自动推断
4. 默认: `~/.octopus/db/octopus.db`（主仓库 dev 模式）

## Agent 集成

在 `matt-dev-runner` 或 `matt-e2e-tester` 中：

```bash
# 执行 SQL 文件
node .claude/skills/matt-sql-executor/scripts/sql-executor.js .scratch/<feature>/sql/schema-update.sql

# 查询数据
node .claude/skills/matt-sql-executor/scripts/sql-executor.js --sql "SELECT id, name FROM workflows WHERE status='active'"

# 更新数据
node .claude/skills/matt-sql-executor/scripts/sql-executor.js --sql "UPDATE workflows SET status='archived' WHERE id='wf_123'"
```

## Output 示例

```
DB: ~/.octopus/db/octopus.db
SQL: SELECT id, name, status FROM workflows LIMIT 5

| id      | name           | status  |
|---------|----------------|---------|
| wf_001  | Deploy Flow    | active  |
| wf_002  | Review Flow    | active  |

5 rows returned
```

## Notes

1. 使用 `better-sqlite3` 同步 API，无需 async
2. 语句按 `;` 分隔顺序执行
3. `--` 注释行被跳过
4. SELECT 查询默认显示最多 20 行结果
5. 执行失败返回非零退出码

# 01 · 数据模型

> 覆盖 C1/C2/C8/C12 + G1。后端 Hono+better-sqlite3 裸 SQL；`schema.sql` 即当前形态（幂等 CREATE TABLE IF NOT EXISTS）；旧库加列走 DAO 构造器 try/catch ALTER；跨域链接 **S2 无 FK、应用层级联**。

## 四表 DDL（追加 schema.sql）
```sql
CREATE TABLE IF NOT EXISTS cabins (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,                    -- 显示名可中文
  path TEXT NOT NULL,                    -- cwd = 长期 workspace 路径
  workspace_id TEXT,                     -- 无 FK：舱拥有的脚手架 workspace
  main_session_id TEXT,                  -- 无 FK：sessions session_type='main' = 舱主对话
  requirements TEXT NOT NULL DEFAULT '', -- 镜像 .cabin/requirements.md
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','initializing','active','dormant','archived')),
  mainline_strategy TEXT NOT NULL DEFAULT 'clean-main',
  org TEXT,                              -- C12 单 org/舱
  init_state TEXT,                       -- JSON 门禁冷加载快照（真相在磁盘）
  cockpit_prefs TEXT,                    -- JSON 纯 UI（含 autonomy/mood/sound）
  focused_job_id TEXT,                   -- C8 当前聚焦作业
  version INTEGER NOT NULL DEFAULT 1,    -- 乐观锁
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  last_active_at TEXT, archived_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_cabins_path ON cabins(path);
CREATE INDEX IF NOT EXISTS idx_cabins_status ON cabins(status);

CREATE TABLE IF NOT EXISTS cabin_iterations (
  id TEXT PRIMARY KEY, cabin_id TEXT NOT NULL,
  code TEXT NOT NULL, name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','done')),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cabin_iterations_cabin ON cabin_iterations(cabin_id, sort_order);

CREATE TABLE IF NOT EXISTS cabin_jobs (
  id TEXT PRIMARY KEY, cabin_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('task','workflow','subagent')),
  ref_id TEXT, session_id TEXT, iteration_id TEXT,   -- 均无 FK，引用底层实体
  title TEXT NOT NULL,
  mandate TEXT,                        -- JSON {strength,scope,basis,policyVersion} 不可变
  prompt TEXT,                         -- 转发原始 trigger，不改写成计划
  priority INTEGER NOT NULL DEFAULT 0, -- C8
  created_at TEXT NOT NULL, ended_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_cabin_jobs_cabin ON cabin_jobs(cabin_id, priority DESC, created_at);

CREATE TABLE IF NOT EXISTS cabin_job_events (   -- append-only 审计（C6/C9）
  id TEXT PRIMARY KEY, job_id TEXT NOT NULL, cabin_id TEXT NOT NULL,
  kind TEXT NOT NULL,                  -- dispatch|report|attention|handback|note|human_input
  actor TEXT,                          -- orchestrator|doer|human
  payload TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cabin_job_events_job ON cabin_job_events(job_id, created_at);
```
`cabin_job_events` 加触发器禁 UPDATE/DELETE（同 task_phase_acceptances）。

## 链接列（S2 无 FK + DAO ALTER 回填）
`workspaces.cabin_id`、`tasks.cabin_id`、`sessions.cabin_id`、`tasks.iteration_id`。新列进 CREATE TABLE 体（新库）+ **CabinDAO 构造器** try/catch ALTER（旧库，单点，仿 archive-draft-dao:17）。db/types.ts 对应 row 加字段。

## 列 vs JSON vs 派生（K3）
- 列：身份/生命周期/可查询链接。
- JSON：init_state（冷加载）、cockpit_prefs（纯 UI）、mandate/payload。
- **派生不存**：attention[]、health、迭代进度/成员、作业 status/report、repos/worktrees、open-findings 计数 → deriveCabinView + fs/git 读。

## 迭代成员单写者
成员 = `tasks.iteration_id`（单写者=任务），**不**存 iterations.taskIds[]。进度派生自成员任务 deriveTaskView。cabin_iterations.status 是人写计划态。

## 舱 ↔ workspace ↔ 主会话
舱拥有持久 workspace 行（复用 ensureMainWorkspace 模式但舱级；WorkspaceService.create 传 ASCII slug，中文显示名留 cabins.name）。舱主对话 = sessions(session_type='main', cabin_id, cwd, workspace_id)。**G2**：主会话不绑单任务；各任务自有 author/doer 会话（带 cabin_id）。

## G1 级联删除（仅 delete）
事务序：cabin_job_events→cabin_jobs→cabin_iterations→executions→tasks→sessions→workspaces→cabins（by cabin_id）+ 磁盘 worktreeRemove。archive 软封存不删（C1）。

## ER 接缝
cabins→workspace(1:1)→sessions(main 1:1 + 任务 author/doer N)→tasks(N, cabin_id/iteration_id)→executions(N)→llm_calls/agent_events；cabin_jobs→ref(task/execution/subagent_run)；cabin_job_events→job。
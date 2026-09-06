# 01 — server：GET /:id/batch-tree 磁盘直扫 + manifest 空键噪音过滤

## What to build

task home `.scratch/` 批次树一次性枚举端点（spec K7 契约），+ v4 manifest 写侧空数组剔除（spec K3）。

- `TaskHomeService.batchTree(taskId)`：
  - 批次目录 = `.scratch` 子树中**直接含 `.md` 的目录**：日期层（`.scratch/<date>/`）自身无直放 .md → 其子目录各自成批；`.scratch/<slug>/` 扁平布局直放 .md → 本身成批。
  - 每批 `files` = 批目录内递归 depth ≤2 的 `.md`（批内 `spec*.md` + `issues/*.md` 全见，更深不追）；全局 cap 300 文件截断。
  - 返回 `{ batches: [{ dir, slug, files: [{path, mtime, bytes}], latest_mtime }] }`；path home 相对 posix（可直接喂 readHomeFile）；批次按 `latest_mtime` 降序（新写的排最前）。
  - 缺 `.scratch` / 缺 home → `batches: []`（200，空是正常态）。
- `TasksService.batchTree(taskId)`：`taskDAO.getById` 前置（未知任务 TaskNotFoundError→404，**不建野 home**）→ 委托。
- `routes/tasks.ts`：`GET /:id/batch-tree`（错误分类同 home-file：classifyError）。
- `writeManifestFile`（v4 分支）：`spec.resources` / `spec.authoring_resources` 为 `[]` 时从快照剔除（非空保留——K3 纠错，它们是 agent 可写活字段；DB 行零触碰）。

落点：`packages/server/src/services/tasks/task-home-service.ts`、`tasks-service.ts`、`packages/server/src/routes/tasks.ts`。零触碰：resolveHomePath 白名单语义（batchTree 只读不入门禁面）、home-file GET/PUT、SSE、信封。

## Blocked by

None — can start immediately.

## Status

done

## Exploration

**Analog studied**：`listHomeDir`（task-home-service.ts:851 同 walk 样板：readdirSync withFileTypes + depth 闸 + `.md` 过滤 + cap + posix 化 path.relative）；路由挂点与 404 前置样板 = `tasks-service.ts:788 listHomeDir` 委托 + `routes/tasks.ts:332`；测试 harness 逐字复用 `tasks-home-file.test.ts`（in-memory DB + tmpDir 注入 TaskHomeService + 路由级 app.request）。

**注意**：`.scratch` 根不能走 `resolveHomePath`（它要求 `.scratch/` 带斜杠前缀，G2 已固化 `.scratch`→403），batchTree 自基 `path.join(home, BATCH_AREA_PREFIX)` 即可，无用户输入路径 → 无逃逸面（无入参 path 是本端点的安全前提，写死）。

## Acceptance Criteria

- [x] AC1: tmp home 铺 `.scratch/20260101/alpha/{spec.md,issues/01-a.md,issues/02-b.md}` + `.scratch/20260102/beta/spec.md` → GET 返回 2 批，alpha files=3、beta files=1，dir/slug/latest_mtime 正确，mtime 新者在前
- [x] AC2: 非 .md（notes.txt）与 depth>2（`issues/sub/deep.md`）不进 tree；cap：造 301 个 .md → 截断 ≤300
- [x] AC3: 扁平 `.scratch/legacy/spec.md`（无日期层）也成批；空 `.scratch/`、缺 `.scratch/`、仅 home 根散 .md → `batches: []` 200
- [x] AC4: 未知任务 → 404 且磁盘无野 home 目录（G5 同款断言）
- [x] AC5: v4 manifest 快照：resources/authoring_resources `[]` → 键不出现；非空 `[{type:"skill",name:"x"}]` → 原样保留；v3 任务两者不动；DB tasks 行 JSON 零变化（四方之 DB 面）

## Verification

`pnpm --filter @octopus/server test src/__tests__/tasks-batch-tree.test.ts`（新文件，harness 抄 tasks-home-file）；server 全量基线 42 红不增。

# 06 — 产物路由：索引 + 完整内容白名单读取

## What to build
产出查看器的服务端（US7）：GET /api/tasks/:id/artifacts 返回索引（缺失/损坏均降级 []）；GET /api/tasks/:id/artifacts/content?path= 读完整内容，白名单校验防越权。

## Blocked by
04 — 任务创建扩展（家目录在创建时已存在）

## Status
done

## Acceptance Criteria
- [x] AC1: GET artifacts → ArtifactIndexEntry[]；无 artifacts.json → []；损坏 JSON → [] + warn（SW-BP12）
- [x] AC2: GET content?path= 白名单：家目录 artifacts/ 内的相对路径（规范化后不得逃逸，`../` 拒绝）或索引中已登记 external=true 的绝对路径；其余 → 403
- [x] AC3: 返回 `{ path, content }`，content 为磁盘文件实时内容（== fs.readFileSync）
- [x] AC4: 登记但磁盘缺失的 external 条目 → 404 + 明确错误码（UI 降级态依据）

## Verification Method
**Verification type**: integration test

**Verification steps**:
```bash
cd packages/server && pnpm vitest run src/__tests__/tasks-v3-artifacts.test.ts
```
建 task + 家目录 fixture：写 artifacts.json（1 内部 + 1 external）+ 磁盘文件 → GET index 断言 2 条；GET content 内部路径 == 写入内容；`?path=../persona.md` → 403；未登记绝对路径 → 403；登记但不存在 → 404；损坏索引 → []。

**Pass criteria**: All verification steps PASS
**Failure handling**: Max 3 fix attempts, then mark SKIP with reason

## Exploration

**Analog studied**: the assist-workflow route pair in `packages/server/src/routes/tasks.ts`
(POST/GET `/:id/assist-workflows[/:runId]`, ticket 07) — the closest existing feature: a
route pair under `/:id/` that delegates to a service owning the concern, with typed errors
classified to HTTP status in `classifyError`. Also studied `TaskHomeService.readArtifacts`
(ticket 02, already implements AC1: missing→[], corrupted→[]+warn SW-BP12) and
`TasksService.getTask`/`deleteTask` (task-exists check → `TaskNotFoundError` → 404).

**Files needing modification**:
- `packages/server/src/services/tasks/task-home-service.ts` — add
  `readArtifactContent(taskId, requestedPath)` + `ArtifactAccessError` (whitelist + read).
- `packages/server/src/services/tasks/tasks-service.ts` — add `listArtifacts(taskId)` +
  `readArtifactContent(taskId, path)` delegating methods (task-exists → 404, then delegate).
- `packages/server/src/routes/tasks.ts` — add GET `/:id/artifacts` + GET
  `/:id/artifacts/content`; extend `classifyError` for `ArtifactAccessError`.
- `packages/server/src/__tests__/tasks-v3-artifacts.test.ts` — NEW integration test.

**Functions chosen**:
- Use `TaskHomeService.readArtifacts(taskId)` (already exists) for AC1 — do NOT rewrite.
- Use `TaskHomeService.homePath`/`artifactsDir` (pure derivation) for the whitelist boundary.
- New `TaskHomeService.readArtifactContent(taskId, requestedPath)` owns whitelist + read;
  throws `ArtifactAccessError(code="FORBIDDEN"→403 | "NOT_FOUND"→404)`. Do NOT put whitelist
  logic in the route — keep the route thin (mirrors assist-workflow pattern).
- `TasksService.listArtifacts`/`readArtifactContent` delegate after a task-exists check
  (mirrors `getTask`/`deleteTask` throwing `TaskNotFoundError`→404).

# 03 — PluginMaterializer + getPlugins 任务扩展

## What to build
所选 Skill 组的 skills 从 `~/.octopus/resources/installed/skills/{group}/...` 物化（symlink；Windows junction；失败降级 copy）进 `{home}/skills/{skill-name}/`；「默认通用」组是空标记不物化（D17）。`CloneRuntime.getPlugins(taskHomePath?)` 对 task-author 会话追加第三 plugin 目录；新参数**追加在 chat()/sendWithProvider() 签名尾部**，不重排既有参数（SW-BP15）。

## Blocked by
02 — TaskHomeService（家目录骨架）

## Status
done

## Acceptance Criteria
- [x] AC1: `server/src/services/tasks/plugin-materializer.ts`：materializeGroups(home, groups) — 从 registry 解析每组 type=skill 资源的 installPath，逐个 skill 建链接
- [x] AC2: Windows 优先 junction（无需管理员）；junction 失败→copy 兜底；posix 用 symlink→copy 兜底
- [x] AC3: group === "default"（内置默认通用）→ 跳过物化，返回空（D17）
- [x] AC4: 重复物化幂等（已存在同名链接→跳过或替换，不报错）
- [x] AC5: clone-runtime getPlugins 增可选 taskHomePath；chat()/sendWithProvider() 尾部追加参数；既有调用方（clone/index.ts、main-agent-route、测试）零改动仍通过
- [x] AC6: task-author send path 在 task 有家目录时传入 taskHomePath

## Verification Method
**Verification type**: unit test + 回归

**Verification steps**:
```bash
cd packages/server && pnpm vitest run src/services/tasks/__tests__/plugin-materializer.test.ts
pnpm vitest run src/services/agent/__tests__/clone-runtime.test.ts   # 回归：既有签名兼容
```
temp 目录模拟 registry installPath：物化→readdir 断言链接存在 ∧ SKILL.md 可读穿；default 组→skills/ 为空；既有 clone-runtime 测试全绿（参数顺序未破坏）。

**Pass criteria**: All verification steps PASS
**Failure handling**: Max 3 fix attempts, then mark SKIP with reason

## Exploration

**Analog studied**: `TaskHomeService` (ticket 02, `packages/server/src/services/tasks/task-home-service.ts`) — same package, same test pattern (temp `baseDir` via `fs.mkdtempSync` + `fs.rmSync` cleanup, console.warn spy for degraded paths). Also `TaskAuthorSessionAugmenter` + `packages/server/src/__tests__/07-resource-loading.test.ts` for how to construct a temp `ResourceManager({ basePath })` and install skills via `rm.registerInstalled({ name, type: "skill", group })` + writing `SKILL.md` at `basePath/installed/skills/{group}/{name}/SKILL.md`.

**Registry data flow confirmed**:
- `ResourceManager.list({ type: "skill", installed: true })` returns `ResourceListResponse { resources: ResourceEntry[], total }`.
- `ResourceEntry` has both `group: string` and `installPath: string` (absolute path to the installed skill dir, e.g. `~/.octopus/resources/installed/skills/{group}/{name}/`).
- Install path layout (resource-manager.ts:868-881): `basePath/installed/skills/{group}/{name}/` — so per-group filtering by `entry.group === group` is the right query.
- `ResourceManager({ basePath })` constructor is the test seam (no global singleton needed).

**CloneRuntime param threading** (clone-runtime.ts:280-385):
- `chat(message, sessionId, providerSessionId, cwd, specUpdateNotice?, authoringResourcesContent?, abortSignal?)` — 7 params, all optional after cwd.
- `sendWithProvider(message, cwd, resumeSessionId, cloneSystemPrompt, specUpdateNotice, authoringResourcesContent, abortSignal)` — private, called by chat.
- `getPlugins()` returns `Array<{ type: 'local'; path: string }>` — called by sendWithProvider at clone-runtime.ts:383.
- Existing callers verified: `routes/clone/index.ts:370` passes 6 args; `routes/agent/main-agent-route.ts:239,763` passes 4 args; tests pass ≤6 args. Appending `taskHomePath?` after `abortSignal` (tail) is fully backward-compatible (SW-BP15).

**Link creation APIs chosen**:
- Windows junction: `fs.symlinkSync(target, path, 'junction')` — Node's documented junction creator, no admin rights needed (AC2). `fs.lstatSync().isSymbolicLink()` reports junctions as symlinks (confirmed by task-home-service.ts:138-140 reap logic).
- POSIX symlink: `fs.symlinkSync(target, path, 'dir')`.
- Copy fallback: `fs.cpSync(src, dest, { recursive: true })` (Node 16.7+).
- Chosen because: junction is the only Windows link type that doesn't need admin AND doesn't follow into target on rm (matches SW-BP14 reap guarantee).

**Functions chosen**:
- `rm.list({ type: "skill", installed: true })` → filter `entry.group === group` → use `entry.installPath` as link target. NOT `rm.get(type, name)` (would require knowing skill names in advance; we enumerate the group).
- `path.join(taskHomePath, 'skills')` for the third plugin dir in getPlugins (matches TaskHomeService.createHome which makes `home/skills/`).

**Files needing modification**:
- NEW `packages/server/src/services/tasks/plugin-materializer.ts` — `materializeGroups(home, groups)` + link/junction/copy helpers.
- NEW `packages/server/src/services/tasks/__tests__/plugin-materializer.test.ts` — AC1-AC4.
- MODIFIED `packages/server/src/services/agent/clone-runtime.ts` — append `taskHomePath?` to `getPlugins`/`chat`/`sendWithProvider`; getPlugins appends third plugin when set.
- MODIFIED `packages/server/src/services/agent/__tests__/clone-runtime.test.ts` — add `getPlugins(taskHomePath)` tests + assert existing 4-arg/6-arg `chat()` callers still work (AC5 regression).
- MODIFIED `packages/server/src/routes/clone/index.ts` — AC6: when `cloneName === 'task-author'` and bound task has a home dir on disk, pass `taskHomePath` as 8th arg to `runtime.chat()`.

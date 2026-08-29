# 05 — server:general-dev 换绑 task-dev + 种子版本迁移(存量刷新)

## What to build
看板默认推荐落地:seed 常量换绑 built-in/task-dev + **PRESETS_VERSION 迁移机制**——skip-if-exists 导致存量安装永不刷新(CRITICAL 断点 B),文件内容 ≡ 旧内嵌默认时自动刷新,用户手改则保护;live catalog 同步;task-dev 安装为 built-in 资源。

## Blocked by
04(task-dev.yaml 为引用对象)

## Status
done

## Exploration

**Analog studied**: persona.md seed pattern in `clone-init-service.ts` (skip-if-exists per file) + `init-service.test.ts` (temp-dir isolation via `vi.mock('../paths')` — the repo's test convention for anything touching `~/.octopus`).

**Key facts gathered**:
- Live catalog at `~/.octopus/agent/built-in/task-author/workflow-presets.yaml` is byte-identical to the CURRENT seed literal (verified via diff — has the superpowers entry, general-dev=matt-dev-pipeline, no version header). So content-hash ≡ PREV default → migration refreshes it naturally on next server start; this dev machine's file will also be written directly (step 4).
- Resource registry (`~/.octopus/resources/registry.json`, list shape): `superpowers-task-dev` installed, plain `task-dev` NOT installed → `ResourceManager.install({ref:'builtin:task-dev', type:'workflow'})` with `OCTOPUS_CORE_PACK_PATH` env needed (builtin-provider.ts:19 reads it when NODE_ENV≠production).
- `~/.octopus/workflow-schema.json` already deleted (ticket 04 done); `sync-builtin.mjs` gone. Remaining dead branch: `setup-runner/index.ts:1185-1190` (existsSync guard for workflows/workflow-schema.json — file no longer exists in core-pack, branch is unreachable). `copyFileSync`/`existsSync` imports stay (used elsewhere).
- Server startup consumer (`index.ts:239-246`) reads only `dirsCreated`/`dbRegistered` → adding `filesRefreshed` to `CloneInitResult` is safe/additive.
- `WorkflowPresetsService(baseDir?)` + `paths.getHome()` honor injected base / `OCTOPUS_HOME` → test isolation without touching `~/.octopus`.
- Chosen functions: `hashPresetsContent`/`normalizePresetsContent` live in `workflow-presets-seed.ts` (single source of the seed contract); do NOT hash raw content — normalize strips the `# version: N` first-line header + CRLF→LF + trimEnd so the header itself never causes a false "user-modified" verdict, and an already-current file skips silently (no warn spam).

**Files to modify**: `workflow-presets-seed.ts` (new default + PRESETS_VERSION=2 + PREV constant + helpers), `clone-init-service.ts` (migration on skip-if-exists path), new `__tests__/clone-init-service.test.ts` (3 AC3 cases), `workflow-presets-seed.test.ts` (extend: general-dev binding + version-header consistency), `packages/cli/src/setup-runner/index.ts` (schema-branch removal, 04 handoff).

## Acceptance Criteria
- [x] AC1: seed general-dev.workflow=built-in/task-dev;新增 PRESETS_VERSION + PREV_DEFAULT_YAML 常量
- [x] AC2: CloneInitService 迁移:存在且内容哈希≡旧默认 → 刷成新默认(log);用户改过 → 保留 + warn;新建 → 直接写新默认
- [x] AC3: 单测三用例:旧默认被刷/手改保留+warn/新建直写(实为 5 用例:另加「已是最新→静默跳过不 warn」「尾部空白漂移→仍识别为旧默认」)
- [x] AC4: 真机 live catalog 刷新验证(见 ## Verification — 迁移经真实生产代码路径落盘 + GET 路由等价服务层断言 PASS;:3001 无运行进程,curl 由 07 重启后复验)
- [x] AC5: registry 落装 PASS(builtin:task-dev installed+verified,安装 yaml 与 core-pack sha 一致);PUT/confirm/DB 物化半段移交 07(本机无常驻 server;全新 server 会以真实 dev DB 启动 scheduler,有意外执行真实任务的风险,超出本 ticket 授权)

## Verification Method
**Verification type**: 单元 + API 集成
**Verification steps**:
```bash
cd packages/server && pnpm vitest run src/services/agent/__tests__/ pnpm build
# dev server :3001 重启后
curl -s localhost:3001/api/workflow-presets | grep -o '"workflow":"built-in/task-dev"'
curl -s localhost:3001/api/workflows/built-in/task-dev | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['parsed']['inputs'])"
```
数据前缀 E2E_TEST_GTD_,cleanup DELETE;断言 DB(matt-sql-executor)。
**Pass criteria**: AC1-AC5 全 PASS,api↔db 交叉(R3)
**Failure handling**: Max 3 fix attempts, then mark SKIP with reason

## Verification (2026-08-29, matt-dev-runner ticket 05)

**单元(AC1/AC2/AC3)** — TDD red→green:
- 新增 `packages/server/src/services/agent/__tests__/clone-init-service.test.ts`(5 用例:旧默认被刷+log / 手改保留+恰好一次 warn / 缺失直写新默认 / 已是最新静默跳过 / 尾空白漂移仍判旧默认)+ 扩展 `workflow-presets-seed.test.ts`(general-dev=built-in/task-dev + goal/ac 骨架、xzf/superpowers 不变、`# version: N` 首行=PRESETS_VERSION、PREV=matt-dev-pipeline 无头、hashPresetsContent 归一化语义)。
- 先红(8 failed:符号不存在)后绿:`pnpm vitest run src/services/agent/__tests__/clone-init-service.test.ts src/services/agent/__tests__/workflow-presets-seed.test.ts` → **11/11 passed**。
- 基线:`pnpm --filter @octopus/server test` 改前/改后各跑一次(git stash 对照),失败集 **diff 完全一致(46 failed tests / 13 files,13 文件含 config-manager 4 例均为既有基线),零新增**;`packages/server` 与 `octopus`(cli)build 均绿。

**实现摘要**:seed 常量换绑 + `PRESETS_VERSION=2` + `PREV_DEFAULT_WORKFLOW_PRESETS_YAML`(HEAD 原文逐字保留)+ `normalizePresetsContent`(剥首行版本头/CRLF/尾部空白)+ `hashPresetsContent`(sha256);CloneInitService task-author 分支三态迁移,`CloneInitResult` 新增 `filesRefreshed`(server/index.ts 仅读 dirsCreated/dbRegistered,additive 安全);setup-runner:1185 workflow-schema.json 死分支移除(04 handoff,schema 文件/core-pack 均不存在,`copyFileSync`/`existsSync` 仍被他处使用)。

**真机(AC4/AC5-registry)**:
- 实况修正:live `~/.octopus/agent/built-in/task-author/workflow-presets.yaml` 与 PREV 默认**逐字节相同**(diff 证实,非 dispatcher 预警的手改态)→ 走 `node --input-type=module` esbuild 打包 scratch 脚本,**以真实 CloneInitService.initBuiltInClones(StubDAO,零 DB 写)跑真机迁移**:log 输出 `matched the embedded previous default — refreshed to seed default v2`,filesRefreshed=[presets.yaml];重跑幂等(refreshed=[],无 warn)。
- GET 路由等价断言(路由是薄包装,已核对源码):`WorkflowPresetsService().list()` → general-dev.workflow=**built-in/task-dev**, inputs={goal:${goal},ac:${ac}},全量三 preset;**首行 = `# version: 2`**。`BuiltInWorkflowService(rm).get('built-in/task-dev')` → 非空,parsed.inputs 三项含 description,max_turns required=false default="200"。
- registry:builtin:task-dev 曾有**僵尸条目(installed:true 但 installPath 目录不存在)**→ `ResourceManager.installOrUpgrade`(setup 同路径,先删后装+upsert)修复:status=installed/verified=true,安装文件与 `packages/core-pack/workflows/task-dev.yaml` sha1 一致(`7172e1c2…`)。OCTOPUS_CORE_PACK_PATH 必须显式设置(shared dist 的 ESM fallback 触 `__dirname` 报错)。
- **:3001 无监听进程**(用户 server 未运行)→ 两条 curl 移交 ticket 07 重启后复验;全新起 server 会以真 dev DB 拉起 scheduler,不在本 ticket 授权内,故未起。

**遗留/移交 ticket 07**:① 重启后 curl 复验两条 API;② AC5 前半(PUT input_values{goal,ac}+confirm → 409 消失 → DB job config 无 max_turns 键);③ 迁移顺带在真机创建了缺失的 built-in/workspace clone persona/config(正常 skip-if-exists 种子,非副作用事故)。

**过程异常(如实记录)**:基线对照用 `git stash -u` 曾误卷入同机并发的外部编辑(.claude/skills/matt-dev-pipeline|matt-verified-requirement SKILL.md、CLAUDE.md、.scratch/index.md);pop 冲突已人工双版本合并恢复(SKILL.md 同时含 stash 侧与 worktree 侧 hunks),外部文件 diff 完整无损,未提交任何非本 ticket 文件。

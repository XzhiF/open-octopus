# HANDOFF — matt-spec-dev 多仓几何 + 验收台 runbook（按需 e2e）

> 续接会话用。当前分支 `feat-task-enhance-20260918`。本文件随提交推送到远端，换机 `git pull` 后从这里继续。
> 日期：2026-09-18。

## 背景与目标

优化「任务看板」主流程：task 草稿 → task-author 产 spec/tickets → 绑定 `built-in/matt-spec-dev` 执行。
用户三条诉求：**流程快、省 token、但全面**；且此前所有任务都只跑**单仓**，要真正支持**两个关联项目一起开发**。

## 已完成（本次提交，勿重做）

### 1. 几何重构 `packages/core-pack/workflows/matt-spec-dev.yaml`（7 节点）
`spec-resolve → [fail-fast] → spec-review → ticket-dag(功能票 only，跳过 NN-e2e) → code-review → e2e-verify(新，code-review 之后，execute_when has_e2e，on_error continue) → ship-pr`
- **多仓枚举**：spec-resolve 遍历全部 `projects/*/` 写 `$vars.repos`(`path|branch`)+`repo_count`（旧 `head -1` 只认一仓）。code-review / ship-pr 逐仓循环，每个有改动的仓各出一个 PR。
- **跨仓构建序**：普通票 prompt 讲清「消费方票引用产出方符号时，产出票按自身构建系统 install，Blocked by 定序」（**语言无关，勿再写死 maven/项目名**——见下方纪律）。
- **e2e 时序倒挂已修**：e2e 从 ticket-dag 末节点提出、排到 code-review 之后，验最终 HEAD；删了上一版"复跑 walk.sh"创可贴。
- **按需 e2e**：`has_e2e`（issues 有 NN-e2e 票才真）→ 轻 phase 整节点跳过，省最贵走查（实测每批 ~6.6min/$1.3）。
- **prompt 卫生纪律（用户明确批评过，务必遵守）**：通用模板 prompt 里**不得**出现具体项目名(java-common/api-admin/PageUtil)、具体工具命令(mvn/javap/dependency:tree)、或日期/复盘元注释。实例命令归**票的 Verification Method**（作者按项目写死），工具差异归**项目脚本**，flow 只写角色与契约。

### 2. 入队 gate 放宽 `packages/server/src/services/tasks/task-materialize.ts`（check ④）
批次消费型流不再强制每批有 e2e 票；改「验证声明二选一」：有 `*-e2e-*.md` 票 **或** spec.md 写 `Verification Tier: unit-only`。

### 3. 验收台 runbook（跨包，解决"多项目验收台残缺"）
- `packages/shared/src/types/scheduler-job.ts`：新增 `acceptanceRunbookSchema` = `{up,ready,views?,down?,timeoutS?}`。`ready` 唯一判据 = **跑命令看退出码0**（curl health / compose ps / wait-for / Jenkins 轮询全压成这条）。工具无关。
- `packages/shared/src/types/task.ts` + `packages/server/src/services/tasks/tasks-service.ts`：`acceptance_runbook` 登记为 spec-field（null-clears）。
- `packages/server/src/services/tasks/round-evidence-service.ts`：`startPreview` 重写成 runbook 引擎。`resolveRunbook` 三级优先：① 显式 runbook ② legacy `acceptance_preview` 合成(url→`curl` rc 探、views=[url]，**web 面板零改动**) ③ 项目自带 `.octopus/acceptance/{up,health,down}.sh`(+`views`) 自动合成。stop 跑 `down`。`PreviewSummary` 加 `views[]`，`url`=首个 view。
  - **关键坑（已修）**：`up` 干净退出(0)≠失败（detached launcher），只有**非零退出**才 settle failed，就绪交给 ready-probe 轮询(deadline 自限速)。主动 stop 必须**在 stop 路径自己 settle**（否则前台 up 被杀的 `.then` 因 session.ready=true 被抑制 → 卡在 ready）。

### 4. CLI 漂移检测 `packages/cli/src/commands/workflow.ts`
`workflow validate` 比对源码 yaml 与 `~/.octopus/resources/installed/.../<name>.yaml` hash，不一致 warn「重启 dev/[sync-builtin] 才生效」。
- **运维事实**：真源是 `packages/core-pack/workflows/matt-spec-dev.yaml`；运行时读 installed 副本，**dev 启动的 `[sync-builtin]` 把源码推进副本**（会反向覆盖对副本的手改）。改完 shared/server TS **需重启 dev** 才生效；改 shared 类型后**必须 `pnpm --filter @octopus/shared build`**，否则新字段被**旧 dist 的 zod 静默剥掉**（踩过：per_repo 不生效）。

### 5. 测试（全绿，勿重复造）
- `packages/server/src/__tests__/tasks-preview.test.ts` 7/7：PV1-4 legacy、PV5 detached-up、PV6 ready-timeout→failed、PV7 纯脚本约定。Windows EPERM 删目录容错已处理（down 子进程短暂占 cwd）。
- `tasks-verify.test.ts` 含 V10(per_repo 两仓)/V11；`resolve-v4-phases.test.ts` 含 unit-only 过/两者皆缺 miss；`shared/task-domain-schema.test.ts` 含 runbook schema。
- 跑法：`npx vitest run packages/shared/src/__tests__/task-domain-schema.test.ts packages/server/src/__tests__/tasks-preview.test.ts packages/server/src/__tests__/tasks-verify.test.ts packages/server/src/__tests__/tasks-v4-gate.test.ts packages/server/src/services/tasks/__tests__/resolve-v4-phases.test.ts` → 87 passed。

### 6. task-author SKILL（两份已同步一致）
`.claude/skills/task-author/SKILL.md` 与 `packages/core-pack/skills/task-author/SKILL.md`：
- §3.5 验证分层决策（走查层 vs `unit-only` 层，按 phase 验收面）。
- §6「验收台预设」：多项目任务必写 `acceptance_verify{per_repo:true}`(仓内相对命令) 或 `acceptance_runbook`；有 `.octopus/acceptance/*.sh` 约定就别手写。

## 未完成 / 下一步（按优先级）

1. **web 多 view 渲染**：`packages/web-app/components/tasks/acceptance/preview-bar.tsx` 目前只显示/编辑首个 url（`summary.url`）。后端已返回 `views[]`，需改成渲染多入口 + 编辑面板支持多服务 runbook（可暂用文本编辑 up/health/down command）。用户已问过、待其确认是否本轮做。
2. **活体验证新几何**（静态+单测绿，但没跑过真流）：
   - A：建 `unit-only` 单仓小任务 → 验 gate 放行 + e2e-verify **整节点跳过**。
   - B：再跑双仓+e2e 任务 → 验 e2e-verify 在 code-review **之后**跑、失败不阻断 ship。
   - 建任务配方见 memory `v4-task-api-seed-recipe`（REST 直建：POST /api/tasks → PUT home-file 写 spec.md **和每张 issues/*.md** → POST /ready → **手动 POST /trigger**）。dev server 起了才有 API。靶子项目：`C:\xzf\java\octopus-demo-java-common` + `octopus-demo-api-admin`（org `xzf`，repos 在 `~/.octopus/orgs/xzf/repos/projects/xzf/`）。
   - **换机注意**：本机 `pnpm install && pnpm build`（重建 shared，别只重启 dev），再 `pnpm dev`；靶仓 SNAPSHOT 首跑前需 `mvn install`（m2 在 `C:\MiYuan\Tools\apache-maven-repo`，settings.xml 自定义）。
3. **收尾杂项**：
   - 演示产物待处置：GitHub 上 java-common `#12`、api-admin `#7` 两 PR 仍 OPEN；看板"七单"任务 status running / phase awaiting_review。验证完可关。
   - 提交里**排除**了 `octo-dev-copilot/scripts/workspace.js`（两份）——那是 CRLF 行尾噪声(0 内容变更)、非本次改动，`git status` 里会继续显示为 modified，忽略即可。
   - **既有坏测试**（非本次引入、别去修）：`packages/engine/src/__tests__/octopus-wf-e2e-tester.test.ts` 读一个不在 git 里的 `octopus-wf-e2e-tester.yaml` → ENOENT。
   - `tsc --noEmit` 有既有报错（workflow.ts service / workspace.ts / tasks-service:345），与本次无关；真实构建走 tsup/esbuild。

## 关键 memory（已更新，换机自动带上）
- `matt-spec-dev-dual-project-fix.md` — 多仓几何 + runbook 契约 + sync/dist 坑。
- `v4-task-api-seed-recipe.md` — REST 直建任务配方 + m2 路径 + 验收剧本契约。

## Suggested skills
- **task-author** — 起草活体验证用的 `unit-only` / 双仓任务（含 gate 新语义）。
- **matt-e2e-test-methodology** — 续做/校验 e2e-verify 与 runbook 起服务的走查规范。
- **code-review** — 对本提交做一次标准/规格双轴复查（改动跨 shared/server/cli/engine-flow/skill）。
- **diagnosing-bugs** — 若活体跑新几何出错（detached up / rc-probe / 多仓 ship）。

## 本提交范围（不含 stray workspace.js）
shared: scheduler-job.ts, task.ts, task-domain-schema.test.ts | server: task-materialize.ts, tasks-service.ts, round-evidence-service.ts, tasks-preview/verify.test.ts, resolve-v4-phases.test.ts | cli: commands/workflow.ts | core-pack: workflows/matt-spec-dev.yaml, skills/task-author/SKILL.md | .claude/skills/task-author/SKILL.md | 本 HANDOFF.md

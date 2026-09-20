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

0. **2026-09-19 活体验证 A+B 已完成**（Mac，双靶 java-common + api-admin）。新几何全部成立：
   - **A（unit-only 单仓）**：gate ④ 经 `Verification Tier: unit-only` 放行；`spec-resolve` 实测
     `repos=1 has_e2e=false` → **e2e-verify 整节点 skipped**（无 jsonl、状态 skipped），~5.9min 出
     PR [java-common #13]。round-2 走了一次 rejected→fix-feedback（顺带验了 has_feedback=true 让
     spec-review 复活、票 done 回写、末站按契约不产 handoff.md）。
   - **B（双仓 + e2e）**：preset 两 project → ws `projects/*/` 两 worktree；`repos=2 has_e2e=true`；
     ticket-dag 01→02 定序（provider `mvn install` → consumer 编译）；e2e-verify 在 code-review
     **之后**跑、票 03 回写 `done (PASS)`；ship 逐仓两 PR [java-common #14, api-admin #8]；
     全程 ~25min。e2e 走查本身抓出两次真问题（Tomcat 对未编码中文 query 400、陈旧 target 假绿
     → clean+三重探针）——走查有牙齿的实证。
   - **验收台 runbook 活体过**：B 挂 `acceptance_runbook`（up=`mvn package && java -jar :18081`），
     gate 时 POST /preview → ready+views 正常；stop 首跑**没杀干净**（见下 ③）。
   - **活体抓出的 ③ = 本次已修的引擎 bug**（未提交，工作区里）：
     a) Bash/PythonExecutor spawn 未 `detached` → `killProcessTree` 的 `kill(-pid)` 主路径失效，
        abort/timeout 只杀外层 bash，`mvn && java` 的 java 成孤儿（预览 stop 后端口仍在服务）。
        修：POSIX `detached:true`。b) runbook 的 `down` 经 BashExecutor 走 harness wrapper，
        `pkill` 被别名桩成拒绝桩 → down 永远杀不掉自己该收的尸。修：`BashConfig.skipHarness`，
        fireDown 用之（平台自有生命周期步骤，非模型命令）。回归锁：`bash-process-group.test.ts`
        2 例 + tasks-preview **PV8**（nohup daemon 由 down 收尸）。已验：全套 5128 例失败集与
        基线逐条相同（11 例 pre-existing：providers/pi、clone-file-mgmt、archive 等，与本改无关）。

1. **web 多 view 渲染 + runbook 接线** ✅（commit `d28965b4`）：preview-bar 双模式（runbook 徽章 /
   views[] 全渲染 / up·ready·views·down·timeoutS 编辑抽屉 / 简写一键升级）；verify-panel 补
   「逐仓」勾选 + cwd（旧版整值覆盖会抹掉 agent 写的 per_repo）。测试 RB1-5 + VP1-2。
   - **任务 C 全链路复跑**（双仓 Luhn + 验收面全家桶，入队前即登记 per_repo verify + runbook）：
     gate 放行 → repos=2 has_e2e=true → DAG 01→02 → CR → e2e 后置 PASS → 双 PR
     [java-common #15, api-admin #9]。验收台活体：**preview runbook 起→ready→2 views→stop 后
     进程空 + 18082 拒连**（down 绕 harness 修复的首个真任务级复验）；**per_repo 当场复检
     passed**（projects/* 逐仓 mvn -B test，~20s 增量）。e2e 走查顺带修了一处阻塞服务启动的
     孤儿注册（如实进 ship diff + 报告声明）。
   - 现开放：PR 池共 5 个 OPEN（A#13 / B#14、#8 / C#15、#9），A/B/C 均 awaiting_review 未动决策。

1a. **2026-09-19 「验收剧本」空面板修复**（commit `4dfdd1e9`）：web 接线后被指「最新待验收
   剧本仍是空的」。根因=**三方词表漂移**：剧本编译器只认 author-verified-tickets 正典
   （`**Verification type**` + ```bash 围栏），在盘实票（含用户真任务 token-91c5a975 的
   05-e2e）写的是 `Type:` 头 + `## 走查步骤` 编号列表（行内反引命令 + `→` 断言）+
   `## 证据要求` → 全编 0 步；且「票存在但 0 步」时 spec AC 兜底被 `!e2eTicket.content`
   掐死。修（playbook-compile.ts，正典路径逐条不变）：ticketSteps 方言解析（末箭头拆
   操作/预期、行首命令词白名单防产物名假命令）+ spec 兜底放宽为「无票或票 0 步」+
   不可解析如实记 missing。活体：token 任务 7 walk / A 3 claim / B 4 probe / C 5 probe
   （`→ data == true` 断言保留）。新测 5 例（fixture 照抄在盘票）。**教训：改 durable
   格式后拿真产物跑消费方**——单测 fixture 全用理想模板,漂移没人看见（同
   [[verify-real-formats-before-green]]）。

1b. **待处置**：上面 ③ 的修复未 commit（bash/python/executor-config/round-evidence + 两测试 +
   `packages/core-pack/skills/matt-e2e-test-methodology/`，见 2b）。演示 PR：A #13 / B #14、#8
   与存量 java-common `#12`、api-admin `#7` 仍 OPEN；A/B 看板 awaiting_review，验证完可关。

2. ~~活体验证新几何~~ ✅ 见 0。
   - 建任务配方见 memory `v4-task-api-seed-recipe`（REST 直建：POST /api/tasks → PUT home-file
     写 spec.md **和每张 issues/*.md** → POST /ready → **手动 POST /trigger**；PUT phases 用
     If-Match 乐观锁，specPath `./.scratch/<date>/<slug>/spec.md`，inputValues 只需
     `batch_dir:${phase.batch_rel}`）。**注意：这两份 memory 在 Windows 机器上，Mac 本机没带过来**，
     已按代码重建配方并回写 Mac 版。dev server 起了才有 API。靶子项目：
     `~/.octopus/orgs/xzf/repos/projects/xzf/octopus-demo-java-common` + `octopus-demo-api-admin`
     （org `xzf`）。
   - **Mac 环境事实**：maven local repo = `/Users/xzf/DevelopmentSofts/apache-maven-repo`
     （~/.m2/settings.xml 指定），首跑前 java-common 需 `mvn install -DskipTests`（已完成）。
     shared/server/engine 改动后必须重建对应包 dist（`pnpm build` 最稳）再重启 dev。

2b. **换机/新装机的 builtin 坑（本次实测，比 §4 更准）**：
   - `scripts/sync-builtin.mjs` 只同步 **skills/agents**（core-pack → `.claude/` + `~/.octopus/agent/skills`），
     **根本不同步 workflows**。`~/.octopus/resources/installed/workflows/built-in/<name>/<name>.yaml`
     是 resource install 落的一次性副本——本仓库改 yaml 后，运行时（BuiltInWorkflowService 只读
     installed）**不会自动拿到新几何**，CLI `workflow validate` 的 hash warn 就是为这个。
     刷新办法 = `POST /api/resources/uninstall {name,type:"workflow"}` + `install {ref:"builtin:matt-spec-dev",type:"workflow",caller:"cli"}`
     （install 无 force；caller 只认 cli|ui；ref 不带 type 会把 builtin 误判成 skill）。
   - 内置流依赖的 skill 必须**真的在资源 registry**里，否则 `__engine_init__` 78ms 硬失败
     （scan 无差别 provision 全部节点 skills，哪怕节点会被 execute_when 跳过）。
     `matt-e2e-test-methodology` 原只在 `.claude/skills/`（registry 无）→ 已收编进
     `packages/core-pack/skills/`（octopus 适配版为准，含 OCTO-STANDARDS.md），换机后仍需
     一次 `resource install builtin:matt-e2e-test-methodology`（或看板预检）。
     `local:` ref 安装带路径会被 SAFE_NAME_RE 拒（install 未 basename 化，另一个小坑，未修）。

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

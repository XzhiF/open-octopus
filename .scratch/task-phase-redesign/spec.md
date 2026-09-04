# Spec: 任务看板 Phase 化重构（task-phase-redesign）

## Problem Statement

看板任务从「草稿」到「工作空间执行」的衔接是断的：草稿期产物（spec/adr/issues）传不进工作空间（只有 `${goal}/${ac}` 两个文本占位符越界）；执行产物不回看板且随 workspace 删除即丢；goal 模式判定外包 CLI 黑盒、未达成可静默伪装成功；技能组×preset×产物格式三方错位，选工作流卡顿闪屏；大需求只能一次性跑完，人无法按里程碑验收放行。

## Solution

把任务收敛为「四层契约」：生成端自由（内置升级版 spec agent，matt 惯例产物）、入口契约固定（task home = manifest + `phases[]`）、执行端自由（per-phase workflow）、出口契约固定（归档合并）。大需求拆成多个 **Phase**（每个 1~1.5h 可交付产品状态），一个任务一个 workspace 一条分支，每 Phase 一次执行、一道人工**验收 Gate**，打回产生可追溯 **Round**；末 Phase 通过后产物（.scratch/ADR/CONTEXT.md）归并回各 project。

## Projects Involved

- [x] octopus monorepo（唯一仓库；跨 package：shared / server / web-app / core-pack。engine 零改动——执行模型靠现有 executions 表与唯一索引）

## Feature Scope

**Do：** v4 任务模型（phases 进 task_spec JSON）、`task_phase_acceptances` 表、executions 加 phase/round 列、tasks 加 workspace_id、同 ws 多执行复用、seed/collect 产物单向环、v4 gate、验收/打回/重试 API 与三栏界面、phase 时间线五列看板、auto_advance、跨 phase 决策传播（影响清单）、归档合并（ADR 顺延/CONTEXT append/归档 commit）、升级版 task-author SKILL.md + 内置 matt 技能族、Bash 写锁补齐、built-in 工作流列表缓存、v3 存量读时派生兼容。

**Don't：** task_dispatch/composition 多 workspace 演进、generic 任务改造、运行中 chat 介入（intervention）、旧草稿一键升级 v4、task token 用量统计（下次设计）、goal 模式引擎能力改造（保留但无看板入口）。

## Key Decisions

| # | Decision | Conclusion | Reason |
|---|---------|-----------|--------|
| K1 | Phase 本体 | 1 phase = 1 spec（范围+票+验收方式）+ 1 workflow_ref + ≥1 round；phase↔slug 恒 1:1 | 业务里程碑命名权给人，比 DAG 拓扑分层可解释 |
| K2 | 拆分预算 | 每 phase 以「可交付产品状态」收尾，coding agent 1h（含 E2E ≤1.5h）；3~5 人天需求≈4~5 phase | 预算=拆分期约束；运行期超预算仅 advisory 徽标（D18） |
| K3 | 状态模型 | task `draft→ready→running⇄awaiting_review→archiving→done`(+aborted)，**无 task 级 failed**；失败归 round 层；task 状态只镜像人的决定 | 成功/失败后人的动作同质（看→放行/重试/中止）；派生不存=无镜像竞态（#54 病根） |
| K4 | 数据最小面 | Phase 定义进 `task_spec.phases[]`（JSON；wire 字段 camelCase：specPath/workflowRef/inputValues——与 SDK 属性命名对齐，task_spec 遗留 snake 字段不改名、两代并存有界，review ③ 调和记录）；Round=executions 行+`phase_index/round_index` 列；唯一新表 `task_phase_acceptances`；tasks 加 `workspace_id` | 复用 spec-field/SSE/乐观锁/快照四套现成链路（票 06 证实 agent 按快照协议读） |
| K5 | 调度 | 一 task 一 schedule 信封；每 round=信封下新 execution；现有 active 唯一索引天然强制串行 | 零额外并发代码 |
| K6 | 流转驱动 | 首 phase 人工触发；验收通过→下一 phase 自动开跑（`auto_advance` 默认开）；重试永远人工发起；末验收→archiving→done | 验收即授权；人工点击=天然防无限循环（Round 无上限，D13④） |
| K7 | 打回模型 | 人只写反馈→agent 判严重度推荐「通用修复流」或「round-2 spec」→人一键确认；反馈产物化为 `fix-feedback-rN.md` | 判断归 agent、开跑授权归人 |
| K8 | 决策传播锚点 | 挂 spec-r2 事件非打回事件；「重大决策」机械化= Key Decisions 表行 diff（rN 保持行/编号稳定，新增标 `NEW-rN`）；影响清单+workflow 重估并进打回弹窗同屏批准 | 比对表格不比对散文，机器可判 |
| K9 | 产物环 | seed 下行=round 开跑物理拷贝 home→ws `.scratch/<YYYYMMDD>/<slug>/`（home 是 spec 权威源）；collect 上行=终态回收执行侧改动+emit SSE；每类文件单写者单方向 | 拷贝=git-able 随 PR 免费进仓库；单写者=无 merge |
| K10 | Batch 目录 | `.scratch/<YYYYMMDD>/<slug-N>/` 同 date 前缀=同需求批次；task home 镜像 project 同构布局（`docs/adr/`、`context-notes.md` per-project 存放） | 归并=同相对路径拷贝规则，无映射表 |
| K11 | 归档面 | 只回写草稿期独有件：ADR 扫目标仓库最大编号顺延、CONTEXT 术语 append-only、冲突词条进 PR 描述由 review 裁决；每 project 归档 commit `chore(archive): <task> syncback <date>` | done 的判定含 git 成功；人工冲突不阻塞状态机 |
| K12 | ws 生命周期 | 首次 trigger 建 ws+绑 task；同名 rmSync 覆写改报错；task-origin ws 豁免 retention 直至 done | 票 03 暗雷清单直接排雷 |
| K13 | 退场方式 | skill_groups/preset catalog/task 级 goal/ac **停用不物理删**；`task_spec.format:"v4"` flag 三处分叉（gate/物化/UI）；generic/composite 走旧链 | 存量+两条共享链路（assist/composite 吃 goal）零破坏（票 09） |
| K14 | 验收界面 | 三栏证据面=执行摘要(用时/token/cost)|产物核对(.scratch+issues done/skip)|动作区；预算 1 分钟决策成本 | 撑得过 5 个 phase 的仪式 |
| K15 | 内置技能组 | matt 技能族拷入 `~/.octopus/agent/built-in/task-author/skills/`（plugin 扫描零代码）；TemplatePicker 去技能组勾选 | 票 06：读 project 领域模型四要素今天全就位 |
| K16 | 冻结策略 | 不发明锁：编辑只在 home（对话+乐观锁），pending/awaiting_review 可改，running 编辑下一 round seed 生效。**信封冻结边界（cycle-2 调和）**：入队物化的信封是 dispatch/seed/collect 权威读源——running 中生效=home 批次目录文件内容（目录级 seed 自然带 spec-rN）+ autoAdvance/goal/ac（acceptance 活读）；不生效=phases[] 结构/绑定（改 pending phase 的 workflowRef/inputValues 不执行、新增 phase 到 advance 才 409）；format/phases 有创建锁（剥离→400/409 不可 brick）。信封 resync=v4.1 | 单向快照下行天然隔离 |
| K17 | 安全补齐 | path guard 补 Bash 重定向拦截（草稿会话写锁覆盖所有写通道） | 票 06 发现的写锁缺口 |

## Execution Decisions

<!-- 出口批量一问已裁决；matt-dev-pipeline 消费，缺行才重问 -->
| # | Decision | Choice | Reason |
|---|----------|--------|--------|
| 1 | Story Walk-Through | skipped (user decision) | map+11 票全程留痕，用户认为决策链已互证 |
| 2 | E2E Verification (pipeline Phase 4) | run (user decision) | 价值主张全在看板交互，静态审不足 |
| 3 | Ticket Execution Mode | sub-agent-concurrent | 14 票跨 shared/server/web/core-pack 多包，DAG 分层并发 |

## User Stories

1. 作为用户，我新建 coding 任务时不再勾选技能组，直接进入内置 spec agent（matt 套件）对话起草。
2. 作为用户，agent 起草时读取所选 projects 的 CONTEXT-MAP/CONTEXT.md/docs/adr/.scratch 惯例（缺惯例文件时 probe 降级并在 brief 标注「无领域文档 project」）。
3. 作为用户，多模块需求在草稿出口收到**拆分确认卡**：phase 序表（名字/范围/票归属/预算），批准前不能绑定与入队。
4. 作为用户，agent 对每个 phase 推荐 workflow（目录浏览 built-in 清单 + input_values 表单），我逐 phase 确认绑定。
5. 作为用户，入队 gate 只校验：phases≥1 ∧ 每 phase spec 文件存在 ∧ 每 phase workflow_ref 可解析 ∧ required inputs 非空；不再出现 goal/ac/双确认。
6. 作为用户，ready 卡片我手动触发首 phase（立即/定时）。
7. 作为用户，卡片角标显示 `Phase i/n · Round m`，点开见 phase 时间线（每 phase：名/状态/workflow/round 史）。
8. 作为用户，任一 round 执行到达终态（无论成败）任务进「待验收」列；失败不是红死状态而是「待处理」。
9. 作为用户，验收三栏：执行摘要 / 产物核对（点开看全文）/ 动作区（通过·打回·中止）。
10. 作为用户，打回必填反馈文本；随后 agent 推荐修复流或 round-2 spec，我一键确认，新 round 在**同一 worktree/分支**开跑。
11. 作为用户，auto_advance 关闭后每个 phase 都停 my gate（手动起）。
12. 作为用户，若打回的反馈导致决策变更，我在同一弹窗看到影响清单（后续 phase spec 连带修订 + workflow 重估建议），批准后系统改写 phases 与 spec 文件。
13. 作为用户，看板产物区实时反映 seed/collect 结果（SSE 推送），ws 被清理不再丢产物。
14. 作为用户，末 phase 验收通过→自动归档：project 仓库出现顺延编号的 ADR、append 的术语、`.scratch/<date>/` batch 产物（随 PR）、归档 commit；全绿后任务 done。
15. 作为用户，归档 git 失败任务停 archiving 可重试，不假 done。
16. 作为用户，v3 存量任务照常跑完并在时间线上以 legacy 单 phase 呈现。
17. 作为用户，运行超 1.5h 的 round 卡片显示 ⏳ 超预算徽标（advisory）。
18. 作为 agent（执行侧），我在 ws 里读到 `.scratch/<date>/<slug-N>/spec*.md + issues/` 作为唯一输入，并把 issues Status 更新与报告写回同目录。
19. 作为 agent（草稿侧），我按 spec-field 协议把 phases[]、decisions、projects 写入 task_spec，快照落 spec.json。
20. 作为平台，草稿会话任何写通道（含 Bash 重定向）都被锁死在 task home。

## Implementation Decisions

**shared**：`taskSpecSchema` 加 `format?: "v4"`、`phases?: TaskPhase[]`、`autoAdvance?: boolean`；goal/ac/confirmed 转 optional（v3/generic 兼容）。`TaskPhase = { index, name, slug, specPath, workflowRef, inputValues }`（Zod 单源，前端类型派生——契约测试守）。

**server/db**：新表 `task_phase_acceptances(id, task_id, phase_index, round_index, decision CHECK accepted|rejected, feedback, decided_at)`；`executions` 加 `phase_index, round_index INTEGER NULL`；`tasks` 加 `workspace_id TEXT NULL`。DAO：acceptance-dao（append-only，无 UPDATE）、task-dao 扩列。

**server/tasks-service**：① `readyTask` gate 按 format 分叉（v3 原 6 项保留；v4=K13 四项，missing key 格式 `phase:<i>:<why>`）；② 新端点 `POST /:id/acceptance` `{phase_index, round_index, decision, feedback?}` → 写账本 → 派生 →（accepted ∧ autoAdvance ∧ i<n）dispatchNextPhase /（accepted ∧ i=n）进 archiving；③ 状态派生纯函数 `deriveTaskView(task, executions, acceptances)`（唯一真相，单测参数化）；④ v4 materialize：per-phase WorkflowConfig 物化（input_values 占位符新词表 `${phase.slug}` `${phase.spec_dir}` `${task.home}` `${task_artifacts_dir}`），`resolveInputValues` 扩展；⑤ dispatch 入口 `dispatchPhaseRound(task, phaseIdx, roundIdx, feedback?)`——查 `tasks.workspace_id` 有则复用（票 03 清单 #1/#7 写法）。

**server/executor 周边**：seed 步骤与 collect 步骤挂在 dispatch/终态回调（照 copyTaskWorkflowsToWs 先例）；collect 后 emit `TASK_ARTIFACTS_UPDATE_EVENT`（补调研断链）；ws 同名冲突 rmSync→报错（#3）；task-origin ws retention 豁免条件=未 done（#5）；abortTask 'cleaned' 标记对齐"可复用"（#6）。

**server/archiving**：orchestrator（async）：读 home `docs/adr/` + `context-notes.md` per-project → worktree 内扫编号顺延改写 → 术语 append（冲突只列不并）→ commit/push → 并入开放 PR 或开归档 PR → 全成功才 done；任一步失败停 archiving，`POST /:id/archive/retry` 幂等续跑（从 project 粒度续）。借力 workspace.delete 前 archive-gate 卡口（票 03 #8）。

**server/clone 层**：matt 技能族入 `built-in/task-author/skills/`（安装脚本/seed）；`buildPathGuard` 补 Bash 写检测（`>`/`>>`/`tee`/`git --git-dir` 类重定向白名单：仅 task home 与 /tmp）；context.md 增加 per-project 路径+惯例 probe 指引。

**server/builtin-workflow**：list/detail 内存缓存（mtime 失效）——顺带根治调研 S1/S4 卡顿（票 09 决议：preset 退役后目录浏览是 phase 绑定唯一数据源，性能必须达标）。

**web**：TemplatePicker 去技能组/preset（type=coding 直通 task-author）；新列「待验收」（琥珀高亮）；卡片角标+phase 时间线；验收三栏 modal（复用 TaskAiUsageCard/ArtifactViewerDialog）；打回弹窗（反馈必填 + agent round 形态推荐卡 + 影响清单勾选区，`spec_field_update`/新 SSE `phase_status_update` 驱动）；WorkflowBindingDialog 改 built-in 数据源并修 S2（`skillGroups` 依赖稳定化）/S5（保存前重取 version）。v3 legacy 卡片走派生渲染。

**core-pack**：`task-author/SKILL.md` 重写（保 curl/API 骨架；9 字段→phases 协议；新增四章：领域阅读流程+惯例 probe 降级、拆 phase 方法论（deliverable 判据/预算/决策表行稳定纪律）、matt 族产物协议（Batch 目录+rN 命名）、拆分确认 gate+per-phase 绑定）；新内置工作流 `task-fix.yaml`（通用修复流：读 slug 目录+feedback 文件→定点修→报告）；task-dev/superpowers-task-dev 失去看板入口保留文件（manual only）。

## Data Model Changes

| Table | Operation | Details |
|-------|-----------|---------|
| task_phase_acceptances | CREATE | append-only；index(task_id, phase_index) |
| executions | ALTER | + phase_index, round_index（NULL=v3/generic） |
| tasks | ALTER | + workspace_id（NULL=未首触） |
| task_spec（JSON 列） | SCHEMA | + format/phases[]/autoAdvance；goal/ac→optional |

## API Contracts

| Method | Path | Params | Response | Notes |
|--------|------|--------|----------|-------|
| POST | /api/tasks | v4 payload（format:"v4"） | TaskDTO | goal/ac 不再必填 |
| POST | /api/tasks/:id/spec-field | field=phases 等 | TaskDTO | 复用乐观锁+SSE |
| POST | /api/tasks/:id/acceptance | {phase_index, round_index, decision, feedback?} | {task, next_action} | 409：非 awaiting_review / round 不匹配 |
| POST | /api/tasks/:id/trigger | 不变 | — | v4=触发 phase1 |
| POST | /api/tasks/:id/archive/retry | — | 202 | 仅 archiving |
| GET | /api/tasks/:id | 增 phases 视图（派生状态+账本） | — | |
| GET | /api/workflows/built-in | 不变 | — | 加缓存（性能 AC-19） |
| SSE | /api/tasks/events | 新事件 `phase_status_update`；artifacts 事件在 collect 时发射 | — | |

## Verification Strategy

### Verification Environment
| Item | Value |
|------|-------|
| 环境 | 本地 `pnpm dev`（server:3001 web:3000） |
| 数据库 | 测试用 tmp SQLite fixture（vitest workspace project） |
| git | 本地 bare-repo fixture 充当 project 仓库（双 project 场景） |
| UI | Playwright（复用 e2e/helpers/task-domain-helpers.ts 模式） |

### Test Users & Data
admin 账号；task fixture 用 `E2E_TEST_` 前缀标题；fs 断言全部落 tmp dir（测后 rm）；DB 测后 DELETE；预算阈值 env 可调（`OCTOPUS_PHASE_BUDGET_MS`，测试注入 1s 验 ⏳ 徽标）。

### AC to Verification Method Mapping
| US# | AC | Verification |
|-----|-----|-------------|
| 1,15(K13) | AC-01 schema 双轨；AC-16 legacy 呈现 | zod 单测 + server 集成 + e2e 回归 |
| 2,3,4 | AC-17 内置技能族加载；AC-02 gate 四项 missing key 精确断言 | 集成（plugins 目录断言）+ e2e（拆分确认卡） |
| 5,6 | AC-02；AC-03 一封套/串行唯一索引拒绝并行触发 | server 集成 |
| 7,8 | AC-04 ws 复用（次数=1、目录存活）；AC-09 派生表参数化（failed→awaiting_review） | 集成 + vitest 单测 |
| 9,11 | AC-13 三栏动作；AC-15 auto_advance 关=停 gate | browser E2E |
| 10 | AC-08 打回链（rejected 行+round+1+fix-feedback-rN.md+同 worktree） | 集成 + e2e |
| 12 | AC-14 影响清单批准→home spec 变更+phases version bump | e2e+集成 |
| 13 | AC-05 seed 覆盖规则；AC-06 collect+SSE 到达；AC-20 写权分离不互踩 | 集成（fs 断言） |
| 14 | AC-10 归档全绿（ADR 顺延 0004 起、append commit msg 正则、双 project 各自落地）→done | git fixture 集成 |
| — | AC-11 冲突术语不覆盖进 PR 描述 | 集成 |
| 17 | AC-18 env 缩阈值→⏳ 徽标 | e2e |
| 20 | AC-19 Bash 重定向被拦 | 集成（hook 单测） |
| 性能 | AC-20 built-in list 二次请求命中缓存（无 parse 计数）；BindingDialog 打开期间 fetch 次数=1 | 集成 + e2e（网络计数断言） |

### Verification Methods Detail
- **单元**：`deriveTaskView` 全状态表（含 6 项不变量断言：task 永不为 failed 等）；ADR 顺延纯函数；占位符解析器 v4 词表。
- **集成（vitest+真 DB+真 fs tmp）**：gate/acceptance/dispatch/seed/collect/archiving 幂等重试。
- **Browser E2E**：五列流转「新建→对话产物（stub）→确认拆分→绑 workflow→入队→触发→待验收→打回→round2→通过→…→archiving→done」全程一条主故事 + 验收三栏/影响清单两条支线。
- **契约**：TaskPhase Zod ↔ 前端类型快照对比测试。
- 反假跑 R1-R8 全部适用（真实 server、断 DB+文件双真相、登录取 token、E2E_TEST_ 隔离）。

### Prerequisites
- [ ] pnpm build 全绿（vitest.workspace.ts 各 project 可跑）
- [ ] 测试环境 git fixture 脚本（`e2e/helpers/` 新增 make-bare-repo）
- [x] 预算阈值 env：落地名为 web 侧 `NEXT_PUBLIC_PHASE_BUDGET_MS`（编译期注入，票 11 e2e 已用 1s 验证 ⏳ 徽标；server 侧 `OCTOPUS_PHASE_BUDGET_MS` 不发明——判定是展示逻辑，归 web。review 后 spec 调和）

## Risks & Notes

- R1: 改造面大（server 域模型+web 两块+skill 重写），票间依赖串行度高——issues DAG 按「schema→表→service→API→UI→skill→归档」排。
- R2: 验收账本与乐观锁并发窗口（acceptance 写新表不 bump version，但 agent 同时写 spec-field 可能交错）——deriveTaskView 幂等派生兜底，集成测试模拟并发。
- R3: 归档 PR 编排（多 project 各自 push/PR）是最易碎环节——archiving 状态可重试已设计，实现时 project 粒度续跑。
- R4: SKILL.md 重写质量决定拆分体验（预算感、决策表纪律），无法全自动验证——e2e 用 stub 产物，真实质量靠上线后 skill-evolution 回路。
- R5: v3 共存期长尾（generic/composite 仍吃 goal/ac），退场只做第二次。

## Glossary

Phase / Round / 验收 Gate / Batch 目录 / 归并回写 — 定义已入 [CONTEXT-MAP.md](../../CONTEXT-MAP.md) 系统词表（本 feature 澄清期落账）。

## Appendix: Core User Stories

（Story Walk-Through 若执行，traces 回填此处）

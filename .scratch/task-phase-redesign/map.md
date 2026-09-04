# Map: task-phase-redesign — 任务看板 Phase 化重构

## Destination

看板 coding 任务 = 内置升级版 spec agent（读各 involved project 的 CONTEXT.md/ADR/.scratch 做领域决策，在 task 空间产出 matt 标准产物），需求拆成多 Phase——**每个 Phase 以 1~1.5h coding-agent 可交付的产品状态收尾（3~5 人天需求 ≈ 4~5 个 phase，拆分的 deliverable 性即拆分能力的考验）**；每 Phase 一份独立 spec + 一个 workflow_ref，在同一 workspace 内执行、一道人工验收 Gate（打回产生可追溯 Round），末 Phase 通过后产物（.scratch + ADR + CONTEXT.md）归并回写各 project。技能组选择、preset catalog、goal/ac 字段机制退场。

## Notes

- 领域术语已入 CONTEXT-MAP.md：Phase / Round / 验收 Gate / Batch 目录 / 归并回写
- **ADR 冲突预告**：本设计 supersede ADR-0010（per-task plugin 目录）、ADR-0013（HOW-handoff / workflow 解析集）；ADR-0011（task home）保留但目录职责扩展
- 前次调研已证实的现状断链（产物零衔接 / 执行期不推送 / composite ac 断供 / 卡顿 S1-S7 / goal R1-R8）——本重构多数直接绕过或根治
- goal 模式（/goal 原生适配器）失去唯一入口 general-dev preset，去向见票 09
- 产物惯例沿用 matt：spec.md 结构、issues/ 票格式（Status: ready-for-agent/in-progress/done/skip）、brief.md、index.md；Batch 布局 `.scratch/<YYYYMMDD>/<phase-slug>/`
- 相关代码锚点见各票内引用（tasks-service.ts:1006 gate / scheduler-service.ts:195 物化 / workflow-executor.ts:31 seed 点 / workspace.ts:315 createFromSpec / composition-task.yaml）

## Decisions so far

- [01](decisions/01-phase-state-machine.md) resolved — 见 D9/D10/D11
- D1 · Phase 定义：1 phase = 1 spec（范围+票+验收方式）+ 1 workflow_ref；phase 间必须"能正常运行"再迭代
- D2 · per-phase workflow_ref：可相同可不同，决定于各 phase spec 怎么写
- D3 · 打回模型：task chat 内反馈→产生正式产物→同 worktree 新 Round（通用修复流 或 round-2 spec 再执行，保持灵活）；每 Round 独立执行记录
- D4 · 重大决策传播：打回轮可连带同步修改后续 phase 的 spec（机制见票 05）
- D5 · Batch 目录：`.scratch/<YYYYMMDD>/<slug-N>/` 标识同需求批次；进 phase 时同步对应 slug 产物入 workspace
- D6 · 归并回写：末 phase 验收通过后，产物合并回各 involved project（机制见票 08，完成时"预留归档"）
- D7 · 退场清单：skill_groups、preset catalog、task_spec.goal、task_spec.ac 全部取消——"都在 spec 以及其他产物里了"（影响面见票 09）
- [09](decisions/09-retire-impact.md) resolved — 四机制**不能物理删除**：schema 转 optional + gate 按 task_type 分叉。隐藏耦合：composite 的 moa topic 吃 goal（workflow-executor.ts:720）、assist 三工作流入参链靠 goal+ac（assist-workflow-service.ts:537）、ws 展示名从 spec.goal 生成（task-ws-name.ts:24）。CreateTaskInput.preset（模板预选）与 workflow-preset 无关勿误删；phase 绑 workflow 的目录浏览改吃 built-in 清单；引擎 goal: 节点能力与 task 域入口正交，可保留。测试爆炸半径已量化
- D8 · Out of scope：task_dispatch 多 workspace 复合并行、generic 普通任务、task token 用量统计（下次设计）
- D9 · 状态模型（票01 Q1.1 裁决 A）：task 无 failed 终态（终态仅 done/aborted）；失败归 Round 层；`awaiting_review` 为唯一人工卡点（放行/重试/中止），task 状态只镜像人的决定不镜像执行状态。task: draft→ready→running→awaiting_review→…→done；phase: pending→running→awaiting_review→accepted；round: running→succeeded/failed。看板列：草稿/待执行/执行中(Phase i/n)/待验收/完成
- D10 · phase 流转驱动（票01 Q1.2 裁决 A，四条全收）：① 首 phase 人工触发（保留 ready→trigger/定时）② 后续 phase 验收通过自动开跑，task 级 `auto_advance` 开关默认开 ③ 重试永远人工发起（打回/失败后人在 Gate 附反馈开新 Round，绝不自动重试）④ 末 phase 验收通过 → task 进 `archiving`（触发票08合并）→ 成功才 done，失败停 archiving 可重试。task 状态全集：draft→ready→running⇄awaiting_review→archiving→done（+aborted）
- D11 · 看板形态与 gate（票01 Q1.3 裁决 A）：卡片角标 `Phase i/n · Round m` + phase 时间线（每 phase 一行：名+状态+workflow+round 历史）；验收界面三栏证据面=执行摘要(用时/token/cost)|产物核对(.scratch 列表+issues done/skip)|动作区；coding-v4 gate 换成 phase 完备性四项，goal/ac/双确认停用
- D12 · 数据模型（票02 裁决 A · 最小新增面）：Phase 定义进 `task_spec.phases[]`（JSON：index/name/slug/spec_path/workflow_ref/input_values；status 不落库、service 派生）；Round = executions 行加 phase_index/round_index 列；**唯一新表** `task_phase_acceptances`（append-only 人工决定账本：accepted 行=phase 通过、rejected 行序列=打回史）；tasks 加 workspace_id；一 task 一 schedule 信封（现有 active-唯一索引天然串行）；task 级 workflow_ref 对 coding 停用留列给 generic
- D13 · Round 语义（票04 裁决 A）：① 打回→agent 按反馈判严重度推荐 round 形态（通用修复流=产 fix-report 不产 spec / round-2 spec=产 spec-r2.md 再执行原 workflow），人一键确认 ② 产物同 phase slug 目录内迭代（phase↔slug 恒 1:1），spec.md 冻结首版 + spec-rN.md 并存，issues 原位增量 ③ 验收 per-round 执行、per-phase 记账（accepted 行挂 round_index 溯源）④ Round 无上限=状态机不变量（每 round 必人工发起，不设计数器）⑤ 运行中 chat 介入 out of scope（已记入 Out of scope）
- D14 · 跨 phase 传播（票05 裁决 A）：挂 spec-r2 事件非打回事件（修复流不传播）；「重大决策」机械化=Key Decisions 表行 diff，rN 修订保持行/编号稳定（新增标 NEW-rN）；影响清单并进打回弹窗同屏批准，agent 直改后续 spec+phases[] JSON；命中 phase 的 workflow 重估建议同卡
- D15 · 产物单向环（票07 裁决 A）：① task home 镜像 project 同构布局（`.scratch/<YYYYMMDD>/<slug-N>/` 零适配直落 + 待归并件 docs/adr、context-notes per-project 存放 + spec.json/artifacts.json 协议不动）② seed 下行=round 开跑时物理拷贝（非 symlink，git-able 随 PR 进仓库；home 是 spec 权威源覆盖 ws 同名）③ collect 上行=round 终态回收执行侧改动（issues Status/报告）回 home + emit task_artifacts_update ④ 每类文件单写者单方向→无双向 merge ⑤ 代码/产物连续性=同分支+batch 同居 ⑥ Bash 写锁缺口本版补（子项）
- D16 · 归档合并（票08 裁决 A）：归并面收窄=只回写 task home 草稿期独有件（docs/adr 顺延重编号 + context-notes append-only，冲突词条进 PR 描述由 review 裁决）；.scratch/报告已随 phase PR 在仓库不搬；每 project 一个归档 commit 并入开放 PR 或开归档 PR；archiving 卡住仅限 git 失败；done ⇒ ws retention 豁免解除可回收
- D17 · 存量迁移（票10 裁决 A）：`task_spec.format:"v4"` flag 分叉（gate/物化/UI 三处），v3 六项 gate 原样保留；存量任务沿旧链路自然跑完零迁移，UI 读时派生 legacy 单 phase 时间线；v3 草稿 WorkflowBox 数据源切 built-in 清单；不提供旧→新升级（重聊）；composite/schedule 零改动；测试爆炸半径引用票 09
- D18 · 超预算语义（雾毕业，Q-F1 裁决 A）：预算=拆分期约束（agent 遵守）；运行期仅 advisory 徽标 `⏳ 超预算`，不打断不变态；想拆细=打回时反馈"拆成两个"，走 D14 编辑通道改 phases[]，无新机制
- D19 · 冻结策略（雾毕业，Q-F2 裁决 A）：不发明锁——spec 编辑只在 task home（对话+乐观锁），seed 单向快照下行，运行中天然隔离；规则：pending/awaiting_review 可改，running 的编辑下一 round seed 才生效
- [03](decisions/03-workspace-lifecycle.md) resolved — **同 ws 多执行是现成能力**（executions 1:N、手动执行与 chain 步骤两先例），唯一写死的是任务调度路径每次 trigger 新建 ws。改动面 9 项清单在票内。关键暗雷：ws 同名目录先 rmSync 再建（workspace.ts:325-329，常驻 ws 下=数据毁灭路径）、branch_prefix 含 scheduleId 会 phase 换支、retention max_retain 可能误删带未合并产物的 ws。ArchiveService 只归档 DB 快照不归档文件——票 08 产物合并无现成落点，但 workspace.delete 前的 archive-gate 是可借力卡口
- [06](decisions/06-spec-agent-domain-reading.md) resolved — 「读 project 领域模型」**今天已能做、零代码缺口**（cwd=task home、读全放行、context.md 已含 project 绝对路径、repos index 六行结构可 Glob）。matt 产物写相对路径 `./.scratch/` 天然落 task home（Batch 目录零适配）。写锁缺口：path guard 只拦 Write/Edit，**Bash 重定向不拦**（并入票 07）。SKILL.md「保骨架换心脏」：9 字段教学→phases 化、HOW-handoff→工作流目录浏览+per-phase 绑定；新增四章（领域阅读流程/拆 phase 方法论/matt 族协议/拆分确认 gate）。非 matt 惯例 project 需 probe 降级。拆分发生在 ready 前，状态机不需加态，"每 phase 有 spec.md"可做 gate 项

## Not yet specified

（已清空 — 全部雾已毕业为 D13⑤/D18/D19 或裁定 out of scope）

## Out of scope

- task_dispatch / composition 多 workspace 并行派发（保留现状，不演进）
- generic（普通）任务的草稿与执行链路
- Task 级 token 用量统计（下一次设计，预留 task 聚合口径的讨论）
- 运行中 Round 的 chat 介入 / intervention 注入（D13-⑤：本版运行中只读，反馈统一在 awaiting_review 输入）
- 全局资源库/skill 安装体系本身（只改 task 域对它的消费）

## Tickets

| # | 票 | 类型 | 状态 | Blocked by |
|---|----|------|------|-----------|
| 01 | [Phase 状态机与看板形态](decisions/01-phase-state-machine.md) | grilling | **resolved** | — |
| 02 | [Phase/Round 数据模型](decisions/02-phase-round-data-model.md) | grilling | **resolved** | — |
| 03 | [Workspace 与执行生命周期](decisions/03-workspace-lifecycle.md) | research | resolved | — |
| 04 | [Round 语义细则](decisions/04-round-semantics.md) | grilling | **resolved** | — |
| 05 | [重大决策跨 phase 传播](decisions/05-cross-phase-propagation.md) | grilling | **resolved** | — |
| 06 | [升级版 spec agent 领域阅读能力](decisions/06-spec-agent-domain-reading.md) | research | resolved | — |
| 07 | [产物布局与 per-phase 同步](decisions/07-artifact-layout-sync.md) | grilling | **resolved** | — |
| 08 | [归档 = 产物合并归位](decisions/08-archive-merge.md) | grilling | **resolved** | — |
| 09 | [skill_groups/preset/goal/ac 退场影响面](decisions/09-retire-impact.md) | research | resolved | — |
| 10 | [存量兼容与迁移](decisions/10-legacy-migration.md) | grilling | **resolved** | — |
| 11 | [验证策略（强制 gate）](decisions/11-grilling-verification-strategy.md) | grilling | **resolved** | — |

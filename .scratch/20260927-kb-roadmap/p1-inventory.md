# P-1 前提盘点 — KB 体系 ROI 判据数据弹药

> 生成时间: 2026-09-27 · 只读盘点，未改任何业务代码/数据库
> 数据源: ① dev 库 `~/.octopus/db/octopus.db`(+12 个兄弟库,全部 `mode=ro`) ② `~/.octopus/` 归档面 ③ 本仓 git 历史 + `.scratch/` 需求台账

---

## 0. 口径先行（读数前必读）

- **git 仓最早 commit 是 2026-06-25**（开源第一次提交），所以「近 6 个月」实际 = 建仓以来全部历史（663 commits，6/25–9/27）。
- **tasks 表只有 2026-08-25 起的 68 行**（v4 任务系统上线才建表），且其中 57 行是 E2E_TD/PROBE 测试残留 —— DB tasks 表**不能**代表半年工作量。
- 真正的全量「任务清单」是 **`.scratch/index.md` 55 条编号需求 + 16 个未编号目录**，以及 **78 条 git 分支**（本地+远端，去重约 61 个 feature 家族）。本报告以 .scratch 为主 population，DB 为辅助。
- 去重规则：`-r2/-r3`、`gap-fix` 视为同一 feature 家族的迭代（同类任务判据里迭代不应重复计权）。

---

## 1. 近 6 个月任务清单

### 1a. `.scratch` 需求台账（主清单，61 个 feature 家族）

| # | feature 家族 | 创建 | 分支 | 状态 | 人工确认 ✓/✗ |
|---|---|---|---|---|---|
| 1 | engine-init-and-event-optimization | 07-22 | feat/engine-init | done | |
| 2 | workflow-repair | 07-23 | feat-repiare-workflow | done | |
| 3 | agent-clone-system-refactor | 07-24 | feat-builit-in-engines | done | |
| 4 | clone-mgmt-enhancement | 07-24 | feat-agent-clone-ehancement | done | |
| 5 | workspace-scheduler-clone-chat | 07-25 | feat-agent-clone-optimze | done | |
| 6 | plugin-skill-discovery | 07-25 | feat-agent-clone-optimze | done | |
| 7 | clone-ui-redesign | 07-27 | feat/clone-ui-optimization | done | |
| 8 | main-agent-optimization | 07-29 | feat/main-agent-optimization | done | |
| 9 | memory-closed-loop | 07-29 | feat/main-agent-optimization | done | |
| 10 | clone-memory-alignment | 07-29 | feat/main-agent-optimization | done | |
| 11 | agent-config-completion | 07-29 | feat/main-agent-optimization | done | |
| 12 | agent-config-optimization | 07-29 | feat/main-agent-optimization | done | |
| 13 | safety-system-redesign | 07-30 | feat/main-agent-optimization | done | |
| 14 | workflow-simulator | 07-30 | feat/workflow-simulator | done | |
| 15 | workflow-simulator-v2 | 07-30 | feat/workflow-simulator | done | |
| 16 | workflow-test-optimization | 07-30 | feat/workflow-simulator | done | |
| 17 | simulator-outputs-and-real | 07-30 | feat/workflow-simulator | done | |
| 18 | interaction-node | 07-31 | feat/interaction-node | done | |
| 19 | chatbot-workflow-design | 08-01 | feat/interaction-node | done | |
| 20 | interaction-node-detail-fix | 08-01 | feat/interaction-node | done | |
| 21 | sub-workflow-node | 08-02 | feat/sub-workflow-node | done | |
| 22 | sub-workflow-node-r2 | 08-02 | feat/sub-workflow-node | done | |
| 23 | e2e-harness-system | 08-03 | feat/sub-workflow-node | done | |
| 24 | subworkflow-loop-nesting | 08-03 | feat/sub-workflow-node | done | |
| 25 | skill-workflow-dev-v2 | 08-03 | feat/skill-workflow-dev-v2 | done | |
| 26 | dynamic-sub-workflow | 08-03 | feat/dynamic-sub-workflow | done | |
| 27 | dynamic-sub-workflow-r2 | 08-03 | feat/dynamic-sub-workflow | done | |
| 28 | workflow-requires-effort | 08-03 | feat/workflow-requires-effort | done (PR #41) | |
| 29 | resource-module-enhancement | 08-04 | feat/resource-module-enhancement | done | |
| 30 | resource-module-enhancement-r2 | 08-04 | feat/resource-module-enhancement | done | |
| 31 | workflow-requires-clones-rules-commands | 08-04 | feat/workflow-requires-enhancement | done | |
| 32 | agent-workflow-integration | 08-04 | feat/agent-workflow-integration | done (PR #44) | |
| 33 | agent-workflow-integration-r2 | 08-05 | feat/agent-workflow-integration | done | |
| 34 | octopus-agent-ui-wiring | 08-05 | feat/agent-workflow-integration | done (PR #44) | |
| 35 | workflow-engine-harness | 08-05 | feat/workflow-engine-harness | done (PR #45) | |
| 36 | workflow-engine-harness-r2 | 08-05 | feat/workflow-engine-harness | done | |
| 37 | harness-gap-fix | 08-06 | feat/workflow-engine-harness | done | |
| 38 | harness-semantic-v2 | 08-06 | feat/workflow-engine-harness | done | |
| 39 | harness-semantic-v2-r2 | 08-06 | feat/workflow-engine-harness | done | |
| 40 | harness-learning-platform | 08-11 | feat/harness-learning-platform | in-progress | |
| 41 | workflow-observability | 08-12 | feat/workflow-observability | in-progress | |
| 42 | task-pool-redesign | 08-17 | test-task-board | done (PR #50) | |
| 43 | task-domain-redesign | 08-18 | feat/task-domain-redesign | done | |
| 44 | task-authoring-v3 | 08-18 | feat/task-domain-redesign | done (PR #51) | |
| 45 | task-authoring-v3-r2 | 08-18 | feat/task-domain-redesign | done | |
| 46 | task-workflow-handoff | 08-23 | feat/task-domain-redesign | done | |
| 47 | task-workflow-presets | 08-27 | feat/task-workflow-presets | done | |
| 48 | goal-task-dev | 08-28 | feat/goal-task-dev | done | |
| 49 | task-phase-redesign | 09-03 | feat/task-phase-redesign | done | |
| 50 | spec-driven-workflow | 09-05 | octopus-feat-v4-direct-create-ui | in-progress | |
| 51 | phase-handoff-chaining | 09-05 | octopus-feat-v4-direct-create-ui | done (ADR-0019) | |
| 52 | phase-splitting-methodology | 09-06 | octopus-feat-v4-direct-create-ui | in-progress (ADR-0020) | |
| 53 | draft-artifact-visibility | 09-06 | octopus-feat-v4-direct-create-ui | done | |
| 54 | task-scheduler-decouple | 09-09 | feat/scheduler-decouple | 待验收 (ADR-0021) | |
| 55 | task-exec-tree | 09-15 | octopus-feat-task-exec-tree | code-done·待重启 | |
| — | mattpocock-dev-expert | 07-17 | feat/mattpocock-dev-expert-grill | 未编号 | |
| — | harness-intercept-audit | 08-12 | feat/workflow-engine-harness | 未编号 | |
| — | debug-harness-delegation (mjs 脚本) | 08 | feat/workflow-engine-harness | 未编号·疑非任务 | |
| — | refactor-agent-routes | ~09 | — | 未编号 | |
| — | refactor-execution-lifecycle | ~09 | — | 未编号 | |
| — | exec-perf-timing | 09-15 | feat-exec-perf | 未编号 | |
| — | acceptance-playbook | ~09-17 | — | 未编号 | |
| — | 20260917-acceptance-playbook-proto | 09-17 | — | prototype | |
| — | 20260918-spec-dev-e2e-acceptance | 09-18 | — | prototype | |
| — | 20260919-console-ux-mock | 09-19 | — | prototype | |
| — | 20260919-feed-rounds-files-mock | 09-19 | — | prototype | |
| — | 20260920-verify-header-mock | 09-20 | — | prototype | |
| — | 20260927-kb-roadmap | 09-27 | feat-kb-p0-20260927 | 本盘点自身 | |
| — | research | — | — | 非任务（调研目录） | |

> 注：`.scratch` 未编号目录的 mtime 在 09-23 被批量 touch 过（原型迁移痕迹），日期以目录名前缀为准。

### 1b. DB tasks 表（68 行，仅 11 行未删除）

| 类别 | 行数 | 说明 |
|---|---|---|
| **真实任务（未删除）** | **11** | 见下表 |
| E2E_TD_* / PROBE_* / Untitled / 勿动 / tmp-modal-check 等测试残留 | 57 | 全部 created+deleted 在同一天内，人工确认列可直接整段 ✗ |

11 条真实任务：

| id 前 8 | 名称 | 状态 | 创建 | project_ids（仓库） | workflow_ref | 人工确认 ✓/✗ |
|---|---|---|---|---|---|---|
| eb93b74a | token计费 | aborted | 08-25 | open-octopus | built-in/task-dev | |
| b6b721cb | 继续 | aborted | 09-07 | open-octopus | — | |
| 91c5a975 | 我准备开发一个全局记录token的模块 | running | 09-08 | open-octopus | — | |
| b53929b0 | 活体验证A：MaskUtils 脱敏工具 (unit-only 单仓) | running | 09-19 | octopus-demo-java-common | — | |
| daee984f | 活体验证B：双仓截断链路 + e2e 走查 (matt-spec-dev) | running | 09-19 | demo-java-common + demo-api-admin (2仓) | — | |
| 5db37385 | 验收C：双仓 Luhn 校验链路 + 验收面全家桶 | running | 09-19 | demo-java-common + demo-api-admin (2仓) | — | |
| 13aec260 | 开发agentflow | draft | 09-23 | open-octopus | — | |
| fc71f62a | 开发agentflow (copy) | draft | 09-23 | open-octopus | — | |
| 9b1e8dd1 | 我想优化一下任务的归档操作 | draft | 09-24 | (空) | — | |
| 463b7bf7 | 优化workflow-node展示 | draft | 09-25 | open-octopus | — | |
| 04eb51c5 | 测试token | draft | 09-25 | open-octopus | — | |

### 1c. executions / workspaces（辅助面）

- executions 47 行（2026-08-07 → 09-19），根执行 32。workflow 分布：task-dev×10、matt-spec-dev×8，其余 test-*/intercept-test-*/e2e-* 全是自测。
- workspaces 19 行，其中 5 个是 task: 前缀的任务工作空间（对应 11 条真实任务），其余 14 个 test-*/demo*/t1-t3 手动测试。
- `~/.octopus/tasks/` 有 788 个任务目录，**777 个是孤儿**（不在任何 DB tasks 表里）——taskpool 清理（09-07 备份库 `pre-taskpool-cleanup-20260907-*` 佐证）遗留的目录壳，manifest spec 为空。这些不是任务证据，人工确认列直接 ✗。

---

## 2. 同类占比 — 机器预分类

对 61 个 feature 家族按 slug 关键词做规则聚类（优先级：harness/e2e → task → workflow → agent/clone → resource → UI → 知识归档 → 引擎基建）。**同一分支上的多条 .scratch 是不同需求不是同一任务**（这是最可靠的反向信号——分支≠任务），故按 slug 而非分支聚类。

| 簇 | 家族数 | 占比 | 成员（家族级，迭代已并） | 误判倾向 | 人工确认 ✓/✗ |
|---|---|---|---|---|---|
| A-任务域（task/phase/authoring/spec/draft） | 13 | 21.3% | task-domain-redesign, task-authoring-v3, task-pool-redesign, task-workflow-handoff, task-workflow-presets, goal-task-dev, task-phase-redesign, task-scheduler-decouple, task-exec-tree, phase-handoff-chaining, phase-splitting-methodology, spec-driven-workflow, draft-artifact-visibility | spec-driven-workflow 同时是工作流域（边界）；task-scheduler-decouple 一半是调度器基建 | |
| B-工作流域（workflow/simulator/interaction/sub-workflow） | 17 | 27.9% | workflow-repair, workflow-simulator(+v2), workflow-test-optimization, simulator-outputs-and-real, interaction-node(+detail-fix), chatbot-workflow-design, sub-workflow-node, subworkflow-loop-nesting, dynamic-sub-workflow, skill-workflow-dev-v2, workflow-requires-effort, workflow-requires-clones-rules-commands, agent-workflow-integration, workflow-observability, plugin-skill-discovery | agent-workflow-integration 跨 agent 域；workflow-simulator 4 条是同族不同需求还是同一需求拆写，需人判 | |
| C-agent分身域（agent/clone/memory/safety） | 12 | 19.7% | agent-clone-system-refactor, clone-mgmt-enhancement, clone-ui-redesign, main-agent-optimization, memory-closed-loop, clone-memory-alignment, agent-config-completion, agent-config-optimization, safety-system-redesign, octopus-agent-ui-wiring, refactor-agent-routes, workspace-scheduler-clone-chat | clone-ui-redesign / octopus-agent-ui-wiring 偏 UI；refactor-agent-routes 偏基建 | |
| D-测试harness（harness/e2e） | 7 | 11.5% | e2e-harness-system, workflow-engine-harness, harness-gap-fix, harness-semantic-v2, harness-learning-platform, harness-intercept-audit, 20260918-spec-dev-e2e-acceptance | gap-fix 是 workflow-engine-harness 的迭代，家族去重规则没拦住（人工应并为 1） | |
| G-知识归档（knowledge/kb/archive/acceptance） | 3 | 4.9% | acceptance-playbook, 20260917-acceptance-playbook-proto, 20260927-kb-roadmap | kb-roadmap 是本次盘点自身，应剔除 | |
| H-引擎基建 | 3 | 4.9% | engine-init-and-event-optimization, exec-perf-timing, refactor-execution-lifecycle | — | |
| E-资源域 | 1 | 1.6% | resource-module-enhancement | 孤簇 | |
| F-UI换肤（原型/散票） | 1 | 1.6% | 20260919-console-ux-mock（正式换肤票 memphis/dart/dark 只在分支无 .scratch 台账） | **系统性低估**：feat-dart-theme、feat-memphis-ui、ui-style-unify 等 UI 任务不入台账 | |
| Z-其他 | 3 | 4.9% | 20260919-feed-rounds-files-mock, 20260920-verify-header-mock, mattpocock-dev-expert | 原型/方法论调研 | |

**机器预估（两档读数）：**

| 读法 | 数值 | 对 30% 线 |
|---|---|---|
| ① 最大单簇（B-工作流域） | **27.9%** | 压线偏下 |
| ② 任务落在成员数 ≥3 的簇里的占比（A+B+C+D+G+H） | **90.2%**（55/61） | 远超 30% |
| ③ A+B 合并（承认"任务域+工作流域"本质同一条平台主线） | **49.2%** | 超过 30% |

> 两档数值方向相反，**定案权完全在人**：判据问的「同类任务」如果指"具体做法可复用的近重复任务"→ 读法①（不过线）；如果指"同一领域反复出现、经验可互相参照"→ 读法②③（稳过）。建议抽查下表 20 行后定。

---

## 3. 跨仓任务占比

| 口径 | 分子/分母 | 比例 | 依据 |
|---|---|---|---|
| DB 真实任务，project_ids ≥2 | 2/11 | **18.2%** | 仅活体验证B、验收C 双仓 |
| 同上，剔除验证夹具（B/C 是 fixture 仓上的新几何验证，非业务需求） | 0/9 | **0%** | |
| .scratch 61 个 feature 家族 | 0/61 | **0%** | 全部改 open-octopus monorepo 本身 |
| workspaces 的 projects/ 目录 ≥2 仓 | 2/22 | 9.1% | 同样是活体验证B/验收C |
| 归档面佐证 | — | — | org 注册 8 仓，但 5 个 octopus-demo-* 夹具仓最后提交停在 05-26/06-10，半年内真实改动只发生在 open-octopus（+ `octopus` fork 1063 commits，同源仓不算跨仓） |

> **monorepo 结构是跨仓占比的主因**：packages/ 下 7 个包同仓，KB 方案里的"跨仓拓扑"在当前工作方式下没有真实需求样本。若未来多产品仓接入，需重测。

---

## 4. experiences 表体检

| 指标 | 数值 |
|---|---|
| 主 dev 库 octopus.db | **0 条** |
| 全部 13 个 DB 合计 | **4 条**（harness-3376 和 agent-workflow-integration 两库各 2 条，同 schema 时代的旧行） |
| 带 execution 回链 | 0（旧 schema 连 execution_id/scope/source_type 列都没有） |
| scope 分布 | 无法统计（列缺失，默认 'agent' 语义未落库） |
| 内容质量 | 4 条全部是 `E2E_TEST:` 前缀的测试注入数据（07-28，octo-agent-debug skill） |
| FTS 索引 | experiences_fts 存在但全库空 |
| 归档面 | `~/.octopus/knowledge/` 仅 1 个 user_preference.md；orgs/xzf/knowledge/ 仅 projects/open-octopus.md 1 页 |

**P3 存量升级含义：存量 ≈ 0，quarantine 比例判定为 100%（4/4 全是测试垃圾，且 schema 过老不可迁移）。** 好消息是这也意味着 P3 没有存量包袱——体系是从零建起还是救存量，答案倾向于**从零建**。

---

## 5. 结论与人工抽查指引

### 数据侧建议

| 判据 | 机器预估 | 建议 |
|---|---|---|
| 同类占比 ≥30% | 读法① 27.9% / 读法② 90.2% / 读法③ 49.2% | **不定案**。三档全给，卡在人工对"同类"的定义上。数据侧唯一硬事实：A+B+C 三簇（任务/工作流/agent，42/61=68.9%）是同一群人在同一片领域反复做同型改造（redesign/v2/r2/gap-fix/phase 化高频复现），"领域内经验复用"的前提成立；但**跨领域的可迁移知识模式**没有证据 |
| 跨仓占比 ≥15% | 业务口径 0%，含夹具 18.2% | **建议降级拓扑层 → 仓库登记表**。唯一两条双仓任务是验证夹具，不代表真实需求；monorepo 结构下短期不会出现多仓需求流 |
| experiences 存量 | 0 条可用 | P3 从"存量升级"改为"零存量直建"，quarantine 无意义 |

### 必须人工抽查的 20 行（定案最小动作）

| # | 行 | 抽查问题 |
|---|---|---|
| 1-4 | A 簇：task-domain-redesign / task-phase-redesign / task-authoring-v3 / spec-driven-workflow | 这 4 个"任务域改造"互相之间，前一个的解法对后一个是可复用经验，还是每次都是推倒重想？——**决定读法②是否成立** |
| 5-8 | B 簇：sub-workflow-node / dynamic-sub-workflow / interaction-node / workflow-simulator | 同上，工作流节点族的四次"加节点类型"是否同型可模板化？ |
| 9-11 | B↔C 边界：agent-workflow-integration, plugin-skill-discovery, workflow-requires-clones-rules-commands | 归工作流域还是 agent 域？两簇若合并，最大簇 29.5%→ ~38% |
| 12-13 | D 簇：harness-gap-fix 并入 workflow-engine-harness 后，e2e-harness-system 与 harness-semantic-v2 是否同类 | harness 簇去水后是否 ≥3 |
| 14-15 | C 簇：clone-ui-redesign, octopus-agent-ui-wiring | 实际是 UI 票混入 agent 域（启发式高估 C） |
| 16 | F 簇修正 | 从 git 分支补录 feat-dart-theme-20260924 / feat/memphis-ui / feat/ui-style-unify / feat-dark-mode 4 条 UI 换肤任务，F 簇 1→5，"UI 换肤"本身成簇——启发式因无 .scratch 台账而漏计 |
| 17-18 | 跨仓：活体验证B、验收C | 确认这两条是否算"真实跨仓需求"。若你判定"是验证不是需求"→ 跨仓 0% 定案 |
| 19 | 孤儿任务目录 777 个 | 抽 2 个（如 `~/.octopus/tasks/001c52e1-*`）确认是 taskpool 清理残留，非未入账任务 |
| 20 | 分支 5（workspace-scheduler-clone-chat, 07-25）与 42（task-pool-redesign, 08-17）同用 feat-agent-clone-optimze / test-task-board 分支 | 验证"同分支≠同任务"的人工权重 |

### 最可疑的误判点（诚实标注）

1. **population 偏差**：以 .scratch 台账为主清单会漏掉无台账的 UI/修复类工作（至少 4 条换肤票只在分支上）——同类占比的分子被低估、分母也被低估，对读法①②方向性影响相反。
2. **簇粒度自相似**：A 簇 13 条里有 6 条是"redesign/phase 化"的连环自我迭代（同一需求 v3→phase→v4），若判为"同一任务的连续轮次"而非 6 个同类任务，A 簇缩水到 ~7。
3. **关键词优先级**：harness 规则排在 task 前，把 20260918-spec-dev-e2e-acceptance（实为任务域验收原型）判进 D 簇。
4. **跨仓分母**：DB tasks 里 9 条真实任务样本太小，18.2%/0% 两个读数都受单条夹具影响 ±9 个百分点——但无论怎么算都在 15% 线附近或以下，拓扑层降级结论稳健。
5. **experiences 结论反向风险**：4 条全垃圾可能是因为经验机制上线即被新架构搁置（表在但无人写），P3 若照"零存量"建，要确认写入路径（skill-evolution/experience-injection 分支 07-03、08-11）是否本来就没接通——feat/experience-injection 分支存在但主库 0 行，**机制未投产**是比"没数据"更准的诊断。

---

## 附：数据源快照

- 查询方式：`sqlite3 "file:~/.octopus/db/*.db?mode=ro"`（对 octopus.db 有活跃 WAL，其余库加 `immutable=1`），全程零写入。
- 42 表中与盘点相关：tasks(68)/workspaces(19)/executions(47)/node_executions(238)/sessions(110, 全 clone_direct)/experiences(0)/execution_archive(27, 全 e2e-* 测试流)。
- git: 663 commits（06-25 起）；类型分布 fix 228 / feat 228 / refactor 57 / docs 46 / chore 22 / perf 7 / style 6 / security 3 / test 1；scope 前 8：server 27, engine 25, web-app 22, harness 20, core-pack 16, xzf-dev 14, web 12, knowledge 12。
- 分支：本地 41 + 远端 78（去重 ~70 个 feature slug）。

## 6. 裁决（2026-09-27，用户定案）

**① 同类占比判据 → 继续整套知识体系。** 采「落在 ≥3 成员簇」读法（90.2% > 30%），贴近方案原定义「同一业务动作换对象」；最大单簇 27.9% 的读法差异已在 §2 诚实留档，不撤。

**② 跨仓占比判据 → P2 拓扑层维持原计划，不降级（破例，理由留档）。** 业务口径 0% 未过 15% 判据线，按 plan.html §P2 判据本应「拓扑层整块降级为仓库登记表、采集器与 7 算子不立项」。用户裁决**维持原计划**，理由：0% 是采样偏差——open-octopus 本体是 monorepo，5 个 demo 仓 5/6 月后休眠，真实跨仓业务在盘点窗口之外；判据假设的「任务分布」窗口对本平台不成立。
**破例的代价照单记录**：P2 的 3 周与 R1（拓扑抽取工作量低估）风险按原样扛；`calls` 边对账可能长期空转。
**重新评估触发条件**（写死，防「破例变默认」）：P2 第 2 周末仍拿不出 10 仓 `calls` 边，或 P4 提案采纳率连续 2 周为 0 → 回到降级方案，且必须在 evidence.html 补一条被推翻表述。

② 的裁决使 ADR-0024（P1 时写）需引用本节作为「P-1 判据一处未过但仍全量推进」的知情记录。

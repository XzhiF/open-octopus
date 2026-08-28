# Pipeline Execution Report

## Requirement: goal-task-dev — goal 模式 /goal 原生适配器 + task-dev 默认工作流
## Status: PASS

### Development Iterations
| # | Feature Slug | Date | Branch | Notes |
|---|-------------|------|--------|-------|
| 47 | task-workflow-presets | 08-27 | feat/task-workflow-presets | 前置底座(preset/物化/WorkflowBox),PR #52 |
| 48 | goal-task-dev | 08-28 | feat/goal-task-dev | 本需求(active) |

### Phase 1: DAG Orchestration(用户选定:pipeline 并发 runner)
| Stage | Tickets | Status | Integration Gate | Commit |
|-------|---------|--------|-----------------|--------|
| 1 | 01 shared, 02 providers, 06 web-app | done×3 | 三包门 PASS(失败集=基线) | c59fa374 |
| 2 | 03 engine, 04 workflows/docs | done×2 | 全仓 build PASS + **真跑探针 ALL PASS** | 9a22a115 |
| 3 | 05 preset 迁移 | done | server 基线字节一致 | 51f8b58f |
| 4 | 07 全链 E2E(工程票) | **skip** | 用户决策并入 Phase 4 | 7380cd77 |

Stage 2 期间收编两个计划外变更:providers stop-hook-feedback 映射(03 取证:CLI 2.1.250 headless 过滤 active_goal,评审级发现)+ 探针 A3 断言位置语义修正。

### Phase 2: Code Review(独立双轴,裁判≠球员)
| Axis | Findings | Fixed | Noted | Cycles |
|------|----------|-------|-------|--------|
| Standards | 0 硬违反 + 5 judgement | 0 | 5(🔵) | 1 |
| Spec | 2 must(🔴c1 单基线漏刷/🟡a1 sync 分支残留)+ 3 creep(误报/豁免)+ 3 边界 | 2 | 1 | 1 |

- 🔴 **c1 多基线迁移**:PREV 单常量会把 709e8019 前播种的安装误判"手改"永不刷新(AC9 真实存量落空,单测自 PREV 播种=循环论证)→ `PREV_DEFAULT_WORKFLOW_PRESETS_YAMLS` 历史列表(v1a/v1b)+ v1a 刷新生效测试,12/12 绿。
- 🟡 **a1** `scripts/sync-builtin.mjs` schema 分支+log 移除(04 的"文件不存在"系误判,build log 实锤)。
- 🟡 a2 weekly CI 绊网:GitHub runner 无 claude CLI 凭据,**不造假接线**;绊网=本地 `scripts/goal-realrun-probe.mjs`(E2E 已复跑 ALL PASS,exit 0)。
- 🔵 记录不修:ship prompt 双份(task-dev/superpowers)、forward-compat active_goal StdoutMessage 分支、`node.engine ?? wf.engine` 两份、max_turns union 类型、version 行非数字边界、stop-hook 正则 `]: `/CRLF 边界(已注释接受)。
- 评审范围纠错:reviewer 报的"superpowers 全新文件 creep"为 diff 起点带错(709e8019 属上一 feature);`toClaudeAgentDef.skills`、`budget-test.yaml` 头两处为 sanctioned 顺手修。

### Phase 3: Deploy
本地形态:全仓 `pnpm build` rc=0;dev server(新 build dist)+ web 启动供 Phase 4;**用户 19 个 schedules 暂停→测后 19/19 恢复**(备份 /tmp/e2e-enabled-schedules.bak)。

### Phase 4: E2E Verification(matt-e2e-tester,用户批准含真跑)
| AC | Condition | Status | Evidence |
|----|-----------|--------|----------|
| AC1 | /goal 首行装配 + 全量注入无截断 | PASS | 单元 22(engine)+ T1 |
| AC2 | 真跑收敛:completed + 文件 + 证据 | PASS | T5/T6(converge.jsonl) |
| AC3 | 真跑不收敛:max_turns→failed+goal_evidence | PASS | T5 B1-B3(error_max_turns→goal_not_met, evidence 完整) |
| AC4 | 字段直通 sdkOptions + $inputs 解析 | PASS | 单元 14 + T2 |
| AC5 | active_goal 全链 JSONL 证据 | PASS | T5 B4/B5(count=3, condition/iterations/last_reason) |
| AC6 | preset 换绑 + 绑定/物化 API | PASS | T3 30/30(DB config:goal/ac 原文、无 max_turns 键、变体"5"持久化) |
| AC7 | simulator fixtures(goal 失败态形状) | PASS | T2 14 PASS |
| AC8 | schema 引用清零 + sync 干净 | PASS | T7 8/8 |
| AC9 | 迁移三分支(旧默认刷/手改存/新建写) | PASS | 单元 12 + live v2 验证 |
| US5 浏览器 | 表单显 "200"(F)+ 换选清空(N) | PASS | T4 18/18 + 截图 01-04 |
| 全链 | draft→绑定→confirm→真跑→本地 ship 提交 | PASS(23/24) | T6;唯一 FAIL=先存平台 bug(下) |

回归基线:engine 失败集=基线(测试名级全等);server 精确 46/13 一致。0 泄漏 E2E_TEST_GTD_ 行。

**T6 Step 4c(先存,非本需求)**:task 状态镜像竞态——`executions.status=completed` 但 `tasks.status=failed`。根因:`engine.ts:431` 在 `run()` 返回前触发 `onComplete`,`workflow-executor.ts:459` 回读尚未持久化的 DB 状态(`ExecutionLifecycle.ts:556`/`EngineCallbacks.ts:496`)。`git diff main...HEAD` 零改动 + 08-17 历史任务同签名。**另案处理**(需人工修+重启)。

### Phase 5: Ship (Git PR)
**PR #53**: https://github.com/XzhiF/open-octopus/pull/53 — feat/goal-task-dev → base `feat/task-workflow-presets`(stacked on #52;#52 合并后 retarget main)。含并行会话 skill 门控 commit(526f322b)。Status: PASS。

### Changed Files(摘要;全量见 git diff)
| Package | Files | Change Type |
|---------|-------|-------------|
| shared | types/workflow.ts, yaml/parser.ts, goal-mode.test.ts | schema+validate |
| providers | types.ts, claude/provider.ts, index.ts, +2 test files | plumbing+事件链 |
| engine | executors/{agent,agent-runner,agent-types}.ts, +2 test files | /goal 适配器 |
| server | workflow-presets-seed.ts, clone-init-service.ts, +1 test file | v2 迁移 |
| core-pack | **task-dev.yaml(+test)**, superpowers-task-dev goal 化, 7 yaml 头清理, skill 镜像 | 工作流 |
| web-app | workflow-box.tsx + test | F/N 修复 |
| cli/skills/scripts | workflow.ts warnings、setup-runner、octo-workflow-dev/test 文档、**goal-realrun-probe.mjs** | 文档+工具 |

### Remaining Issues
| # | Issue | Impact | Suggestion |
|---|-------|--------|------------|
| 1 | task 状态镜像竞态(先存) | 全链成功后看板显 failed,误导验收 | 另案:executor 回读改事件源或 onComplete 后持久化;修复需重启 dev server |
| 2 | task-modal-spec-panel 用例在 HEAD 红(重复文本,`c6e1613e` 引入) | 无生产影响,CI 噪音 | 建议 #52 分支补 dedupe ticket |
| 3 | weekly 绊网为本地脚本(无 CI 凭据) | 版本漂移需人跑 | 本地周检或加带 secrets 的自托管 runner |
| 4 | 🔵 5 条 smell(ship prompt 双份等) | 可读性/漂移风险 | 出现第三消费方时抽取 |
| 5 | `/goal` condition 吸收整条首消息(含引擎 Instructions 段) | evaluator 判定正常,condition 有噪声 | 需净化时走 streaming-input 两段式(B5 已留证) |

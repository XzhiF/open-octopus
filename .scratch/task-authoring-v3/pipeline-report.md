# Pipeline Execution Report

## Requirement: task-authoring-v3 — 两阶段任务编写 + 产出查看器
## Status: PASS

### Development Iterations
| # | Feature Slug | Date | Tickets | Notes |
|---|-------------|------|---------|-------|
| 43 | task-domain-redesign | 2026-08-18 | done | v2 first-class tasks table + deterministic draft + spec↔agent linkage（PR #51 首次交付） |
| 44 | task-authoring-v3 | 2026-08-18 | 11/11 done | 本迭代：两阶段编写 + Skill 组锁定 + 产出查看器 + 辅助工作流 |

> 同分支 `feat/task-domain-redesign` 两个迭代，共用 PR #51。#43 已在前一轮交付；本报告聚焦 #44。

### Phase 1: DAG Orchestration
| Stage | Tickets | Status | Integration Gate | Commit |
|-------|---------|--------|-----------------|--------|
| 0 | 01 | ✅ done | PASS（零新增失败） | b33ce6de |
| 1 | 02, 05 | ✅ done | PASS | dec51192 |
| 2 | 03, 07, 08 | ✅ done | PASS | de04157b |
| 3 | 04 | ✅ done | PASS | 648b77e7 |
| 4 | 06, 09 | ✅ done | PASS | ba9c65f2 |
| 5 | 10 | ✅ done | PASS | e4d290b8 |
| 6 | 11 | ✅ done | PASS | 38bfdc8a |

- 11 tickets 全部 done；每 stage 由并发 matt-dev-runner 实现 + `pnpm build && pnpm test` 集成门禁。
- 集成门禁基线：该分支存在 **31 个预先失败测试文件**（环境漂移：model alias 变更、persona 快照、DB/git 环境测试），已记录于 `known-baseline-failures.txt`。每 stage 用失败集合 diff 对照基线，**全程零新增失败**；`resource.test.ts` / `integration.test.ts` 两处偶发 flake 单独复跑均通过（90/90、7/7）。

### Phase 2: Code Review
| Axis | Findings | Fixed | Noted | Cycles |
|------|----------|-------|-------|--------|
| Standards | 0 hard / 8 smell | 3（seam、imports、event 常量 hoist） | 5 | 2 |
| Spec | 6（2 缺失 + 3 蔓延 + 1 偏差） | 2 🔴（D6、D19） | 4 🔵 | 2 |
| Completeness | 2（均与 Spec 轴重合） | 2 | 0 | 2 |

- 🔴 **D6 修复**：task-author send path 追加 `@@task_context`（产物目录绝对路径 + Skill 组锁定上下文）— clone-runtime 第 9 位参数 + routes/clone 注入 + 3 个新集成测试。
- 🔴 **D19 修复**：server 在每次 spec-field 更新时 emit 伴随 `task_artifacts_update`（shared 常量 + tasks-service emit + 集成测试）；前端 OutputViewer **移除 1.5s 轮询**，纯 SSE 驱动。
- 🟡 persona 补 `decisions` 字段 + 显式创建补 `source_chat_session_id`（D15 会话优先）。
- 🟡 readyTask 改用注入的 TaskHomeService（seam 一致性）。
- 🟡 assist-workflow-service 清理未用 fs import + 重复类型别名；`ASSIST_RUN_UPDATE_EVENT`/`TASK_ARTIFACTS_UPDATE_EVENT` hoist 到 shared。
- Cycle 2 验证 sub-agent：**5/5 RESOLVED，无回归**（9385ba69）。
- 🔵 记录不修复：原型路由（spec 阶段产物，交互参照）、SpecPanel org selector、reap→softArchive FK 权衡、采纳 source:"user"（用户发起，通知合理）、位置参数 Data Clumps（SW-BP15 追加约定）、跨包 resolver 重复（重构候选）。

### Phase 3: Deploy
| Project | Build# | Result |
|---------|--------|--------|
| local dev (server 3001 / web 3000) | — | 重启 server 于最新 dist（含 review fixes）；Next.js dev 热重载。无 CI/CD |

### Phase 4: E2E Verification（当前迭代）
| AC | Condition | Status | Evidence |
|----|-----------|--------|----------|
| US1 | template→create→authoring（D15 单 draft + 绑定） | PASS | test 2,13 |
| US2 | Skill 组多选 + plugin 物化（junction） | PASS | test 13 |
| US3 | 锁定（🔒 + PUT 409 + merge-preserve） | PASS | test 3,14 |
| US4 | goal/ac SSE 浮现 | PASS | test 4,13 |
| US5 | 用户直编 → agent 感知 | PASS+manual | test 4（@@spec_updated 投递为 manual） |
| US6 | 确认后方可入队（D18 gate） | PASS | test 5,6,13 |
| US7 | 产物全文 + 降级 + SSE 刷新 | PASS | test 7,8,9,13 |
| US8 | 对话改产物 | SKIP (manual) | LLM 行为，accepted exclusion |
| US9 | agent 建议 + 用户执行辅助工作流 | PASS+manual | test 10（建议气泡 manual） |
| US10 | 过程日志 | PASS | test 10 |
| US11 | MoA 采纳（ac+decisions）+ parse-error 降级 | PASS | test 11,12 |
| US12 | dispatch 注入 $vars.task_artifacts_dir | PASS | test 13 |
| US13 | 删除回收家目录 | PASS | afterAll |
| US14 | preset 仅 org+projects | PASS | test 3 |
| D19 | task_artifacts_update 伴随 SSE | PASS | test 4（新增）+ server 15/15 |

- matt-e2e-tester：**14/14 PASS**（retries=0 24.9s）。1 次 Quick Fix（test-only：D19 SSE-only 重构后旧轮询假设失效 → 用真实再触发驱动 re-fetch，忠实 SSE-only 设计）。
- R1–R8 反假跑合规：API↔DB↔FS↔SSE↔UI 五层交叉验证；156 个 `expect()`（11.1/test，同级 spec 最高）。
- **18 张 v3-specific 截图**（template/goalac/viewer/assist/fulllink 全关键步，mtime 2026-08-18 22:01，修复后重生成；上一迭代遗留的 `task-domain/A-01-kanban-board.png` 已移回 `.scratch/task-domain-redesign/e2e-screenshots/`，目录现仅含 v3 截图）。
- 跨特性发现：`task-domain-simple/composite` 旧 sibling spec 对 v3 TemplatePicker 流过时（correct-by-design，属另一 feature 的 spec，单独跟进）。

### Phase 5: Ship (Git PR)
| Project | Branch | PR# | Action |
|---------|--------|-----|--------|
| open-octopus (monorepo) | feat/task-domain-redesign | [#51](https://github.com/XzhiF/open-octopus/pull/51) | Updated（smart overwrite，保留 MANUAL 区块） |

### Changed Files（当前迭代 vs 9917e986，git diff 实时）

基线 `9917e986`（#43 task-domain-redesign 终点）→ HEAD `b430f89a`（含 r2 gap-fix）。`git diff --shortstat 9917e986...HEAD` 实时核定：94 files, +13250/-118。

| Package | Files | Change |
|---------|-------|--------|
| shared | 5 | +380 / −6 |
| providers | 0 | — |
| engine | 2 | +159 / −2 |
| core-pack | 7 | +199 / 0 |
| server | 22 | +5091 / −66 |
| web-app | 21 | +4358 / −44 |

非 packages/（tests/E2E/.scratch/ADRs/CONTEXT-MAP）：37 files, +3063 / 0。

当前迭代合计：94 files, +13250/-118（r2 gap-fix 后口径；providers 0 文件——本迭代未触 providers）。

> 口径演变：R1 报告初版按 `origin/main...HEAD` 误算（含 #43 文件）；r2-03 修正为 vs 9917e986（@ee3ce0c0 = 85 files, +15801/−106）；r2 提交（b430f89a）删除 prototype（−3568 行，因该文件在基线后加入又删除，三点 diff 中完全抵消）+ 新增 r2 工件 → 94/+13250/−118。
> 核实命令：`git diff --shortstat 9917e986...HEAD`；按包计数：`git diff --name-only 9917e986...HEAD | grep -oE "^packages/[a-z-]+" | sort | uniq -c`。

### Remaining Issues
| # | Issue | Impact | Suggestion |
|---|-------|--------|-----------|
| 1 | 31 个预先失败测试（环境漂移） | 低（与本特性无关） | 单独 baseline 清理任务 |
| 2 | task-domain-simple/composite sibling spec 对 v3 流过时 | 中（跨特性回归误报） | 单独 pass 更新到 TemplatePicker 流 |
| 3 | 原型路由 /tasks/prototype 仍在 app 内 | 低（R6 标记 throwaway） | 可在后续迭代删除 |
| 4 | real-LLM MoA 完成、agent 建议气泡、@@task_context 投递 | manual checklist（spec accepted exclusions） | 人工验证 |

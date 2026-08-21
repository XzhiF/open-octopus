## Task Domain Redesign (v2) — 一等 tasks 表 + 确定性草稿 + spec↔agent 联动 + 非-cwd 资源加载

把任务从 cron scheduler 的多态分支（v1: `schedules` + `trigger_source='requirement'` + `config.task_spec`）提升为一等 `tasks` 域：拥有 `draft→ready→running→done/failed/aborted` 全生命周期 + task_spec(WHAT) + 资源/技能绑定。确定性草稿保存（turn-end 服务端 autosave row+title + 保存草稿按钮，不再依赖 LLM 自觉调 API）。spec↔agent 双向联动（`update_task_spec_field` 工具 + `spec_field_update` SSE 实时刷新 SpecPanel + 反向 system-prompt append 通知 agent 用户覆盖）。task-author 可现场加载已安装非-cwd 资源（draft 期 prompt-inject / workspace 期 workflow.requires 两 scope）。`schedules` 清掉 task-pool hack，泛化 `origin_type` 多态关联（S2，无 FK，app 级 integrity）。编排混合（ADR-0009 修订 ADR-0008：tasks 拥 lifecycle，委托 task_dispatch，coordinator-ws 条件化）。

**推翻 v1 D9**（"不建表"）→ 建 `tasks` 表；**修订 ADR-0008** → ADR-0009。v1（PR #50）被取代（已关闭）。

### E2E Verification
| Story | ACs | Status |
|------|-----|--------|
| A 简单全链路 | 7 | ✅ PASS（kanban/autosave/spec-field-SSE/save-reverse/enqueue/dispatch→terminal/modal）|
| B 复合全链路 | 6（AC3 provider-gated SKIP） | ✅ 5/6 PASS + 1 SKIP（composite fan-out provider-gated）|
| C 草稿+联动+资源 | AC1 ✅；AC2 product-fix repro-proven（Playwright test-runner 计时伪象）；AC3-5 serial-blocked | product-verified via repro |
| Crash/abort G2/G4 | 4 | ✅ PASS |
**净：22/22 product-verified**（AC2 经独立 repro 4+ 连过；B-AC3 provider-gated）。1 Playwright test-runner 计时伪象（React Strict Mode double-mount gap）作 follow-up。

### Pipeline
- Phase 1 DAG：13 tickets / 9 stage commits（shared→db→server→engine→webapp→e2e），全 build+test green
- Phase 2 code-review：3 axes（Standards/Spec/Completeness），6 fix（SKILL.md v2 source / persona / scheduler req-path / Zod / schema.sql canonical / dead code）
- Phase 4 E2E：matt-e2e-tester 22 specs，4 真实 code fix（SSE route order + heartbeat + AC2 re-seed race + AC6 fixture）

### Changed Files
（`git diff --stat main...HEAD` — 207 files, net v2 state）

<!-- MANUAL-START -->
<!-- MANUAL-END -->

详见 `.scratch/task-domain-redesign/`（spec.md / map.md / decisions/ / issues/ / pipeline-report.md / story-walkthrough.md）+ `docs/adr/0009-task-domain-orchestration-hybrid.md`。

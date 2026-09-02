# 13 — core-pack：task-author SKILL.md v2 重写 + task-fix.yaml 修复流

## What to build
SKILL.md：保留 curl/API 骨架；9 字段教学→phases 协议（spec-field field=phases、specPath 约定、拆分确认 gate 流程）；新增四章：领域阅读流程（context.md→project 路径→惯例 probe 降级）、拆 phase 方法论（deliverable 判据、1~1.5h 预算、决策表行稳定纪律 NEW-rN）、matt 族产物协议（Batch 目录、spec.md 冻结+spec-rN 并存、issues 原位增量、fix-feedback 消费）、per-phase 工作流绑定推荐（built-in 目录浏览）。新工作流 `task-fix.yaml`（通用修复流：inputs=phase spec 目录+feedback 文件+task_artifacts_dir → agent 定点修 → 产 fix-report-rN.md 入 slug）+ 配对 test.yaml。

## Blocked by
04（占位符词表）, 09（技能族就位）

## Status
ready-for-agent

## Acceptance Criteria
- [ ] AC1: `octopus workflow validate packages/core-pack/workflows/task-fix.yaml` 通过
- [ ] AC2: task-fix.test.yaml 模拟器 scenario 绿（含 feedback 缺失反例）
- [ ] AC3: SKILL.md 经人工 checklist 走查：四新章齐、无 goal/ac/preset 残留词、curl 端点与实际路由一致（对照票 07 端点）
- [ ] AC4: 现网 task-author 会话加载到的 SKILL.md 为新版（版本号断言）

## Verification Method
**Verification type**: workflow simulator + manual checklist

**Verification steps**:
1. `pnpm -F @octopus/engine test -- task-fix`（或 CLI `octopus workflow test`）
2. 走查清单：对照 spec.md K15/K9/K10 逐条勾
3. `octopus workflow validate` 输出贴票

**Pass criteria**: validate+simulator 绿；checklist 无缺口（人工验收项，SKIP 需注明）
**Failure handling**: Max 3 fix attempts, then mark SKIP with reason

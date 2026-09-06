# Spec — spec-driven-workflow（manifest 更名 + ws 权威 spec 环 + matt-spec-dev + 打回二分路由）

> Created: 2026-09-05 · Branch: `octopus-feat-v4-direct-create-ui` · 决策全文：[ADR-0018](../../docs/adr/0018-ws-authoritative-spec-and-reject-routing.md)
> 来源：v4-only 创建链路 handoff（2026-09-05）+ 用户四项裁定（清理 goal/ac / spec.json→manifest.json / 1 phase=1 spec.md 保持 / 缺 spec 直执行流）

## 目标

1. task home 快照更名 `spec.json → manifest.json`（元数据清单名副其实），v4 快照剔除 v3-only 残留键，goal/ac 旧文案三处清理。
2. **入队后 spec 权威在 ws**：collect 全类回流（含 spec.md），home=终态镜像；打回/执行中修订就地更新 spec.md，修订点记 round-report/fix-report。
3. 新内置流 `matt-spec-dev`：直读批次 spec.md+issues/ 执行（票 DAG→gate→CR→ship），零澄清零 spec 再生成。
4. 打回二分路由（人裁决，round 级 override 只进 workflow_chain，K16 冻结不破）：轻量修复=task-fix（server 合成输入）/ 修订重跑=绑定流先再审 spec。
5. 附带修掉 Windows 冒号缺陷（ws 目录名单独 sanitize）——v4 执行链本机验证的前置阻塞。

## Key Decisions

| # | Decision | Conclusion | Reason |
|---|----------|------------|--------|
| 1 | spec 类型表达 | 文件名约定（spec.md/spec-rN/fix-feedback-rN/fix-report-rN/round-report），零 schema 类型位 | server 从不解释 spec 内容；UI 用批次清单呈现 |
| 2 | 执行侧修订形态 | 就地改 spec.md（唯一活文档），修订台账进 round-report | 单一文件零歧义，"task 空间 spec 跟着变"字面兑现 |
| 3 | 打回路由 | 弹窗人二选一 `next_flow: fix\|rerun`（缺省 rerun=现行为零回归）；override 只进 chain，即时派发 | 停轮+新端点机制被 ws 权威模型作废；纪律进提示词不进代码 |
| 4 | task-fix 绑定 | 起草期永不手绑；fix 路由由 server 合成输入（指向 ws 同构批次位） | feedback_path 必填 vs 反馈晚于 gate 存在的死结 |
| 5 | manifest 迁移 | 懒迁移（快照写删除 legacy + rules stale-marker + /context 读回退），无 boot 扫描 | 存量 home 少；首聊/首存自愈 |
| 6 | v4 快照过滤 | 写侧剔除 V3_ONLY_SPEC_KEYS，DB 镜像语义让位 | ac_confirmed: [] 等默认键污染清单 |
| 7 | 冒号缺陷修法 | 目录名单独 sanitize，workspaces.name 保留 `task:` 展示；测试补假 USERPROFILE | 基线 62 红的双根因（非法字符 + os.homedir Windows 读 USERPROFILE） |

## User Stories / 验收

- US1 用户开草稿任务 → 右栏见「任务清单 (manifest.json)」，副标题 phases 绑定·决策备忘，点开无 goal/ac 字样；`{home}` 磁盘落 manifest.json。【V: e2e task-authoring-v4 ③ + task-domain-draft-linkage 快照断言】
- US2 老任务 home（只有 spec.json）→ 首聊/首存后 manifest.json 出现、spec.json 消失、rules 指针更新。【V: server task-home-service 迁移/stale-marker 用例】
- US3 v4 任务快照 JSON 不含 goal/ac/goal_confirmed/ac_confirmed/task_type。【V: task-home-service.test v4-filter 用例】
- US4 执行侧在 ws 改 spec.md → 轮终态后 home/spec.md=ws 版；未改动轮 re-collect 零回流。【V: tasks-v4-artifact-loop AC1-AC4】
- US5 用户绑 phase 选 `built-in/matt-spec-dev`，`batch_dir=${phase.batch_rel}` → gate 解析相对批次位入信封。【V: tasks-v4-gate batch_rel 用例 + simulate 3 场景】
- US6 验收打回选「轻量修复」→ chain[0]=built-in/task-fix + 合成 phase_spec_dir/feedback_path（只作用本轮，phases[] 冻结不变）；选「修订重跑」→ 现行为。【V: tasks-v4-acceptance AC3.5 + e2e reject 流】
- US7 round 徽标显示实际执行流（fix 轮 ≠ phase 绑定流）。【V: derive exec.workflow_ref + AC3.5 断言】
- US8 本机 v4 任务触发不再 ENOENT（冒号）。【V: tasks-v4-ws-reuse / artifact-loop 在 Windows 全绿】
- US9 E2E 票节点在 batch_dir/e2e-* 落证据、反假跑 R1-R8 写进流提示词。【V: matt-spec-dev.yaml 审读 + simulate】

## Verification Strategy（总）

pnpm --filter @octopus/server test（task 域全绿 + 基线红收敛）；web components/tasks 单测；playwright task-authoring-v4/task-phase-acceptance/task-domain-draft-linkage/task-phase-board；octopus workflow simulate ×2（matt-spec-dev/task-fix）；npx tsc --noEmit 对比基线无新错；四方交叉手测 1 条（UI↔API↔DB↔fs）。

## Out of scope（v4.1 既定）

D14 影响清单数据源；信封 phases[] resync；artifacts.json 自动登记；matt-dev-pipeline 本体改造；goal/ac 字段物理退役。

## issues/

- 01-manifest-rename.md（P1 更名+清理+过滤+懒迁移，含 web/SKILL）
- 02-ws-colon-and-windows-home-fake.md（冒号缺陷 + 测试 USERPROFILE）
- 03-ws-authority-collect-loop.md（collect 反转 + artifact-loop 反口 + ADR-0018 落文）
- 04-matt-spec-dev.md（新流 + test.yaml + task-fix 口径 + ${phase.batch_rel}）
- 05-reject-binary-routing.md（next_flow 路由 + chain override + execWorkflowRef + UI radio/回显 + 批次清单 LIST/phase-spec-dialog）
- 06-e2e-regression-and-index.md（playwright 四流 + 全量回归 + index 状态回填）

# 打回单路径化：新 round 一律 task-fix，绑定流不再重跑

验收台重设计（原型 `packages/web-app/public/prototype/taskboard-v2.html`）拷问定案：打回曾是二分路由（修订重跑 ∨ 轻量 task-fix，ADR-0018 §5），实践质疑下重跑路径被废除——**打回 → 新 round 一律派 `built-in/task-fix` 修复轮**（拿反馈当指令：解析→开发/修复→回归→调整·补产物→自动回待验收），`next_flow: "rerun"` 从 UI 与 API 枚举中干净删除（不留隐藏档）。绑定工作流的再执行只剩一条路：草稿态（task-author 会话）改 spec 后重新入队，验收台不提供该入口。

## Considered Options

- **UI 隐藏、server 留档 rerun 一个版本** — 被否：半死枚举最易复活。
- **保留 round-2 spec 再执行为打回按钮选项** — 被否：与"绑定流每 phase 只正式跑一次"的轻量精神相悖；入口移到 authoring 侧。

## Consequences

- K16 不破：路由覆盖仍走 `workflow_chain`，信封 `phases[]` 冻结不动（与 ADR-0018 同构）。
- 「先产 round-2 spec 再执行」不删能力、只删打回侧入口（Q2=b）：方向性翻车走两途——task-author 改 spec 重入队，或执行期**人工接管**（见 ADR-0025）。
- amends ADR-0018 §5（打回二分路由段作废）。

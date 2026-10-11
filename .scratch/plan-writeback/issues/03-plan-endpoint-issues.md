# 03: 计划回写端点 · 票侧（新票出生证明）

> Spec: `.scratch/plan-writeback/spec.md` S1 契约 issues 分支 + 票模板契约

**What to build:** `POST /api/tasks/:id/plan/issues` 让一次打回/接管对话里判出的新范围落成一张符合 to-tickets 契约的票：顺延编号、Status、Blocked by 边、Origin 出生证明行（来源 = 打回 rN 反馈#k / 接管对话 / 修复轮）。产物页签「需求票面」组立刻数得出这张新票——"票为什么存在"写在票上。

**Blocked by:** 02（同路由模块，状态闸/守卫/归属解析复用其实现）。

**Status:** done

- [x] 合法新票写入目标批次 issues/ 目录，编号 = 现存最大号顺延，文件名 slug 由请求给定
- [x] content 缺 `Origin:` 或缺 `Status:` 行 → 400 并指明缺哪项；含则落盘
- [x] 票侧**不** append 变更记录（出生证明在票内）；对既有票的**修改**走同端点且 reason 必填，Origin 行不许被抹（改后仍含）
- [x] 状态闸 / 越界 403 / reason 400 / 后续 phase 批次可写 —— 与 02 同语义的测试逐条覆盖（不靠代码复用"顺带绿"，断言在票侧独立存在）
- [x] 产物 manifest 测试：开票后清单含新票条目（并入既有 manifest 测试集）
- [x] 02 的全部 AC 保持绿（回归）

> **Closed**: 并入 feat-plan-writeback（octopus-pwb-03@f443b94b；票侧 32 例独立成测 + 02 集 31 同文件 63 绿；细化两则入注释：票区形状缺陷 400 先于写门、正文逐字不重建）。2026-10-10。

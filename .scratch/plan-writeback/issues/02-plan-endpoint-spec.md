# 02: 计划回写端点 · spec 侧（S1 主 seam）

> Spec: `.scratch/plan-writeback/spec.md` Implementation Decisions 之 S1 契约逐字为准

**What to build:** 任务级 REST 端点 `POST /api/tasks/:id/plan` 上线。一次 curl：带 reason/source 写当前或**后续 phase** 批次内的 spec 文件 → home 盘落新内容 + 文末「## 变更记录」多一行（时间·谁·来源·理由·文件）→ 产物页签立刻可见。这就是"trend 的骨架"，机写不靠 agent 自觉。

**Blocked by:** 01（文案与断言取词）。

**Status:** done

- [x] 成功路径：合法请求写入 home 批次内 spec，200 返回写入摘要；home 盘文件内容 = 请求 content
- [x] `batch` 可指向同任务 home 下**后续 phase** 批次；文件解析限批次内，越界 403（复用既有 home 遍历守卫，不放宽）；任务不存在 404
- [x] `reason` / `source` 缺失或空白 → 400；server 不判 reason 语义（无关键词正则）
- [x] 状态闸：running / paused / takeover / fixing / awaiting_review 可写；done / aborted / archiving → 409（对齐既有 spec 可编辑判定）
- [x] 每次成功写入在目标文件文末 append 一行变更记录；无该节则建节；连续写入按时间**累积不覆盖**
- [x] 变更记录的 actor 由 server 按会话/执行归属解析；body 自报身份不采信
- [x] 写成功后既有产物 manifest 即列出新内容与变更节（零 manifest 改动，衔接断言写进测试）
- [x] 集成测试全绿（先例：任务对话 API 与 tasks 路由既有测试）；engine/shared 零改动（除端点请求/响应类型若 shared 有惯例则随包）

> **Closed**: 并入 feat-plan-writeback（octopus-pwb-02@8c327af6；31 用例绿；契约细化两则入档：actor 归属"活跃 task-fix 执行→doer 会话→unattributed 宁缺不伪"、变更记录节由 server 单源重建防伪造历史）。2026-10-10。

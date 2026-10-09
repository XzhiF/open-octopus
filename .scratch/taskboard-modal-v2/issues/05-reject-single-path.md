# 05: 打回单路径（ADR-0024）

**What to build:** 打回 = 修复轮，一条路走到黑：acceptance 契约中 `next_flow` 枚举**干净删除**（UI 与 API 一处不剩，不留隐藏档）；rejected 决策恒定以 server 合成 inputs 派 **task-fix 修复轮**（workflow_chain 级 override，K16 信封 phases[] 冻结不动）；打回框从"双选一"重做为单指令输入——反馈即修复指令，空反馈拒绝提交；反馈仍落 fix-feedback 文件作 task-fix 输入。打回后任务回执行中，绑定执行显示为 task-fix（其 UI 呈现由 04 的节点页签承接）。绑定工作流的再执行只剩 authoring 侧改 spec 重入队一条路（验收台无入口）。

参考：ADR-0024、spec.md（打回单路径一条）。

**Blocked by:** None (can start immediately)

**Status:** done

- [ ] acceptance 请求携带 next_flow 字段被 schema 拒绝（契约测试断言 400 或未知字段策略明确）
- [ ] rejected → 新 Round 的派发路由恒为 built-in/task-fix，合成 inputs 指向 spec 目录/反馈文件/产物目录；断言 workflow_chain 与信封冻结均未被破坏
- [ ] 打回框无路由选项；反馈为空 → 提交被拒且提示"以此为输入"
- [ ] 端到端：待验收任务打回 → 任务回执行中且执行详情显示 task-fix 在跑 → 跑完自动回待验收、产物（报告/证据）在列
- [ ] 通过路径不受影响（既有硬闸/台账行为原样）

> **Closed**: 并入 feat-taskboard-modal-v2（票 commit d54ae19a；终 tip 3131acc0）。逐 AC 证据见实现报告与 tmp/tbm-v2-notes.md §已合并票契约；双轴 code-review 八项经 fix 6abe16a7 收口；E2E 终tip复验流①②③⑤ GREEN，流④断言已对齐 form-aware 标记+窗口放宽 120s（待人工确认跑一次）。

# 03: ≡ 变更页签（执行中即可看改动）

**What to build:** 统一壳的「≡ 变更」页签成为一等公民：GitHub Files-changed 视图——提交数/文件数/+行/−行/harness 干预/成本统计条，本轮/累计切换，文件行（A/M/D/R 徽标 + 各自 +/− 与绿红比例条）点击就地展开 unified diff（双行号、@@ hunk、加绿删红）。数据全部复用既有 round-diff 契约与按文件 patch 懒取端点，**不新增后端接口**。执行中"半实时"：既有任务 SSE 事件（task_execution / artifacts / verify 类）触发 + 节流轮询，滞后 ≤10s。

参考：spec.md（变更页签一条）、原型 `taskboard-v2.html`（该页签即交互真相源）。

**Blocked by:** 02（统一弹窗壳）

**Status:** done

- [ ] 执行中弹窗默认落在「≡ 变更」，可见本轮统计条与文件列表
- [ ] 点击文件行就地展开 diff，二次点击收起；懒加载 patch 正常渲染、超长截断有提示
- [ ] 本轮/累计口径切换后统计条与列表同源变化
- [ ] 真跑一个 dev 任务：新 commit 产生后 ≤10s 出现在列表（E2E 可验证的观测口径）
- [ ] 待验收态同一页签复用零改动；diff 数据源仍是既有端点（无新增 API）

> **Closed**: 并入 feat-taskboard-modal-v2（票 commit b4fb4504；终 tip 3131acc0）。逐 AC 证据见实现报告与 tmp/tbm-v2-notes.md §已合并票契约；双轴 code-review 八项经 fix 6abe16a7 收口；E2E 终tip复验流①②③⑤ GREEN，流④断言已对齐 form-aware 标记+窗口放宽 120s（待人工确认跑一次）。

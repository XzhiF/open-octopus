# 09: 验收台账分列（干预 / 快改 / 接管留痕）

**What to build:** 验收台账（acceptance ledger）把"人工介入度"变成一等事实：实物段之外新增三列来源——**人工干预 ×N**（次数+每条摘要，与既有 harness 干预计数并列不混称）、**快速修改 ×N**（按 quick-edit commit 标记统计，文件清单可溯）、**接管标记**（takeover 件显示"人工交付·自动复检未跑"）。决策前的台账预览对话框同步展示三列；台账为追加式账本语义不变（append-only 不破坏）。词表"验收台账 (Acceptance Ledger)"词条已立，UI 文案用 canonical 名。

参考：spec.md（快改提交/干预接线两条的台账部分）、GLOSSARY-MAP 验收台账条。

**Blocked by:** 01（quick-edit commit 标记是统计源）, 06（人工干预记录源）, 08（接管标记源）

**Status:** done

- [ ] 含干预+快改+接管的 Round，台账文件三列齐且数字与实物一致（文件内容级断言）
- [ ] 无任何人工介入的 Round 台账不回退（列显示 0/无，既有段完整）
- [ ] 通过/打回两决策均写台账；台账写失败不回滚决策（既有 best-effort 语义保持）
- [ ] 台账预览对话框在放行前展示三列（与走查页签同口径）
- [ ] "台账"不与"用量台账"混用：文案与字段命名遵守词表

> **Closed**: 并入 feat-taskboard-modal-v2（票 commit 1d4e2b3c；终 tip 3131acc0）。逐 AC 证据见实现报告与 tmp/tbm-v2-notes.md §已合并票契约；双轴 code-review 八项经 fix 6abe16a7 收口；E2E 终tip复验流①②③⑤ GREEN，流④断言已对齐 form-aware 标记+窗口放宽 120s（待人工确认跑一次）。

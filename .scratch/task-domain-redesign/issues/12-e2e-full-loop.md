# 12 — E2E: 全闭环（Story A 简单 / B 复合 / C 草稿+联动+资源）

## What to build
端到端验证 3 闭环故事（spec § Appendix）：A 简单任务全链路（authoring→autosave→spec-field→ready→dispatch 1 ws→done）；B 复合（3 subunits+integration→coordinator+N 子→moa→done+drill-down）；C 草稿+联动+资源（autosave row+title→spec-field 工具→资源 prompt-inject→保存反向→ready）。含 crash recovery（stale→failed 不回滚）+ abort。

## Blocked by
01,02,03,04,05,06,07,08,09,10,11,13 (全)

## Status
ready-for-agent

## Acceptance Criteria
- [ ] AC1: Story A 简单全链路 PASS（autosave→spec-field→ready→1 ws→done+SSE）
- [ ] AC2: Story B 复合全链路 PASS（coordinator+N 子→moa→done+drill-down；子失败→父 failed）
- [ ] AC3: Story C 草稿+联动+资源 PASS（autosave row+title→spec-field SSE→资源 prompt-inject→保存反向→ready）
- [ ] AC4: crash recovery（stale claimed→failed 不回滚）+ abort→aborted+ws 清理

## Verification Method
**E2E (Playwright)** + **integration**：3 故事 step-by-step [UI]/[API]/[Data]/[Exec]/[Event] 断；DB 双向（R3）；E2E_TD_ 前缀（R7）。Pass: 3 故事全 PASS + crash/abort。
**Anti-fake-run R1-R8** 全满足。

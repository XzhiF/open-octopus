# 04 — server: 台账机写 + 打回票重开

## What to build
S3:`writeLedger(taskId, decision)` 聚合 round-diff/verify 会话/preview 会话/checks JSON → `acceptance-ledger-r{N}.md` writeHomeFile;`acceptanceBodySchema` +`reopen_tickets?: string[]`(≤20 项,路径安全:仅 [A-Za-z0-9._-]+.md 基名);tasks-service.acceptance rejected 分支:票文件 `## Status` done→reopened、fix-feedback-r{N}.md 追加「## 未过项(验收台剧本 ✗)」节(op/expect/note/票号);routes 层 accept 成功后调 writeLedger(fire-safe);三决策路径统一先 stopPreview。

## Blocked by
02, 03

## Status
pending

## Acceptance Criteria
- [ ] AC1: accepted → ledger 存在且含实物/复检/走查计数;writeLedger 抛错不改决策结果(降级 warn)
- [ ] AC2: rejected+reopen → 票 Status 变 reopened、反馈文件含未过项节;非法票名(../)→ 400
- [ ] AC3: 决策后 preview 会话 stopped 且 ledger 记 stop

## Verification Method
**type**: unit — 仿 tasks-acceptance 既有测试族 + fixture 批次目录。

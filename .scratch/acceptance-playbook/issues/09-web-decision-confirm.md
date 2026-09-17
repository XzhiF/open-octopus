# 09 — web: 决策确认层三式

## What to build
① 通过=LedgerPreviewDialog:展示最终 ledger 摘要(实物聚合/复检章/预览/走查 ✓⊘✗ 计数/未决清单)+「确认通过 · 写台账」(复用 ui/Dialog,pop 版式;fail>0 时通过钮 disabled 带原因);② 打回:既有 Dialog 增 fail 项预填 textarea + 隐藏字段 reopen_tickets(取 fail 项 src 票名)入 postAcceptance body;③ 中止:confirm-dialog variant=destructive(明示 SIGTERM 连带复检/预览 + 不可恢复)。confirmAccept 逻辑从 phase-surface 删除的 handleAccept 收编至此。

## Blocked by
04, 08

## Status
done

## Acceptance Criteria
- [x] AC1: 通过弹层内容=future ledger 文本预览;未决>0 列出项与票号;disabled 逻辑对 fail —「T09 决策闭环」「accepted 提交」2 测 + live 截图(⊘carryover 预告/未决留痕承诺)
- [x] AC2: 打回提交 body 含 reopen_tickets;中止必过确认(组件测查询无 confirm 路径不可达 abort) —「T09 AC2 ✗ 闭环」断言 reopen_tickets=["02-e2e-status"](plan 兜底正确滤除);中止走 ConfirmDialog

## Verification Method
**type**: component test(acceptance-surface.test.tsx 扩展)+ 目检截图。

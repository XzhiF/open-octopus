# 07 — web: 预览状态条

## What to build
`acceptance/preview-bar.tsx`:一行状态条(●stopped/starting pulse/ready+url/exited/stopped 原因)+ ▶启动 / ↗浏览器打开(window.open) / ■停止;**无 iframe**;未配置 → 「配置预览」抽屉(command/cwd/url/readyPattern/超时说明,存 updateSpecField acceptance_preview,形态仿 verify-panel 编辑抽屉);SSE task_preview 驱动;external 态(「外部进程已在 :PORT,↗打开可用/无需停」)。

## Blocked by
01, 05

## Status
pending

## Acceptance Criteria
- [ ] AC1: stopped→starting→ready→stop 全态渲染;ready 时 ↗ 的 href=url
- [ ] AC2: 配置保存走 spec-field;400/409 原因行内显示

## Verification Method
**type**: component test + 状态流转(SSE stub 注 task_preview 事件)。

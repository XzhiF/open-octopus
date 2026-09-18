# 07 — web: 预览状态条

## What to build
`acceptance/preview-bar.tsx`:一行状态条(●stopped/starting pulse/ready+url/exited/stopped 原因)+ ▶启动 / ↗浏览器打开(window.open) / ■停止;**无 iframe**;未配置 → 「配置预览」抽屉(command/cwd/url/readyPattern/超时说明,存 updateSpecField acceptance_preview,形态仿 verify-panel 编辑抽屉);SSE task_preview 驱动;external 态(「外部进程已在 :PORT,↗打开可用/无需停」)。

## Blocked by
01, 05

## Status
done

## Acceptance Criteria
- [x] AC1: stopped→starting→ready→stop 全态渲染;ready 时 ↗ 的 href=url —「T07 预览启动」「T07 AC1 ready 态」2 测;live:mvn spring-boot:run → ready 4s → :8080/api/status 真 JSON → stop 端口释放
- [x] AC2: 配置保存走 spec-field;400/409 原因行内显示 —「T07 AC2 预览配置」断言 source=user 载荷 + 失败不收起抽屉。**偏差记**:原因呈现走 toast(与复检配置同通道),非抽屉行内——弹窗内不引第二种错误样式(D6 克制)

## Verification Method
**type**: component test + 状态流转(SSE stub 注 task_preview 事件)。

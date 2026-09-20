// packages/web-app/components/tasks/acceptance/acceptance-labels.ts
//
// 验收面状态词的单一中文来源（2026-09-20 用户：右栏/复检 pill/预览条直出
// running/passed/starting 等英文枚举，与「已退出/未运行」混排扎眼）。server
// 事件与 REST 用英文枚举做机器真相，这里只管**展示层**翻译 —— 键 = 枚举原值，
// 未知值回退原样（诚实，不吞未来新态）。

/** verify 会话态（VerifyState + 前端 idle/none 派生态）。 */
const VERIFY_STATE_LABEL: Record<string, string> = {
  running: "跑着",
  passed: "通过",
  failed: "失败",
  aborted: "已中止",
  timeout: "超时",
}

/** preview 会话态（PreviewSummary.state）。 */
const PREVIEW_STATE_LABEL: Record<string, string> = {
  idle: "未起",
  starting: "启动中",
  ready: "就绪",
  stopped: "已停止",
  exited: "已退出",
  running: "运行中",
  failed: "失败",
}

export function verifyStateLabel(state: string | null | undefined): string {
  if (!state) return "未跑"
  return VERIFY_STATE_LABEL[state] ?? state
}

export function previewStateLabel(state: string | null | undefined): string {
  if (!state) return "未起"
  return PREVIEW_STATE_LABEL[state] ?? state
}

/** 复检结果态 → pill 里的结论词（passed=通过、其余=失败族，带 ✗）。 */
export function verifyPillLabel(state: string): string {
  return VERIFY_STATE_LABEL[state] ?? state
}

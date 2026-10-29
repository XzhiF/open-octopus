// packages/web-app/lib/agent/chat-colors.ts
//
// chat 输出的「过程三色」（2026-10-29 用户确认的 A+B 方案）：
//   紫 = 想（thinking） · 青 = 动手（tool） · 橙 = 说（正文 / Agent 标记）
//
// 约束：
//   · 颜色只上标签 / 前缀 / 竖线 / 工具名，正文永远是白色；
//   · thinking 长段正文保持灰、只让标签与竖线带紫 —— 整段上色伤阅读；
//   · 一屏最多 5 类色相，红与琥珀只留给错误和费用。
//
// 原型：tmp/chat-output-colors-proto.html

import type { WorkPhase } from './work-phrases'

/** 思考段（LiveThinking / 展开后的 meta 行）。 */
export const THINKING_TONE = {
  label: 'text-pop-purple',
  glyph: 'text-pop-purple',
  /** 展开态整段的外框竖线 */
  rail: 'border-pop-purple/50',
  /** 3 行小窗口的竖线（比外框淡一档） */
  railSoft: 'border-pop-purple/28',
} as const

/** 工具行（ToolLine）：箭头与工具名带青，参数保持灰。 */
export const TOOL_TONE = {
  arrow: 'text-pop-cyan',
  name: 'text-pop-cyan',
} as const

/** 流尾工作行：spinner 与秒数跟阶段走（思考紫 / 执行青 / 输出橙）。 */
export const WORK_PHASE_TONE: Record<WorkPhase, { spin: string; secs: string }> = {
  thinking: { spin: 'text-pop-purple', secs: 'text-pop-purple' },
  exec: { spin: 'text-pop-cyan', secs: 'text-pop-cyan' },
  writing: { spin: 'text-pop-pink', secs: 'text-pop-pink' },
}

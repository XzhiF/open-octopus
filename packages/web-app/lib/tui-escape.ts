// TUI 草稿工作台的 Escape 仲裁（2026-09-24 TUI 改版）。
// Radix Dialog 在 document 捕获相监听 Escape（早于 React 处理器）——排队召回/
// 打断必须先于弹窗关闭被消费。ChatArea(tui) 置位，TaskModal 的 onEscapeKeyDown
// 读到置位即 preventDefault（不关窗），事件继续传播给 React 内的排队/打断逻辑。
export const tuiEscapeGuard = { active: false }

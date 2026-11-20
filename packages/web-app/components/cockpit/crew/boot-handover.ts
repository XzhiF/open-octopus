// packages/web-app/components/cockpit/crew/boot-handover.ts
//
// 舱数据门禁期的「boot 立绘」接力（2026-11-20 用户：全域一打开就要见到汐音）。
//
// 时间线：
//   进舱路由 → 骨架屏 + boot 立绘（动作 01「眨眼」，照常播显影）
//            → 舱数据到位、真舱面挂载（真立绘开始取字节 / 解码）
//            → 真立绘首帧可画 → boot 再盖 0.28s 淡出、卸载。
//
// 两个约束，别退回去：
//   1. **不能在门禁放行时就撤 boot** —— 真立绘首帧要晚 ~200ms，中间会闪一下空档；
//   2. **真立绘不重播显影** —— boot 已经替它演过出场，重播就是第二次扫描，
//      正是之前「上来人物闪两下」的来源。boot 层在屏时，真立绘以「已显影」接入。
//
// 模块级而不是 context：boot 挂在 CockpitGate 外面，真立绘在真舱面深处，
// 跨树只借这几个布尔值 / 事件。

let bootVisible = false
const liveListeners = new Set<() => void>()

/** boot 层挂载 / 卸载（CockpitBootLayer 负责）。 */
export function enterBootLayer(): void {
  bootVisible = true
}

export function leaveBootLayer(): void {
  bootVisible = false
}

/** 真立绘挂载时问一句：boot 是否正盖在上面（是 → 本次不播显影）。 */
export function bootCoversEntrance(): boolean {
  return bootVisible
}

/** 真立绘首次可画：通知 boot 层退场。boot 自己不要调 —— 否则没等真立绘出来就淡了。 */
export function notifyRealSpriteLive(): void {
  for (const fn of [...liveListeners]) fn()
}

export function onRealSpriteLive(fn: () => void): () => void {
  liveListeners.add(fn)
  return () => {
    liveListeners.delete(fn)
  }
}

/** 仅测试用：重置模块级状态（用例之间互不串）。 */
export function __resetBootHandover(): void {
  bootVisible = false
  liveListeners.clear()
}

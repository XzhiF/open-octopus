// 共享 z 栈（design 26 §5.3）：主 chat 浮窗与问答窗共用一个递增计数器。
//
// 不做全站层级重构：模块窗沿用既有 z-40 层；这里只解决「点谁谁在上」——
// 点立绘 / 气泡 / 输入区 / ⌘K 打开的主 chat 要压得住问答窗，反过来点问答窗
// 也要能盖住 chat。起点 100，保证在两套既有层（chat 24 / 模块窗 40）之上。

let z = 100

export function nextZ(): number {
  z += 1
  return z
}

/** 测试用：重置计数器（生产代码不调用）。 */
export function resetZForTest(): void {
  z = 100
}

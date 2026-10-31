// 界面偏好（localStorage 持久化 + 同页/跨标签实时生效）。
//
// 作业坞（任务浮窗右侧竖栏）的文字标签：默认常驻显示，图标下方一行小字；
// 设置 → 外观 里可以关掉，退回「只显示图标 + hover 提示」的旧形态。
//
// 之所以不放进组件 state： dock 在任务浮窗里，设置是另一个漂浮窗口，两者
// 同屏挂载；切换开关必须立刻反映到已打开的坞上（同页监听）+ 其它标签页
// （storage 事件）。

const DOCK_LABELS_KEY = "octopus.ui.dockLabels.v1"

const listeners = new Set<() => void>()
let storageListenerInstalled = false

function readDockLabels(): boolean {
  if (typeof window === "undefined") return true
  try {
    const raw = window.localStorage.getItem(DOCK_LABELS_KEY)
    // 只有显式写 false 才关闭；缺省/脏数据都按「显示」处理。
    return raw !== "false"
  } catch {
    return true
  }
}

/** Current preference; the default is `true` (labels visible). */
export function getDockLabelsVisible(): boolean {
  return readDockLabels()
}

export function setDockLabelsVisible(visible: boolean): void {
  try {
    window.localStorage.setItem(DOCK_LABELS_KEY, String(visible))
  } catch {
    // private mode / quota — keep the in-memory behaviour working.
  }
  for (const listener of listeners) listener()
}

export function subscribeDockLabels(listener: () => void): () => void {
  listeners.add(listener)
  if (!storageListenerInstalled && typeof window !== "undefined") {
    storageListenerInstalled = true
    window.addEventListener("storage", (event) => {
      if (event.key !== DOCK_LABELS_KEY) return
      for (const l of listeners) l()
    })
  }
  return () => {
    listeners.delete(listener)
  }
}

/** Test seam: drop subscribers between tests (the storage hook stays installed). */
export function __resetDockLabelsForTests(): void {
  listeners.clear()
}

import '@testing-library/jest-dom'

// jsdom 没有 EventSource；SSE 订阅组件（harness chatbot 等）在测试里会直接
// 抛 ReferenceError。给一个 no-op 桩，让组件渲染/交互测试不被 SSE 环境卡死。
if (typeof globalThis.EventSource === 'undefined') {
  class EventSourceStub {
    url: string
    readyState = 0
    withCredentials = false
    onmessage: ((event: MessageEvent) => void) | null = null
    onerror: ((event: Event) => void) | null = null
    onopen: ((event: Event) => void) | null = null
    constructor(url: string) {
      this.url = url
    }
    addEventListener() {}
    removeEventListener() {}
    close() {}
  }
  // @ts-expect-error test stub — jsdom 环境缺 EventSource
  globalThis.EventSource = EventSourceStub
}

// jsdom 也没有 ResizeObserver：靠容器尺寸驱动的组件（DAG 自动拟合、任务坞几何）
// 在测试里会直接 ReferenceError。给一个**可驱动**的最小桩 —— 注册的回调收进
// globalThis.__resizeObservers，测试改完尺寸后手动 fire，模拟「日志台展开把 DAG pane
// 挤矮」这类真实尺寸变化；单文件里自带 no-op 桩的测试（如 spec-panel）不受影响。
if (typeof globalThis.ResizeObserver === 'undefined') {
  const registry: Array<{ callback: ResizeObserverCallback; targets: Element[] }> = []
  class ResizeObserverStub {
    private readonly entry: { callback: ResizeObserverCallback; targets: Element[] }
    constructor(callback: ResizeObserverCallback) {
      this.entry = { callback, targets: [] }
      registry.push(this.entry)
    }
    observe(target: Element) { if (!this.entry.targets.includes(target)) this.entry.targets.push(target) }
    unobserve(target: Element) { this.entry.targets = this.entry.targets.filter((t) => t !== target) }
    disconnect() {
      const i = registry.indexOf(this.entry)
      if (i >= 0) registry.splice(i, 1)
      this.entry.targets = []
    }
  }
  // @ts-expect-error test stub — jsdom 环境缺 ResizeObserver
  globalThis.ResizeObserver = ResizeObserverStub
  // 按回调签名喂假 entry：被测组件普遍直接读 getBoundingClientRect，不碰 entries
  ;(globalThis as Record<string, unknown>).__fireResizeObservers = () => {
    for (const r of [...registry]) {
      r.callback(
        r.targets.map((target) => ({ target, contentRect: target.getBoundingClientRect() })) as ResizeObserverEntry[],
        {} as ResizeObserver,
      )
    }
  }
}
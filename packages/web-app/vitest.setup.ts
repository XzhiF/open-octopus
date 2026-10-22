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
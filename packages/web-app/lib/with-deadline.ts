// 单请求预算（跨界面共用）。
//
// 为什么需要：浏览器里一个 fetch 可能长时间不结算（半开连接、被长连接占满的
// 连接池、服务端卡在某个查询上）。UI 若直接 await 它，就会永远停在「载入…」。
// 有了预算，最坏情况是「这一段超时」—— 界面能收尾、能重试，用户能说清卡在哪。

/** 单个请求超时：带上标签，界面能说清是哪一段慢/挂了（便于用户回报）。 */
export class RequestTimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`${label}超时（${Math.round(ms / 1000)}s）`)
    this.name = 'RequestTimeoutError'
  }
}

/**
 * 给单个请求加预算，并且**真的取消**底层 fetch（signal 传下去）。
 *
 * `parent` 被 abort（卸载 / watchdog / 新 tick）时立刻 reject，底层请求一起取消；
 * 超过 `ms` 时同样 abort 并抛 RequestTimeoutError。
 */
export function withDeadline<T>(
  parent: AbortSignal | null,
  ms: number,
  label: string,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (parent?.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'))
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let onParentAbort: (() => void) | undefined

  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new RequestTimeoutError(label, ms))
    }, ms)
    if (parent) {
      onParentAbort = () => {
        controller.abort()
        reject(new DOMException('Aborted', 'AbortError'))
      }
      parent.addEventListener('abort', onParentAbort, { once: true })
    }
  })

  return Promise.race([Promise.resolve().then(() => run(controller.signal)), guard]).finally(() => {
    if (timer !== undefined) clearTimeout(timer)
    if (onParentAbort && parent) parent.removeEventListener('abort', onParentAbort)
  })
}
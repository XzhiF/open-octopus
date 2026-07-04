interface QueuedItem<T> {
  value?: T
  done: boolean
  error?: Error
}

export class AsyncEventBridge<TIn, TOut> {
  private mapper: (event: TIn) => TOut | TOut[] | null
  private queue: QueuedItem<TOut>[] = []
  private waiters: Array<(item: QueuedItem<TOut>) => void> = []
  private ended = false

  constructor(mapper: (event: TIn) => TOut | TOut[] | null) {
    this.mapper = mapper
  }

  push(event: TIn): void {
    if (this.ended) return
    const mapped = this.mapper(event)
    if (mapped === null) return
    const items = Array.isArray(mapped) ? mapped : [mapped]
    for (const value of items) {
      this.enqueue({ value, done: false })
    }
  }

  end(): void {
    if (this.ended) return
    this.ended = true
    this.enqueue({ done: true })
  }

  fail(error: Error): void {
    if (this.ended) return
    this.ended = true
    this.enqueue({ done: true, error })
  }

  async *generator(): AsyncGenerator<TOut> {
    while (true) {
      const item = await this.dequeue()
      if (item.error) throw item.error
      if (item.done) return
      yield item.value!
    }
  }

  private enqueue(item: QueuedItem<TOut>): void {
    const waiter = this.waiters.shift()
    if (waiter) {
      waiter(item)
    } else {
      this.queue.push(item)
    }
  }

  private dequeue(): Promise<QueuedItem<TOut>> {
    const item = this.queue.shift()
    if (item) return Promise.resolve(item)
    return new Promise(resolve => {
      this.waiters.push(resolve)
    })
  }
}

/**
 * Simple semaphore for concurrency control.
 * Limits the number of concurrent async operations.
 */
export class Semaphore {
  private permits: number
  private readonly maxPermits: number
  private queue: Array<() => void> = []

  constructor(maxPermits: number) {
    this.permits = maxPermits
    this.maxPermits = maxPermits
  }

  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--
      return
    }
    return new Promise<void>((resolve) => {
      this.queue.push(resolve)
    })
  }

  release(): void {
    if (this.queue.length > 0) {
      const next = this.queue.shift()!
      next()
    } else if (this.permits < this.maxPermits) {
      this.permits++
    } else {
      // Double-release or release without acquire — silently ignore.
      // The previous implementation would let permits grow unbounded, which
      // effectively disabled the semaphore's concurrency limit.
      console.warn(`[Semaphore] release() called with permits=${this.permits}, maxPermits=${this.maxPermits} — ignoring double release`)
    }
  }

  get available(): number {
    return this.permits
  }

  get queued(): number {
    return this.queue.length
  }
}

export type CircuitState = 'closed' | 'open' | 'half-open'

export interface CircuitBreakerOptions {
  /** Minimum number of requests before evaluating the error percentage */
  volumeThreshold: number
  /** Error percentage that trips the breaker (0-100) */
  errorThresholdPercentage: number
  /** Time in ms to wait before transitioning from open to half-open */
  resetTimeoutMs: number
}

const DEFAULT_OPTIONS: CircuitBreakerOptions = {
  volumeThreshold: 5,
  errorThresholdPercentage: 50,
  resetTimeoutMs: 300_000, // 5 minutes
}

/**
 * Lightweight circuit breaker — no external dependencies (opossum etc.).
 * Protects downstream resources from cascading failures.
 */
export class CircuitBreaker {
  private state: CircuitState = 'closed'
  private failureCount = 0
  private successCount = 0
  private lastFailureTime = 0
  private halfOpenInFlight = false
  private readonly options: CircuitBreakerOptions

  constructor(options: Partial<CircuitBreakerOptions> = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options }
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'open') {
      if (Date.now() - this.lastFailureTime >= this.options.resetTimeoutMs) {
        this.state = 'half-open'
      } else {
        throw new CircuitBreakerOpenError()
      }
    }

    // half-open: only allow one probe request at a time
    if (this.state === 'half-open') {
      if (this.halfOpenInFlight) {
        throw new CircuitBreakerOpenError()
      }
      this.halfOpenInFlight = true
    }

    try {
      const result = await fn()
      this.onSuccess()
      return result
    } catch (err: unknown) {
      this.onFailure()
      throw err
    } finally {
      if (this.state === 'half-open' || this.state === 'closed' || this.state === 'open') {
        this.halfOpenInFlight = false
      }
    }
  }

  getState(): CircuitState {
    return this.state
  }

  reset(): void {
    this.state = 'closed'
    this.failureCount = 0
    this.successCount = 0
    this.lastFailureTime = 0
  }

  // ── Private ────────────────────────────────────────────────────────

  private onSuccess(): void {
    this.successCount++
    this.failureCount = 0
    if (this.state === 'half-open') {
      this.state = 'closed'
    }
  }

  private onFailure(): void {
    this.failureCount++
    this.lastFailureTime = Date.now()

    const total = this.failureCount + this.successCount
    if (
      total >= this.options.volumeThreshold &&
      (this.failureCount / total) * 100 >= this.options.errorThresholdPercentage
    ) {
      this.state = 'open'
    }
  }
}

export class CircuitBreakerOpenError extends Error {
  constructor() {
    super('Circuit breaker is open — requests are temporarily rejected')
    this.name = 'CircuitBreakerOpenError'
  }
}

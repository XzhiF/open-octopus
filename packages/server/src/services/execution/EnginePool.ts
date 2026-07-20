// packages/server/src/services/execution/EnginePool.ts
import type { WorkflowEngine } from "@octopus/engine"

export interface EngineInstance {
  engine: WorkflowEngine
  abortController: AbortController
  approvalTimer?: ReturnType<typeof setTimeout>
  /** Promise tracking the in-flight engine.run() / retryFrom() call.
   *  Resolves when the engine's current top-level execution settles.
   *  Used by abortAndWait/resume to avoid racing a still-running engine. */
  runPromise?: Promise<void>
  runPromiseResolve?: () => void
}

export class EnginePool {
  private pool = new Map<string, EngineInstance>()

  get(id: string): EngineInstance | undefined {
    return this.pool.get(id)
  }

  set(id: string, instance: EngineInstance): void {
    this.pool.set(id, instance)
  }

  /** Alias for set() — backward compat with execution.ts code */
  create(id: string, engine: WorkflowEngine, abortController: AbortController): void {
    this.pool.set(id, { engine, abortController })
  }

  /** Begin tracking an in-flight engine execution. Returns a resolve fn to call when it settles. */
  startRun(id: string): () => void {
    const inst = this.pool.get(id)
    let resolve!: () => void
    const promise = new Promise<void>(r => { resolve = r })
    if (inst) {
      inst.runPromise = promise
      inst.runPromiseResolve = resolve
    }
    return () => {
      const cur = this.pool.get(id)
      // Call the stored resolver (handles cases where the instance was replaced)
      if (cur?.runPromiseResolve) cur.runPromiseResolve()
      else resolve()
    }
  }

  /** Wait for the engine's current run to settle. No-op if not running or already removed. */
  async waitForSettled(id: string, timeoutMs = 60000): Promise<void> {
    const inst = this.pool.get(id)
    if (!inst?.runPromise) return
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        inst.runPromise,
        new Promise<void>(r => { timer = setTimeout(() => r(), timeoutMs) }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  /** Alias for delete() — backward compat with execution.ts code */
  remove(id: string): void {
    const inst = this.pool.get(id)
    if (inst?.approvalTimer) {
      clearTimeout(inst.approvalTimer)
    }
    this.pool.delete(id)
  }

  delete(id: string): boolean {
    const inst = this.pool.get(id)
    if (inst?.approvalTimer) {
      clearTimeout(inst.approvalTimer)
    }
    return this.pool.delete(id)
  }

  /** Cancel execution: abort controller + clear timers + remove from pool */
  cancel(id: string): boolean {
    const inst = this.pool.get(id)
    if (!inst) return false
    if (inst.approvalTimer) {
      clearTimeout(inst.approvalTimer)
      inst.approvalTimer = undefined
    }
    inst.abortController.abort()
    this.pool.delete(id)
    return true
  }

  has(id: string): boolean {
    return this.pool.has(id)
  }

  clear(): void {
    for (const inst of this.pool.values()) {
      if (inst.approvalTimer) clearTimeout(inst.approvalTimer)
    }
    this.pool.clear()
  }

  setApprovalTimer(id: string, timer: ReturnType<typeof setTimeout>): void {
    const inst = this.pool.get(id)
    if (inst) {
      inst.approvalTimer = timer
    }
  }

  clearApprovalTimer(id: string): void {
    const inst = this.pool.get(id)
    if (inst?.approvalTimer) {
      clearTimeout(inst.approvalTimer)
      inst.approvalTimer = undefined
    }
  }

  getAll(): Map<string, EngineInstance> {
    return new Map(this.pool)
  }
}

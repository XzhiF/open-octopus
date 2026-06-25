export class VarPool {
  private vars: Map<string, any>
  private dirty: Set<string> = new Set()
  /** Optional resolver for $ref: cross-execution references. Set by ExecutionService. */
  private refResolver?: (refPath: string) => any

  constructor(initial?: Record<string, any>) {
    this.vars = new Map(Object.entries(initial ?? {}))
  }

  get(key: string): any | undefined {
    return this.vars.get(key)
  }

  set(key: string, value: any): void {
    this.vars.set(key, value)
    this.dirty.add(key)
  }

  update(data: Record<string, any>): void {
    for (const [k, v] of Object.entries(data)) {
      this.vars.set(k, v)
      this.dirty.add(k)
    }
  }

  snapshot(): Record<string, any> {
    return Object.fromEntries(this.vars)
  }

  asRecord(): Record<string, any> {
    return Object.fromEntries(this.vars)
  }

  fork(): VarPool {
    // Child inherits all data but starts with an empty dirty set —
    // only its own set()/update() calls are tracked as dirty.
    const child = new VarPool(this.snapshot())
    // Propagate refResolver to forked pools so $ref: works in parallel execution
    child.refResolver = this.refResolver
    return child
  }

  merge(forks: VarPool[]): void {
    for (const fork of forks) {
      // Only merge keys that were actually modified in this fork.
      // Unchanged inherited keys are skipped to avoid overwriting
      // sibling forks' real changes with stale copies.
      for (const key of fork.dirty) {
        this.vars.set(key, fork.vars.get(key))
      }
    }
  }

  removePrefix(prefix: string): void {
    for (const key of Array.from(this.vars.keys())) {
      if (key.startsWith(prefix)) {
        this.vars.delete(key)
      }
    }
  }

  // ── Cross-execution $ref: support ──────────────────────────

  /**
   * Set the resolver function for $ref: references.
   * Called by ExecutionService to inject DB-backed resolution.
   */
  setRefResolver(resolver: (refPath: string) => any): void {
    this.refResolver = resolver
  }

  /**
   * Resolve a $ref: cross-execution reference path.
   * Format: "workflowRef.nodeId.outputKey"
   * Returns undefined if no resolver is set or the reference cannot be resolved.
   */
  resolveRef(refPath: string): any {
    if (!this.refResolver) return undefined
    try {
      return this.refResolver(refPath)
    } catch {
      return undefined
    }
  }

  /** Check if a refResolver is configured. */
  hasRefResolver(): boolean {
    return this.refResolver !== undefined
  }
}
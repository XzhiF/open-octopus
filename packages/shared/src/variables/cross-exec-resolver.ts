// packages/shared/src/variables/cross-exec-resolver.ts

export interface ExecutionPoolSnapshot {
  var_pool?: Record<string, any>
}

export interface ExecutionLookup {
  getById(id: string): { parent_id?: string | null; var_pool?: string | null; input_values?: string | null } | null | undefined
  getNodeOutputs?(executionId: string, nodeId: string): Record<string, any> | null | undefined
}

export class CrossExecResolver {
  constructor(private lookup: ExecutionLookup) {}

  /**
   * Resolve cross-execution variable references.
   *
   * Supported patterns:
   *   $parent.var_pool.<var>              → parent execution's var_pool
   *   $parent.input_values.<key>          → parent execution's input values
   *   $parent.$<nodeId>.outputs.<key>     → parent execution's specific node output
   *   $ancestor[N].var_pool.<var>         → N-level ancestor's var_pool
   *   $ancestor[N].input_values.<key>     → N-level ancestor's input values
   *   $ancestor[N].$<nodeId>.outputs.<key>→ N-level ancestor's specific node output
   *
   * Ancestor indexing is 0-based: ancestor[0] = parent, ancestor[1] = grandparent, etc.
   */
  resolve(text: string, currentExecutionId: string): string {
    // $parent.var_pool.<var>
    text = text.replace(
      /\$parent\.var_pool\.(\w+)/g,
      (match, key: string) => {
        const pool = this.getResolvedPool(currentExecutionId, "parent")
        return pool[key] ?? match
      },
    )

    // $parent.input_values.<key>
    text = text.replace(
      /\$parent\.input_values\.(\w+)/g,
      (match, key: string) => {
        const inputs = this.getInputValues(currentExecutionId, "parent")
        return inputs[key] ?? match
      },
    )

    // $ancestor[N].var_pool.<var>
    text = text.replace(
      /\$ancestor\[(\d+)\]\.var_pool\.(\w+)/g,
      (match, levelStr: string, key: string) => {
        const pool = this.getResolvedPool(
          currentExecutionId,
          "ancestor",
          parseInt(levelStr, 10),
        )
        return pool[key] ?? match
      },
    )

    // $ancestor[N].input_values.<key>
    text = text.replace(
      /\$ancestor\[(\d+)\]\.input_values\.(\w+)/g,
      (match, levelStr: string, key: string) => {
        const inputs = this.getInputValues(
          currentExecutionId,
          "ancestor",
          parseInt(levelStr, 10),
        )
        return inputs[key] ?? match
      },
    )

    // $parent.$<nodeId>.outputs.<key>
    text = text.replace(
      /\$parent\.\$([\w-]+)\.outputs\.(\w+)/g,
      (match, nodeId: string, key: string) => {
        const output = this.getNodeOutput(currentExecutionId, "parent", nodeId)
        return output?.[key] ?? match
      },
    )

    // $ancestor[N].$<nodeId>.outputs.<key>
    text = text.replace(
      /\$ancestor\[(\d+)\]\.\$([\w-]+)\.outputs\.(\w+)/g,
      (match, levelStr: string, nodeId: string, key: string) => {
        const output = this.getNodeOutput(
          currentExecutionId,
          "ancestor",
          nodeId,
          parseInt(levelStr, 10),
        )
        return output?.[key] ?? match
      },
    )

    return text
  }

  /**
   * Check whether the text contains any cross-execution variable references.
   */
  hasCrossExecRefs(text: string): boolean {
    return /\$(?:parent|ancestor\[\d+\])\.(?:var_pool|input_values|\$[\w-]+\.outputs)\.\w+/.test(text)
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Resolve the var_pool for a parent or ancestor execution.
   *
   * Format detection (applied to the parsed JSON of the var_pool column):
   *  - Has "var_pool" key    → nested format, use .var_pool
   *  - Has "poolSnapshot" key→ legacy nested format, use .poolSnapshot
   *  - Otherwise             → flat format (entire object is the pool)
   */
  private getResolvedPool(
    executionId: string,
    type: "parent" | "ancestor",
    ancestorLevel?: number,
  ): Record<string, any> {
    const raw =
      type === "parent"
        ? this.getParentPool(executionId)
        : this.getAncestorPool(executionId, ancestorLevel ?? 0)

    if (!raw) return {}

    // Nested format (current)
    if (raw.var_pool && typeof raw.var_pool === "object") {
      return raw.var_pool
    }
    // Nested format (legacy — backward compatible)
    if (raw.poolSnapshot && typeof raw.poolSnapshot === "object") {
      return raw.poolSnapshot
    }
    // Flat format — the entire object IS the pool
    return raw
  }

  /**
   * Retrieve a specific node's output record from a parent or ancestor execution.
   * Returns null when the lookup does not support node-level queries, the
   * target execution cannot be reached, or the node output is not found.
   */
  private getNodeOutput(
    executionId: string,
    type: "parent" | "ancestor",
    nodeId: string,
    ancestorLevel?: number,
  ): Record<string, any> | null {
    if (!this.lookup.getNodeOutputs) return null

    const targetId =
      type === "parent"
        ? this.getParentId(executionId)
        : this.getAncestorId(executionId, ancestorLevel ?? 0)

    if (!targetId) return null
    return this.lookup.getNodeOutputs(targetId, nodeId) ?? null
  }

  /**
   * Resolve the input_values for a parent or ancestor execution.
   * input_values is always stored as flat JSON: {"key1":"val1","key2":"val2"}
   */
  private getInputValues(
    executionId: string,
    type: "parent" | "ancestor",
    ancestorLevel?: number,
  ): Record<string, any> {
    const targetId =
      type === "parent"
        ? this.getParentId(executionId)
        : this.getAncestorId(executionId, ancestorLevel ?? 0)

    if (!targetId) return {}

    const target = this.lookup.getById(targetId)
    if (!target?.input_values) return {}

    try {
      const parsed = JSON.parse(target.input_values)
      return parsed && typeof parsed === "object" ? parsed : {}
    } catch {
      return {}
    }
  }

  /** Return the parent execution's ID, or null if unreachable. */
  private getParentId(executionId: string): string | null {
    const execution = this.lookup.getById(executionId)
    if (!execution?.parent_id || execution.parent_id === "0") return null
    return execution.parent_id
  }

  /** Walk the parent_id chain to find the N-level ancestor's execution ID (0-based). */
  private getAncestorId(executionId: string, level: number): string | null {
    let current = executionId
    for (let i = 0; i <= level; i++) {
      const execution = this.lookup.getById(current)
      if (!execution?.parent_id || execution.parent_id === "0") return null
      current = execution.parent_id
    }
    return current
  }

  /** Parse and return the parent execution's var_pool JSON, or null. */
  private getParentPool(executionId: string): Record<string, any> | null {
    const execution = this.lookup.getById(executionId)
    if (!execution?.parent_id || execution.parent_id === "0") return null

    const parent = this.lookup.getById(execution.parent_id)
    return this.parseVarPool(parent?.var_pool)
  }

  /**
   * Walk the parent_id chain (0-based indexing: level 0 = parent) and return
   * the ancestor execution's parsed var_pool JSON, or null.
   */
  private getAncestorPool(executionId: string, level: number): Record<string, any> | null {
    let current = executionId
    for (let i = 0; i <= level; i++) {
      const execution = this.lookup.getById(current)
      if (!execution?.parent_id || execution.parent_id === "0") return null
      current = execution.parent_id
    }

    const ancestor = this.lookup.getById(current)
    return this.parseVarPool(ancestor?.var_pool)
  }

  /**
   * Parse a var_pool JSON string and apply format detection.
   *
   * - Parsed object has "var_pool" key    → nested format, return .var_pool
   * - Parsed object has "poolSnapshot" key→ legacy nested format, return .poolSnapshot
   * - Otherwise                           → flat format, return entire object
   */
  private parseVarPool(raw?: string | null): Record<string, any> | null {
    if (!raw) return null
    try {
      const parsed = JSON.parse(raw)
      if (parsed?.var_pool && typeof parsed.var_pool === "object") {
        return parsed.var_pool
      }
      if (parsed?.poolSnapshot && typeof parsed.poolSnapshot === "object") {
        return parsed.poolSnapshot
      }
      return parsed
    } catch {
      return null
    }
  }
}

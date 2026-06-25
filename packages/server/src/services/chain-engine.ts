// packages/server/src/services/chain-engine.ts
import type { ChainConfig, ChainRetry, PipelineConfig } from "@octopus/shared"
import type { ExecutionDAO } from "../db/dao/execution-dao"
import type { ExecutionLifecycle } from "./execution/ExecutionLifecycle"
import type { PipelineConfigLoader } from "./pipeline-config"
import type { SSEService } from "./sse"
import { EventEmitter } from "events"
import { createHash } from "crypto"

export interface ChainResult {
  status: "completed" | "failed" | "stopped" | "timeout"
  executedCount: number
  failedExecution?: string
  chainRetryCount: number
}

interface TreeNode {
  executionId: string
  status: string
  children: TreeNode[]
}

export class ChainEngine {
  private config: PipelineConfig | null
  private configSnapshot: PipelineConfig | null = null
  private running = false
  private abortController: AbortController | null = null
  private executionEmitter = new EventEmitter()
  private executionTimeouts = new Map<string, NodeJS.Timeout>()

  constructor(
    private dao: ExecutionDAO,
    private lifecycle: ExecutionLifecycle,
    private configLoader: PipelineConfigLoader,
    private sse: SSEService,
  ) {
    this.config = configLoader.getConfig()
  }

  /**
   * Register execution completion callback (called by ExecutionService)
   */
  registerExecutionCallback(): void {
    // ExecutionService calls this when an execution completes
    this.lifecycle.setChainCallback((executionId: string, status: string) => {
      this.executionEmitter.emit(`execution:${executionId}`, { executionId, status })
    })
  }

  /**
   * Start execution chain
   * @param rootExecutionId Root execution ID
   */
  async startChain(rootExecutionId: string): Promise<ChainResult> {
    if (this.running) {
      throw new Error("Chain is already running")
    }

    this.config = this.configLoader.getConfig()
    if (!this.config?.chain?.auto_execute) {
      return { status: "stopped", executedCount: 0, chainRetryCount: 0 }
    }

    // Save config snapshot for change detection
    this.configSnapshot = this.config

    this.running = true
    this.abortController = new AbortController()
    this.registerExecutionCallback()

    // Emit chain:started event
    this.sse.emit("chain:started", {
      rootExecutionId,
      config: this.config.chain,
    })

    const startTime = Date.now()

    try {
      const tree = this.buildTree(rootExecutionId)
      const result = await this.executeTree(tree, this.config.chain)

      // Emit chain:completed event
      this.sse.emit("chain:completed", {
        status: result.status,
        totalDuration: Date.now() - startTime,
        executedCount: result.executedCount,
      })

      return result
    } catch (error) {
      // Emit chain:stopped event
      this.sse.emit("chain:stopped", {
        executedCount: 0,
      })
      throw error
    } finally {
      this.running = false
      this.abortController = null
      this.clearAllTimeouts()
    }
  }

  /**
   * Stop execution chain
   */
  stop(): void {
    if (this.abortController) {
      this.abortController.abort()
    }
    this.clearAllTimeouts()
  }

  /**
   * Get current chain status
   */
  getStatus(): { running: boolean; config: PipelineConfig | null } {
    return {
      running: this.running,
      config: this.config,
    }
  }

  /**
   * Execution completion callback (called by ExecutionService)
   * Re-read tree to adapt to dynamic modifications
   */
  async onExecutionComplete(executionId: string): Promise<void> {
    if (!this.running || !this.config?.chain?.auto_execute) {
      return
    }

    // Re-read tree (includes user's latest add/delete operations)
    const execution = this.dao.findById(executionId)
    if (!execution || !execution.parent_id || execution.parent_id === "0") {
      return // Root node completed, chain ends
    }

    const rootId = this.findRoot(executionId)
    const tree = this.buildTree(rootId)
    const nextNode = this.findNextNode(tree, executionId)

    if (nextNode && this.config.chain.on_success === "continue") {
      await this.executeTree(nextNode, this.config.chain)
    }
  }

  private buildTree(rootId: string): TreeNode {
    const execution = this.dao.findById(rootId)
    if (!execution) {
      throw new Error(`Execution ${rootId} not found`)
    }

    const children = this.dao.findChildren(rootId)
    return {
      executionId: rootId,
      status: execution.status,
      children: children.map(child => this.buildTree(child.id)),
    }
  }

  private async executeTree(node: TreeNode, config: ChainConfig): Promise<ChainResult> {
    if (this.abortController?.signal.aborted) {
      return { status: "stopped", executedCount: 0, chainRetryCount: 0 }
    }

    // Check config change strategy
    if (this.configSnapshot) {
      const currentConfig = this.configLoader.getConfig()
      const currentHash = this.configLoader.getConfigHash()
      const snapshotHash = this.calculateConfigHash(this.configSnapshot)

      if (currentHash !== snapshotHash) {
        const strategy = this.configSnapshot.chain?.config_change_strategy ?? "snapshot"

        if (strategy === "abort") {
          throw new Error("Pipeline config changed during execution, aborting (strategy: abort)")
        }
        // strategy === "snapshot": continue with snapshot config, ignore changes
      }
    }

    let executedCount = 0
    let chainRetryCount = 0

    // 1. Execute current node (if pending)
    if (node.status === "pending") {
      // Emit chain:execution:started event
      this.sse.emit("chain:execution:started", {
        executionId: node.executionId,
      })

      // Read input_values from execution record and pass to start()
      // This triggers CrossExecResolver to resolve $parent.var_pool.* references
      const execution = this.dao.findById(node.executionId)
      const inputValues = execution?.input_values ? JSON.parse(execution.input_values) : undefined

      await this.lifecycle.start(node.executionId, inputValues)
      executedCount++
    }

    const startTime = Date.now()

    // 2. Wait for execution completion (event-driven)
    const execution = await this.waitForCompletion(node.executionId)

    // 3. Handle failure or cancellation
    if (execution.status === "cancelled" || execution.status === "rejected") {
      // Parent was cancelled/rejected — stop the chain, don't execute children
      this.sse.emit("chain:execution:cancelled", {
        executionId: node.executionId,
        status: execution.status,
      })
      return { status: "stopped", executedCount, chainRetryCount }
    }

    if (execution.status === "failed") {
      // Emit chain:execution:failed event
      this.sse.emit("chain:execution:failed", {
        executionId: node.executionId,
        error: execution.var_pool ? JSON.parse(execution.var_pool).error : "Unknown error",
      })

      if (config.failure_strategy === "stop") {
        return { status: "failed", executedCount, failedExecution: node.executionId, chainRetryCount }
      } else if (config.failure_strategy === "retry_leaf" && node.children.length === 0) {
        // Retry leaf node
        const retryResult = await this.retryLeaf(node.executionId)
        chainRetryCount += retryResult.chainRetryCount
        if (retryResult.status === "failed") {
          return { ...retryResult, executedCount: executedCount + retryResult.executedCount }
        }
        executedCount += retryResult.executedCount
      }
      // continue: skip current node, continue to children
    } else {
      // Emit chain:execution:completed event
      this.sse.emit("chain:execution:completed", {
        executionId: node.executionId,
        status: execution.status,
        duration: Date.now() - startTime,
      })
    }

    // 4. Recursively execute children (in child_index order)
    for (const child of node.children) {
      if (this.abortController?.signal.aborted) {
        break
      }

      const childResult = await this.executeTree(child, config)
      executedCount += childResult.executedCount
      chainRetryCount += childResult.chainRetryCount

      if (childResult.status === "failed" && config.failure_strategy === "stop") {
        return { ...childResult, executedCount, chainRetryCount }
      }
    }

    return { status: "completed", executedCount, chainRetryCount }
  }

  private async retryLeaf(executionId: string): Promise<ChainResult> {
    const chainRetry = this.config!.chain_retry!
    let attempts = 0
    const maxAttempts = chainRetry.max_attempts

    while (attempts < maxAttempts) {
      if (this.abortController?.signal.aborted) {
        return { status: "stopped", executedCount: 0, chainRetryCount: attempts }
      }

      attempts++
      const delay = this.calculateBackoff(attempts, chainRetry)
      await this.sleep(delay)

      // Emit chain:retry event
      this.sse.emit("chain:retry", {
        executionId,
        attempt: attempts,
        maxAttempts,
      })

      try {
        await this.lifecycle.retry(executionId, executionId)
        const execution = await this.waitForCompletion(executionId)

        if (execution.status === "completed") {
          return { status: "completed", executedCount: 1, chainRetryCount: attempts }
        }
      } catch (error) {
        console.error(`Retry attempt ${attempts} failed:`, error)
      }
    }

    return { status: "failed", executedCount: 1, failedExecution: executionId, chainRetryCount: attempts }
  }

  private async waitForCompletion(executionId: string): Promise<any> {
    const execution = this.dao.findById(executionId)
    if (!execution) {
      throw new Error(`Execution ${executionId} not found`)
    }

    // Already completed, return directly
    if (["completed", "failed", "cancelled", "rejected"].includes(execution.status)) {
      return execution
    }

    // Set timeout (per-execution timeout)
    const timeout = this.config?.execution?.timeout ?? 86400 // Default 24 hours
    const timeoutPromise = new Promise<never>((_, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Execution ${executionId} timed out after ${timeout}s`))
      }, timeout * 1000)
      this.executionTimeouts.set(executionId, timer)
    })

    // Wait for execution completion event
    const completionPromise = new Promise<any>((resolve, reject) => {
      const handler = (data: { executionId: string; status: string }) => {
        this.executionEmitter.removeListener(`execution:${executionId}`, handler)
        this.clearTimeout(executionId)

        const updatedExecution = this.dao.findById(executionId)
        if (!updatedExecution) {
          reject(new Error(`Execution ${executionId} not found`))
        } else {
          resolve(updatedExecution)
        }
      }

      this.executionEmitter.on(`execution:${executionId}`, handler)

      // Handle abort
      if (this.abortController) {
        this.abortController.signal.addEventListener("abort", () => {
          this.executionEmitter.removeListener(`execution:${executionId}`, handler)
          this.clearTimeout(executionId)
          reject(new Error("Chain aborted"))
        })
      }
    })

    // Wait for completion or timeout
    return Promise.race([completionPromise, timeoutPromise])
  }

  private clearTimeout(executionId: string): void {
    const timer = this.executionTimeouts.get(executionId)
    if (timer) {
      clearTimeout(timer)
      this.executionTimeouts.delete(executionId)
    }
  }

  private clearAllTimeouts(): void {
    for (const timer of this.executionTimeouts.values()) {
      clearTimeout(timer)
    }
    this.executionTimeouts.clear()
  }

  private findNextNode(tree: TreeNode, completedId: string): TreeNode | null {
    // Find the next sibling of completedId or the next sibling of its parent
    const path = this.findPath(tree, completedId)
    if (!path) return null

    // Search from the end of the path upward to find a node with a next sibling
    for (let i = path.length - 1; i >= 0; i--) {
      const node = path[i]
      const parent = i > 0 ? path[i - 1] : null
      if (parent) {
        const siblings = parent.children
        const index = siblings.indexOf(node)
        if (index < siblings.length - 1) {
          return siblings[index + 1]
        }
      }
    }

    return null
  }

  private findPath(node: TreeNode, targetId: string, path: TreeNode[] = []): TreeNode[] | null {
    const currentPath = [...path, node]
    if (node.executionId === targetId) {
      return currentPath
    }

    for (const child of node.children) {
      const result = this.findPath(child, targetId, currentPath)
      if (result) return result
    }

    return null
  }

  private findRoot(executionId: string): string {
    let current = executionId
    while (true) {
      const execution = this.dao.findById(current)
      if (!execution || !execution.parent_id || execution.parent_id === "0") {
        return current
      }
      current = execution.parent_id
    }
  }

  private calculateBackoff(attempt: number, config: ChainRetry): number {
    const { type, initial_delay, multiplier, max_delay } = config.backoff
    let delay: number

    switch (type) {
      case "exponential":
        delay = initial_delay * Math.pow(multiplier, attempt - 1)
        break
      case "fixed":
        delay = initial_delay
        break
      case "linear":
        delay = initial_delay * attempt
        break
      default:
        delay = initial_delay
    }

    return Math.min(delay, max_delay) * 1000 // Convert to milliseconds
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
  }

  private calculateConfigHash(config: PipelineConfig): string {
    return createHash("sha256").update(JSON.stringify(config)).digest("hex")
  }
}

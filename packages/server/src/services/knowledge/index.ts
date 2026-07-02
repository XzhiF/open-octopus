// packages/server/src/services/knowledge/index.ts
import type { VarPool } from "@octopus/shared"
import type { KnowledgeEffectivenessDAO, PendingReviewDAO } from "../../db/dao"
import { precomputeRelevantRules } from "./precompute"
import { KnowledgeInjector } from "@octopus/engine"
import { trackEffectiveness, retireStaleRules } from "./effectiveness"
import { checkCompactThreshold } from "./maintenance"
import type { ExecResult } from "./effectiveness"

/**
 * KnowledgeService — wires up the knowledge injection pipeline and lifecycle hooks.
 *
 * This service provides:
 * 1. precomputeHook: called before node execution to populate VarPool with relevant rules
 * 2. knowledgeInjectorFactory: creates KnowledgeInjector instances from VarPool
 * 3. trackEffectiveness: called after execution to track rule helpfulness
 * 4. checkCompactThreshold: called after rule addition to check if file needs compacting
 * 5. retireStaleRules: called periodically to retire low-confidence rules
 */
export class KnowledgeService {
  private repoNames: string[] = []
  private workflowName?: string

  constructor(
    private effectivenessDAO: KnowledgeEffectivenessDAO,
    private pendingReviewDAO: PendingReviewDAO,
    private org: string,
  ) {}

  /**
   * Set the execution context for scope filtering.
   * Called before workflow execution to tell the precompute hook
   * which repos and workflow are currently running.
   */
  setExecutionContext(repoNames: string[], workflowName: string): void {
    this.repoNames = repoNames
    this.workflowName = workflowName
  }

  /**
   * Create a precompute hook that populates VarPool with relevant knowledge rules.
   * Called by the engine before node execution.
   */
  createPrecomputeHook() {
    return async (pool: VarPool, workflowName: string, inputs: Record<string, string>) => {
      await precomputeRelevantRules(
        this.org,
        this.repoNames,
        workflowName,
        inputs,
        pool,
      )
    }
  }

  /**
   * Create a factory that produces KnowledgeInjector instances from VarPool.
   * Called by the engine to inject knowledge into agent prompts.
   */
  createInjectorFactory() {
    return (pool: VarPool) => new KnowledgeInjector(pool)
  }

  /**
   * Track effectiveness of injected rules after execution completes.
   * Called by ExecutionLifecycle after each execution.
   */
  trackExecutionEffectiveness(execResult: ExecResult): number {
    return trackEffectiveness(execResult, this.effectivenessDAO, this.org)
  }

  /**
   * Check if a knowledge file needs compacting after rules are added.
   * Called after approveItem adds new rules to a file.
   */
  checkFileCompactThreshold(fileName: string, threshold = 100): void {
    try {
      checkCompactThreshold(this.org, fileName, threshold, this.pendingReviewDAO)
    } catch (err) {
      console.warn("[knowledge] checkCompactThreshold failed:", err)
    }
  }

  /**
   * Retire stale rules that have low confidence and haven't been helpful.
   * Called periodically or after execution completes.
   */
  retireStaleRules(minInjected = 3, maxConfidence = 0.2, daysSinceLastInjected = 30): number {
    return retireStaleRules(this.effectivenessDAO, this.org, minInjected, maxConfidence, daysSinceLastInjected)
  }
}

/**
 * Create a KnowledgeService instance with the given DAOs and org.
 */
export function createKnowledgeService(
  effectivenessDAO: KnowledgeEffectivenessDAO,
  pendingReviewDAO: PendingReviewDAO,
  org: string,
): KnowledgeService {
  return new KnowledgeService(effectivenessDAO, pendingReviewDAO, org)
}

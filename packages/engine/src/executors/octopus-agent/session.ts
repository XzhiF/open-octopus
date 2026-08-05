// packages/engine/src/executors/octopus-agent/session.ts
//
// Delegate session creation for octopus_agent nodes.
// Creates a new session with session_type='delegate' for isolated execution.
//

import crypto from "crypto"

/**
 * Delegate session metadata.
 */
export interface DelegateSession {
  id: string
  session_type: "delegate"
  clone_name: string
  version: string
  parent_execution_id: string
  created_at: string
}

/**
 * Session creation callback type.
 * The engine injects this via OctopusAgentConfig to decouple from server package.
 */
export type CreateSessionFn = (params: {
  session_type: "delegate"
  clone_name: string
  version: string
  parent_execution_id: string
  metadata?: Record<string, unknown>
}) => Promise<DelegateSession> | DelegateSession

/**
 * Create a delegate session for octopus_agent execution.
 *
 * This is a default implementation that generates a session ID and metadata.
 * In production, the engine injects a real CreateSessionFn that calls SessionService.
 *
 * @param cloneName - Name of the clone/agent being delegated to
 * @param version - Resolved version string
 * @param parentExecutionId - Parent workflow execution ID
 * @returns DelegateSession object
 */
export function createDelegateSession(
  cloneName: string,
  version: string,
  parentExecutionId: string,
): DelegateSession {
  return {
    id: crypto.randomUUID(),
    session_type: "delegate",
    clone_name: cloneName,
    version,
    parent_execution_id: parentExecutionId,
    created_at: new Date().toISOString(),
  }
}

// packages/server/src/services/harness/action-registry.ts
//
// ActionRegistry — maps action type strings to ActionHandler implementations.
// Ships with built-in handlers for all default action types.
// Supports registering custom handlers for extensibility.

import type { ActionHandler } from "./action-types"
import type { InterventionResult, ActionContext } from "./action-types"

/**
 * Built-in abort handler — the only action kept in the Strategy Engine.
 * All other actions are now handled by the Harness Agent (Layer 3).
 */
const abortHandler: ActionHandler = async (ctx) => {
  const { strategyAction } = ctx
  const reason = (strategyAction.reason as string) ?? "Harness intervention: abort"

  return {
    success: true,
    action: "abort",
    message: reason,
    details: { reason },
  }
}

export class ActionRegistry {
  private handlers = new Map<string, ActionHandler>()

  constructor() {
    // Only abort is kept — process_conflict sync domain still needs it.
    // All other actions (inject_message, modify_varpool, modify_definition,
    // switch_model, retry_with_hint, pause, pause_and_notify) have been
    // moved to the Harness Agent (Layer 3).
    this.handlers.set("abort", abortHandler)
  }

  /**
   * Get the handler for a given action type.
   * Returns undefined if no handler is registered.
   */
  get(type: string): ActionHandler | undefined {
    return this.handlers.get(type)
  }

  /**
   * Check if a handler is registered for the given action type.
   */
  has(type: string): boolean {
    return this.handlers.has(type)
  }

  /**
   * Register a custom action handler. Overwrites any existing handler
   * for the same type.
   */
  register(type: string, handler: ActionHandler): void {
    this.handlers.set(type, handler)
  }

  /**
   * Execute a single action using the provided context.
   * Returns a failure result if no handler is registered for the action type.
   */
  async execute(ctx: ActionContext): Promise<InterventionResult> {
    const handler = this.handlers.get(ctx.strategyAction.type)
    if (!handler) {
      return {
        success: false,
        action: ctx.strategyAction.type,
        message: `No handler registered for action type: ${ctx.strategyAction.type}`,
      }
    }

    try {
      return await handler(ctx)
    } catch (err) {
      return {
        success: false,
        action: ctx.strategyAction.type,
        message: `Action execution error: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
  }
}

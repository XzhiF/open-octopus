// packages/server/src/services/harness/action-registry.ts
//
// ActionRegistry — maps action type strings to ActionHandler implementations.
// Ships with built-in handlers for all default action types.
// Supports registering custom handlers for extensibility.

import type { ActionHandler } from "./action-types"
import type { InterventionResult, ActionContext } from "./action-types"
import { injectMessageHandler } from "./actions/inject-message"
import { agentTakeoverHandler } from "./actions/agent-takeover"
import { modifyVarpoolHandler } from "./actions/modify-varpool"
import { modifyDefinitionHandler } from "./actions/modify-definition"
import { switchModelHandler } from "./actions/switch-model"

/**
 * Built-in simple action handlers for actions that don't need complex logic.
 */
const retryWithHintHandler: ActionHandler = async (ctx) => {
  const { strategyAction } = ctx
  const hint = (strategyAction.message as string) ??
    (strategyAction.hint as string) ??
    "Try a different approach to solve this problem."

  return {
    success: true,
    action: "retry_with_hint",
    message: `Will retry with harness hint: ${hint.slice(0, 80)}`,
    harnessHint: hint,
  }
}

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

const pauseHandler: ActionHandler = async (ctx) => {
  const { report, strategyAction } = ctx
  const notify = strategyAction.notify === true

  return {
    success: true,
    action: "pause",
    message: `Paused execution for node ${report.nodeId}${notify ? " (notification sent)" : ""}`,
    details: { notify },
  }
}

const pauseAndNotifyHandler: ActionHandler = async (ctx) => {
  const { report } = ctx

  return {
    success: true,
    action: "pause_and_notify",
    message: `Paused execution and notified user for node ${report.nodeId}`,
    details: { notify: true },
  }
}

export class ActionRegistry {
  private handlers = new Map<string, ActionHandler>()

  constructor() {
    // Register all built-in handlers
    this.handlers.set("inject_message", injectMessageHandler)
    this.handlers.set("agent_takeover", agentTakeoverHandler)
    this.handlers.set("modify_varpool", modifyVarpoolHandler)
    this.handlers.set("modify_definition", modifyDefinitionHandler)
    this.handlers.set("switch_model", switchModelHandler)
    this.handlers.set("retry_with_hint", retryWithHintHandler)
    this.handlers.set("abort", abortHandler)
    this.handlers.set("pause", pauseHandler)
    this.handlers.set("pause_and_notify", pauseAndNotifyHandler)
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

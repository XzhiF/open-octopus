/**
 * PiAgentProvider — skeleton implementation of IAgentProvider for the Pi SDK.
 *
 * Architecture:
 * ```
 * Pi SDK → AsyncEventBridge → PiAgentProvider → WorkflowEngine
 * ```
 *
 * Phase 1: Provides the structural skeleton (interface compliance,
 * AsyncEventBridge wiring, generator protocol). Actual Pi SDK calls
 * are added in Phase 2.
 */

import type { IAgentProvider, SendQueryOptions, MessageChunk } from '../types'
import { AsyncEventBridge } from './async-event-bridge'

export class PiAgentProvider implements IAgentProvider {
  getType(): string {
    return 'pi'
  }

  async *sendQuery(
    _prompt: string,
    _cwd: string,
    _resumeSessionId?: string,
    _options?: SendQueryOptions,
  ): AsyncGenerator<MessageChunk> {
    const bridge = new AsyncEventBridge<MessageChunk>()

    // Phase 2 will wire Pi SDK events into the bridge here:
    //   session.on('event', (e) => bridge.push(mapEvent(e)))
    //   session.on('error', (e) => bridge.pushError(e))
    //   session.on('end', () => bridge.close())

    // Skeleton: no Pi SDK call yet — close immediately so the
    // generator completes without yielding.
    bridge.close()

    yield* bridge
  }
}

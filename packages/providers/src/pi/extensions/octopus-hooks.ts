import { isCommandBlocked } from '../security'

export function createOctopusHooks() {
  return {
    beforeToolCall: (toolName: string, input: Record<string, unknown>): { blocked?: boolean; reason?: string } => {
      if (toolName === 'Bash' || toolName === 'bash') {
        const command = typeof input.command === 'string' ? input.command : ''
        if (isCommandBlocked(command)) {
          return {
            blocked: true,
            reason: `Command blocked by security policy: ${command.slice(0, 50)}`,
          }
        }
      }
      return {}
    },
  }
}

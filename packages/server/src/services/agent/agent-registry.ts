export interface AvatarConfig {
  id: string
  displayName: string
  description: string
  handlesIntents: string[]
  persona: string
  isBuiltin: boolean
  config?: Record<string, unknown>
}

export class AgentRegistry {
  private agents = new Map<string, AvatarConfig>()

  register(agent: AvatarConfig): void {
    this.agents.set(agent.id, agent)
  }

  unregister(agentId: string): boolean {
    return this.agents.delete(agentId)
  }

  get(agentId: string): AvatarConfig | undefined {
    return this.agents.get(agentId)
  }

  findByIntent(intent: string): AvatarConfig[] {
    const matched: AvatarConfig[] = []
    for (const agent of this.agents.values()) {
      if (agent.handlesIntents.includes(intent) || agent.handlesIntents.includes('*')) {
        matched.push(agent)
      }
    }
    return matched
  }

  list(): AvatarConfig[] {
    return Array.from(this.agents.values())
  }

  listBuiltin(): AvatarConfig[] {
    return this.list().filter(a => a.isBuiltin)
  }

  listCustom(): AvatarConfig[] {
    return this.list().filter(a => !a.isBuiltin)
  }

  has(agentId: string): boolean {
    return this.agents.has(agentId)
  }

  get size(): number {
    return this.agents.size
  }
}

let registryInstance: AgentRegistry | null = null

export function getAgentRegistry(): AgentRegistry {
  if (!registryInstance) {
    registryInstance = new AgentRegistry()
  }
  return registryInstance
}

export function resetAgentRegistry(): void {
  registryInstance = null
}

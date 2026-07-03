export function resolveModel(
  modelStr: string | undefined,
  registry: { find: (provider: string, id: string) => any; getAll: () => any[] },
): any | undefined {
  if (!modelStr) return undefined

  // 1. "provider/model-id" format
  if (modelStr.includes('/')) {
    const [provider, ...rest] = modelStr.split('/')
    const modelId = rest.join('/')
    return registry.find(provider, modelId) ?? undefined
  }

  // 2. Full-text search across all providers
  const all = registry.getAll()
  const matches = all.filter((m: any) => m.id === modelStr || m.name === modelStr)

  if (matches.length === 0) return undefined
  if (matches.length > 1) {
    const providers = matches.map((m: any) => m.provider).join(', ')
    console.warn(`[model-resolver] Ambiguous model "${modelStr}" found in providers: ${providers}. Using first match.`)
  }

  return matches[0]
}

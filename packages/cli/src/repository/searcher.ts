import type { RegistryEntry, ResourceType } from "@octopus/shared"
import { RegistryStore } from "./registry"

export interface SearchOptions {
  type?: ResourceType
  tag?: string
  page?: number
  perPage?: number
}

export interface SearchResult {
  results: RegistryEntry[]
  total: number
  page: number
  per_page: number
}

export class ResourceSearcher {
  constructor(private registry: RegistryStore) {}

  search(query: string, opts: SearchOptions = {}): SearchResult {
    const page = opts.page ?? 1
    const perPage = opts.perPage ?? 20
    const allResults = this.registry.search(query, { type: opts.type, tag: opts.tag })
    const total = allResults.length
    const start = (page - 1) * perPage
    const results = allResults.slice(start, start + perPage)

    return { results, total, page, per_page: perPage }
  }
}

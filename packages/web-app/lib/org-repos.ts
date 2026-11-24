// packages/web-app/lib/org-repos.ts
//
// ORG manifest 仓库清单（建舱 / 舱内绑定共用）：按 org 拉一次，60s 内存缓存。
// 一个 org 的 manifest 可能有多组（miyuan / miyuan3.0 / bigdatabase），同名仓库会在
// 多组里重复出现 —— 按名字去重，否则 projectKey 重复 → React key 重复，过滤时列表会
// 残留旧行（2026-11-16 用户实测：搜 octopus 还挂着 miyuan 的项目）。

import { fetchManifestRepos } from '@/lib/api-client'
import type { CabinProjectRef } from '@/lib/cabin-draft'

const CACHE_TTL = 60_000
const cache = new Map<string, { at: number; repos: CabinProjectRef[] }>()

interface ManifestShape {
  groups?: Record<string, Array<{ name?: string; group?: string }>>
}

/** 某个 org 的注册仓库（只出名字 + 归属 org；manifest 的 group 是仓库分组，不是 org）。 */
export async function loadOrgRepos(org: string): Promise<CabinProjectRef[]> {
  const hit = cache.get(org)
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.repos
  const data = (await fetchManifestRepos(org)) as ManifestShape
  const repos: CabinProjectRef[] = []
  const seen = new Set<string>()
  for (const items of Object.values(data?.groups ?? {})) {
    for (const item of items ?? []) {
      if (!item?.name || seen.has(item.name)) continue
      seen.add(item.name)
      // 归属 org = 被查询的那个 org（manifest 里的 group 是仓库分组，不是 org）。
      repos.push({ source: 'org', org, repo: item.name })
    }
  }
  cache.set(org, { at: Date.now(), repos })
  return repos
}

/** 清缓存（测试 / 需要在同一会话里看到新注册仓库时）。 */
export function clearOrgReposCache(): void {
  cache.clear()
}

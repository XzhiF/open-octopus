import type { Resource } from "@/lib/types"
import { ResourceCard } from "@/components/resources/resource-card"

interface ResourceGridProps {
  resources: Resource[]
  onUninstall?: (name: string) => void
  highlightNames?: Set<string>
}

export function ResourceGrid({ resources, onUninstall, highlightNames }: ResourceGridProps) {
  return (
    <div
      className="grid gap-4 md:grid-cols-2 lg:grid-cols-3"
      role="region"
      aria-label="资源列表"
    >
      {resources.map(r => (
        <ResourceCard
          key={`${r.manifest.type}:${r.manifest.name}`}
          resource={r}
          onUninstall={onUninstall}
          highlight={highlightNames?.has(r.manifest.name)}
        />
      ))}
    </div>
  )
}

'use client'

/**
 * Traceability: P-02 × US-22 × TC-028, TC-029
 *
 * Multi-org preference editor rendered as a vertical card waterfall:
 *   - One "global" card
 *   - One card per org registered in the database
 *
 * Each card independently supports: view / edit / collapse / expand.
 * Top-level toolbar exposes "全部收起 / 全部展开" shortcuts.
 *
 * Data flow:
 *   useOrgs()  →  [global, ...orgs]  →  <PreferenceCard />  ×N
 *
 * Each card talks to the server directly via getPreference / updatePreference
 * with its own (scope, orgId) tuple — the server now resolves org per-request
 * via query string, so a single page can serve multiple orgs.
 */

import { useRef, useCallback } from 'react'
import { ChevronsDownUp, ChevronsUpDown, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { useOrgs } from '@/hooks/useOrgs'
import { PreferenceCard } from './preference/PreferenceCard'
import type { PreferenceCardHandle } from './preference/PreferenceCard'

export function PreferenceEditor() {
  const { orgs, loading, error } = useOrgs()
  // Map<cardKey, handle>. Each PreferenceCard registers itself here via
  // callback ref so the toolbar can drive "全部收起/展开" imperatively
  // without lifting per-card state up.
  const handlesRef = useRef<Map<string, PreferenceCardHandle>>(new Map())

  const registerHandle = useCallback(
    (key: string) => (ref: PreferenceCardHandle | null) => {
      if (ref) handlesRef.current.set(key, ref)
      else handlesRef.current.delete(key)
    },
    [],
  )

  const expandAll = useCallback(() => {
    for (const h of handlesRef.current.values()) h.expand()
  }, [])

  const collapseAll = useCallback(() => {
    for (const h of handlesRef.current.values()) h.collapse()
  }, [])

  return (
    <div className="flex flex-col gap-4 p-2 sm:p-3">
      {/* Toolbar */}
      <header className="flex items-center gap-3 flex-wrap">
        <h2 className="text-base font-semibold text-foreground">用户偏好</h2>
        {!loading && (
          <span className="text-xs text-muted-foreground">
            1 全局 + {orgs.length} 组织
          </span>
        )}
        {loading && <Skeleton className="h-4 w-24" />}
        <span className="flex-1" aria-hidden="true" />
        <div className="flex items-center gap-1.5">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={collapseAll}
            className="gap-1.5 text-xs"
            aria-label="全部收起"
          >
            <ChevronsDownUp className="size-3.5" aria-hidden="true" />
            全部收起
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={expandAll}
            className="gap-1.5 text-xs"
            aria-label="全部展开"
          >
            <ChevronsUpDown className="size-3.5" aria-hidden="true" />
            全部展开
          </Button>
        </div>
      </header>

      {/* Error banner */}
      {error && (
        <div
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/5 text-destructive text-sm px-3 py-2"
        >
          {error}
        </div>
      )}

      {/* Card waterfall */}
      <div className="flex flex-col gap-3">
        <PreferenceCard
          kind="global"
          ref={registerHandle('__global__')}
          defaultExpanded
        />

        {loading && (
          <>
            <Skeleton className="h-16 w-full rounded-lg" />
            <Skeleton className="h-16 w-full rounded-lg" />
          </>
        )}

        {!loading && orgs.length === 0 && (
          <p className="text-xs text-muted-foreground px-1 py-2">
            尚未注册任何组织。通过 <code className="text-xs">octopus setup --org &lt;name&gt;</code> 添加。
          </p>
        )}

        {orgs.map((o) => (
          <PreferenceCard
            key={`org:${o.name}`}
            kind="org"
            orgName={o.name}
            ref={registerHandle(`org:${o.name}`)}
            defaultExpanded
          />
        ))}
      </div>

      {/* Loading overlay for the first paint */}
      {loading && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
          加载组织列表…
        </div>
      )}
    </div>
  )
}

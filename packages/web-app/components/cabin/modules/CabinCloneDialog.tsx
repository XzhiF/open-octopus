'use client'

// clone 新仓对话框（从原 CabinRepos 抽出）：输入 / 选 org 注册表里的仓库名，
// POST /:id/repos 把仓 clone 进舱 projects/<repo>。

import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { fetchManifestRepos } from '@/lib/api-client'
import { addCabinRepo } from '@/lib/cabin-api'
import { useCabinContext } from '../cabin-provider'
import { WBtn } from './ui'

export function CabinCloneDialog({ onCloned }: { onCloned?: () => void }) {
  const { cabinId, cabin } = useCabinContext()
  const [name, setName] = useState('')
  const [options, setOptions] = useState<string[]>([])
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!cabin?.org) return
    let alive = true
    void (async () => {
      try {
        const data = await fetchManifestRepos(cabin.org!) as {
          groups?: Record<string, Array<{ name: string }>>
        }
        if (!alive) return
        const names: string[] = []
        for (const items of Object.values(data.groups ?? {})) {
          for (const item of items ?? []) names.push(item.name)
        }
        setOptions(names)
      } catch {
        if (alive) setOptions([])
      }
    })()
    return () => { alive = false }
  }, [cabin?.org])

  const doClone = async () => {
    const repo = name.trim()
    if (!repo) return
    setBusy(true)
    try {
      await addCabinRepo(cabinId, repo)
      toast.success(`已 clone ${repo} 进舱（projects/${repo}）`)
      setName('')
      onCloned?.()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'clone 失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mb-3 flex items-center gap-2 rounded-lg border-[1.5px] border-pop-bd bg-pop-idle p-2.5" data-testid="cabin-clone-dialog">
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        list="cabin-repo-options"
        placeholder="仓库名（org 注册表）"
        data-testid="cabin-clone-input"
        className="h-7 flex-1 rounded-md border border-pop-bd bg-pop-bg px-2 text-[12px] text-pop-ink outline-none focus:border-pop-pink/60"
      />
      <datalist id="cabin-repo-options">
        {options.map((n) => <option key={n} value={n} />)}
      </datalist>
      <WBtn pri onClick={() => { void doClone() }} disabled={busy || !name.trim()} testId="cabin-clone-confirm">
        {busy ? 'clone 中…' : 'clone'}
      </WBtn>
    </div>
  )
}

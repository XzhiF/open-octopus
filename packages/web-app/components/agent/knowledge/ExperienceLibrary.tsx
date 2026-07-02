'use client'

/**
 * ExperienceLibrary — main component for the "经验库" tab.
 *
 * Layout: org selector (top) + left panel (ExperienceList) + right panel (ExperienceDetail).
 * Manages the shared state between list selection and detail view.
 */

import { useState, useEffect, useCallback } from 'react'
import { Building2 } from 'lucide-react'
import { toast } from 'sonner'
import { ExperienceList } from './ExperienceList'
import { ExperienceDetail } from './ExperienceDetail'
import { CreateExperienceDialog } from './CreateExperienceDialog'
import { getKnowledgeFiles } from '@/lib/knowledge/api'
import type { KnowledgeFile } from '@/lib/knowledge/types'
import { useOrgs } from '@/hooks/useOrgs'

export function ExperienceLibrary() {
  const { orgs } = useOrgs()
  const [selectedOrg, setSelectedOrg] = useState<string>(orgs[0]?.name ?? 'xzf-dev')

  // Update selectedOrg when orgs load
  useEffect(() => {
    if (orgs.length > 0 && !orgs.some(o => o.name === selectedOrg)) {
      setSelectedOrg(orgs[0].name)
    }
  }, [orgs, selectedOrg])

  const [files, setFiles] = useState<KnowledgeFile[]>([])
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [filesLoading, setFilesLoading] = useState(true)

  // Create dialog state
  const [createOpen, setCreateOpen] = useState(false)

  // New file state (for AI-generated content)
  const [newFilePath, setNewFilePath] = useState<string | null>(null)
  const [newFileContent, setNewFileContent] = useState<string | undefined>(undefined)

  const fetchFiles = useCallback(async () => {
    try {
      setFilesLoading(true)
      const res = await getKnowledgeFiles(undefined, selectedOrg)
      setFiles(Array.isArray(res) ? res : res.files ?? [])
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : '加载经验列表失败')
    } finally {
      setFilesLoading(false)
    }
  }, [selectedOrg])

  useEffect(() => {
    fetchFiles()
  }, [fetchFiles])

  // Clear selection when org changes
  useEffect(() => {
    setSelectedFile(null)
    setNewFilePath(null)
    setNewFileContent(undefined)
  }, [selectedOrg])

  const handleSelect = useCallback((path: string) => {
    setNewFilePath(null)
    setNewFileContent(undefined)
    setSelectedFile((prev) => (prev === path ? null : path))
  }, [])

  const handleCreate = useCallback(() => {
    setCreateOpen(true)
  }, [])

  const handleCreated = useCallback((filePath: string, content: string) => {
    setNewFilePath(filePath)
    setNewFileContent(content)
    setSelectedFile(filePath)
  }, [])

  const handleSaved = useCallback(() => {
    fetchFiles()
    setNewFilePath(null)
    setNewFileContent(undefined)
  }, [fetchFiles])

  const handleExitCreate = useCallback(() => {
    setNewFilePath(null)
    setNewFileContent(undefined)
    setSelectedFile(null)
  }, [])

  const handleDeleted = useCallback(() => {
    setSelectedFile(null)
    setNewFilePath(null)
    setNewFileContent(undefined)
    fetchFiles()
  }, [fetchFiles])

  const detailFilePath = newFilePath ?? selectedFile
  const detailInitialContent = newFilePath ? newFileContent : undefined

  return (
    <div className="flex flex-col h-full">
      {/* Org selector bar */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-agent-divider bg-agent-surface-raised shrink-0">
        <Building2 className="size-3.5 text-muted-foreground" />
        <select
          value={selectedOrg}
          onChange={(e) => setSelectedOrg(e.target.value)}
          className="text-xs bg-transparent border border-agent-divider rounded-md px-2 py-1 focus:outline-none focus:ring-1 focus:ring-knowledge-primary"
        >
          {orgs.map((o) => (
            <option key={o.name} value={o.name}>
              {o.name}
            </option>
          ))}
        </select>
        <span className="text-[10px] text-muted-foreground">全局经验始终显示</span>
      </div>

      {/* Main content: left list + right detail */}
      <div className="flex flex-1 min-h-0">
        <div className="w-60 shrink-0 h-full">
          <ExperienceList
            files={files}
            selectedFile={selectedFile}
            onSelect={handleSelect}
            onCreate={handleCreate}
          />
        </div>

        <div className="flex-1 min-w-0">
          <ExperienceDetail
            filePath={detailFilePath}
            initialContent={detailInitialContent}
            org={selectedOrg}
            onSaved={handleSaved}
            onDeleted={handleDeleted}
            onExitCreate={handleExitCreate}
          />
        </div>
      </div>

      {/* Create dialog */}
      <CreateExperienceDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        org={selectedOrg}
        existingFiles={files}
        onCreated={handleCreated}
      />
    </div>
  )
}

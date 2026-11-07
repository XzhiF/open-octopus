'use client'

import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import type { CloneInfo, FileInfo } from '@/lib/agent/types'
import {
  createCloneDirectory,
  deleteCloneFile,
  listCloneFiles,
  updateCloneFile,
} from '@/lib/agent/api'
import { CloneFileTree } from './CloneFileTree'
import { CloneFileContent } from './CloneFileContent'

interface CloneFilesPaneProps {
  clone: CloneInfo
}

export function CloneFilesPane({ clone }: CloneFilesPaneProps) {
  const [files, setFiles] = useState<FileInfo[]>([])
  const [selectedFile, setSelectedFile] = useState<FileInfo | null>(null)
  const [loading, setLoading] = useState(true)

  const loadFiles = useCallback(async () => {
    try {
      const res = await listCloneFiles(clone.name, true)
      setFiles(res.files)
      setSelectedFile((current) => {
        if (!current) {
          return res.files.find((file) => file.path === 'persona.md')
            ?? res.files.find((file) => file.type === 'file')
            ?? null
        }
        return res.files.find((file) => file.path === current.path) ?? null
      })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '加载分身文件失败')
      setFiles([])
    } finally {
      setLoading(false)
    }
  }, [clone.name])

  useEffect(() => {
    loadFiles()
  }, [loadFiles])

  const handleCreateFile = async (parentPath: string) => {
    const name = window.prompt('文件名：')
    if (!name) return
    const fullPath = parentPath ? `${parentPath}/${name}` : name
    try {
      await updateCloneFile(clone.name, fullPath, { content: '' })
      await loadFiles()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '创建文件失败')
    }
  }

  const handleCreateDirectory = async (parentPath: string) => {
    const name = window.prompt('目录名：')
    if (!name) return
    const fullPath = parentPath ? `${parentPath}/${name}` : name
    try {
      await createCloneDirectory(clone.name, fullPath)
      await loadFiles()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '创建目录失败')
    }
  }

  const handleDeleteFile = async (file: FileInfo) => {
    if (!window.confirm(`删除 ${file.name}？`)) return
    try {
      await deleteCloneFile(clone.name, file.path)
      if (selectedFile?.path === file.path) setSelectedFile(null)
      await loadFiles()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '删除失败')
    }
  }

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center text-[10px] text-pop-dim">加载中…</div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      <aside className="flex w-[206px] flex-none flex-col border-r border-pop-bd bg-pop-idle">
        <CloneFileTree
          files={files}
          selectedFile={selectedFile}
          onSelectFile={setSelectedFile}
          onCreateFile={handleCreateFile}
          onCreateDirectory={handleCreateDirectory}
          onDeleteFile={handleDeleteFile}
        />
      </aside>
      <div className="min-w-0 flex-1 bg-pop-bg">
        <CloneFileContent
          cloneName={clone.name}
          file={selectedFile}
          onSaved={loadFiles}
        />
      </div>
    </div>
  )
}

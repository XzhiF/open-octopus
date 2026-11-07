'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  File as FileIcon,
  FileJson,
  FileText,
  Folder,
  FolderOpen,
  Lock,
  Save,
} from 'lucide-react'
import { toast } from 'sonner'
import { getMainAgentFile, listMainAgentFiles, updateMainAgentFile } from '@/lib/agent/api'
import type { MainAgentFileInfo } from '@/lib/agent/types'
import { PaneHead } from '../shared/agent-ui'

interface TreeNode extends MainAgentFileInfo {
  nodes: TreeNode[]
}

function buildTree(files: MainAgentFileInfo[]): TreeNode[] {
  const map = new Map<string, TreeNode>()
  const roots: TreeNode[] = []

  // Path order guarantees a parent is in the map before its children.
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path))

  for (const file of sorted) {
    const node: TreeNode = { ...file, nodes: [] }
    map.set(file.path, node)
    const parentPath = file.path.split('/').slice(0, -1).join('/')
    const parent = map.get(parentPath)
    if (parent) parent.nodes.push(node)
    else roots.push(node)
  }

  const sortNodes = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    nodes.forEach((node) => sortNodes(node.nodes))
  }
  sortNodes(roots)
  return roots
}

/** 主 Agent 文件页只展示这几棵有意义的树：其余（backup / built-in / clones / metrics…）是内部数据。 */
const VISIBLE_ROOTS = new Set([
  'persona.md',
  'config.yaml',
  'memory',
  'skills',
  'versions',
  'debug',
  'reports',
])

function fileIcon(name: string, open = false) {
  if (name.endsWith('.md')) return <FileText className="size-3 text-pop-cyan" />
  if (name.endsWith('.json')) return <FileJson className="size-3 text-pop-yellow" />
  if (open) return <FolderOpen className="size-3 text-pop-purple" />
  return <FileIcon className="size-3 text-pop-dim" />
}

export function MainAgentFilesPane() {
  const [files, setFiles] = useState<MainAgentFileInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<string | null>('persona.md')
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(['memory']))
  const [content, setContent] = useState('')
  const [original, setOriginal] = useState('')
  const [readonly, setReadonly] = useState(false)
  const [fileLoading, setFileLoading] = useState(false)
  const [saving, setSaving] = useState(false)

  const loadFiles = useCallback(async () => {
    try {
      const res = await listMainAgentFiles({ recursive: true })
      setFiles(res.files)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '加载文件树失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadFiles()
  }, [loadFiles])

  const loadFile = useCallback(async (path: string) => {
    setSelected(path)
    setFileLoading(true)
    try {
      const res = await getMainAgentFile(path)
      setContent(res.content)
      setOriginal(res.content)
      setReadonly(res.readonly)
    } catch (err) {
      setContent('')
      setOriginal('')
      toast.error(err instanceof Error ? err.message : '读取文件失败')
    } finally {
      setFileLoading(false)
    }
  }, [])

  useEffect(() => {
    loadFile('persona.md')
  }, [loadFile])

  const tree = useMemo(
    () => buildTree(files.filter((file) => VISIBLE_ROOTS.has(file.path.split('/')[0]))),
    [files],
  )
  const dirty = content !== original

  const toggle = (path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const handleSave = useCallback(async () => {
    if (!selected || readonly) return
    setSaving(true)
    try {
      await updateMainAgentFile(selected, content)
      setOriginal(content)
      toast.success('文件已保存')
      loadFiles()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }, [selected, readonly, content, loadFiles])

  const renderNode = (node: TreeNode, depth: number) => {
    const isDir = node.type === 'directory'
    const isOpen = expanded.has(node.path)
    const isActive = selected === node.path
    return (
      <div key={node.path}>
        <button
          type="button"
          onClick={() => (isDir ? toggle(node.path) : loadFile(node.path))}
          className={`flex w-full items-center gap-1.5 rounded-[6px] py-1 pr-2 text-left text-[10.5px] transition-colors ${
            isActive
              ? 'bg-pop-purple-soft text-pop-purple'
              : 'text-pop-dim hover:bg-pop-ink/5 hover:text-pop-ink'
          }`}
          style={{ paddingLeft: `${8 + depth * 12}px` }}
          title={node.path}
        >
          {isDir ? (
            isOpen ? <ChevronDown className="size-3 flex-none" /> : <ChevronRight className="size-3 flex-none" />
          ) : (
            <span className="inline-block size-3 flex-none" />
          )}
          {isDir ? (
            isOpen ? <FolderOpen className="size-3 flex-none text-pop-purple" /> : <Folder className="size-3 flex-none text-pop-purple" />
          ) : (
            fileIcon(node.name)
          )}
          <span className="truncate">{node.name}</span>
          {!isDir && node.readonly && (
            <Lock className="ml-auto size-2.5 flex-none text-pop-dim/70" />
          )}
        </button>
        {isDir && isOpen && node.nodes.map((child) => renderNode(child, depth + 1))}
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 p-3">
      <PaneHead title="文件" description="~/.octopus/agent" />

      <div className="flex min-h-0 flex-1 overflow-hidden rounded-[12px] border border-pop-bd">
        <aside className="flex w-[188px] flex-none flex-col border-r border-pop-bd bg-pop-idle">
          <div className="min-h-0 flex-1 overflow-auto py-2">
            {loading ? (
              <div className="px-3 py-2 text-[10px] text-pop-dim">加载中…</div>
            ) : tree.length === 0 ? (
              <div className="px-3 py-2 text-[10px] text-pop-dim">目录为空</div>
            ) : (
              tree.map((node) => renderNode(node, 0))
            )}
          </div>
          <div className="flex items-center gap-1.5 border-t border-pop-bd px-2.5 py-2 text-[9px] text-pop-dim">
            <Lock className="size-2.5 text-pop-purple" />
            继承给分身
            <span className="ml-auto font-mono text-[8.5px]">skills · memory</span>
          </div>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col bg-pop-bg">
          <div className="flex flex-none items-center gap-2 border-b border-pop-bd bg-pop-paper px-3 py-2">
            <span className="flex-1 truncate font-mono text-[11px] text-pop-ink">
              {selected ?? '选择文件'}
            </span>
            {readonly ? (
              <span className="flex items-center gap-1 text-[9px] text-pop-dim">
                <Lock className="size-2.5" />
                只读 · 由系统维护
              </span>
            ) : (
              <span className={`text-[9px] ${dirty ? 'text-pop-yellow' : 'text-pop-dim'}`}>
                {dirty ? '● 已修改' : '已保存'}
              </span>
            )}
            {!readonly && (
              <button
                type="button"
                onClick={handleSave}
                disabled={!dirty || saving}
                className="inline-flex h-6 items-center gap-1 rounded-[6px] border-[1.5px] border-pop-bd bg-pop-idle px-2 text-[9.5px] font-bold text-pop-ink transition-colors hover:border-pop-purple/50 disabled:opacity-40"
              >
                <Save className="size-2.5" />
                {saving ? '保存中…' : '保存文件'}
              </button>
            )}
          </div>
          {fileLoading ? (
            <div className="flex flex-1 items-center justify-center text-[10px] text-pop-dim">加载中…</div>
          ) : (
            <textarea
              value={content}
              readOnly={readonly}
              spellCheck={false}
              onChange={(e) => setContent(e.target.value)}
              className={`min-h-0 flex-1 resize-none bg-pop-inset p-3 font-mono text-[11px] leading-[1.65] text-pop-ink outline-none ${
                readonly ? 'text-pop-dim/80' : ''
              }`}
            />
          )}
        </div>
      </div>
    </div>
  )
}

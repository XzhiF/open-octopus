'use client'

import { useState } from 'react'
import {
  ChevronRight,
  ChevronDown,
  File,
  FileText,
  FileJson,
  Folder,
  FolderOpen,
  Lock,
} from 'lucide-react'
import type { FileInfo } from '@/lib/agent/types'

interface CloneFileTreeProps {
  files: FileInfo[]
  selectedFile: FileInfo | null
  onSelectFile: (file: FileInfo) => void
  onCreateFile?: (parentPath: string) => void
  onCreateDirectory?: (parentPath: string) => void
  onDeleteFile?: (file: FileInfo) => void
}

interface TreeNode extends FileInfo {
  children: TreeNode[]
  depth: number
}

export function CloneFileTree({
  files,
  selectedFile,
  onSelectFile,
  onCreateFile,
  onCreateDirectory,
  onDeleteFile,
}: CloneFileTreeProps) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [contextMenu, setContextMenu] = useState<{
    x: number
    y: number
    file: FileInfo
  } | null>(null)

  // Build tree structure
  const tree = buildTree(files)

  const toggleExpand = (path: string) => {
    const next = new Set(expanded)
    if (next.has(path)) {
      next.delete(path)
    } else {
      next.add(path)
    }
    setExpanded(next)
  }

  const handleContextMenu = (e: React.MouseEvent, file: FileInfo) => {
    e.preventDefault()
    if (file.readonly) return
    setContextMenu({ x: e.clientX, y: e.clientY, file })
  }

  const closeContextMenu = () => setContextMenu(null)

  return (
    <div className="h-full flex flex-col bg-agent-surface">
      {/* Clone files */}
      <div className="flex-1 overflow-auto py-2">
        {tree
          .filter(n => !n.path.startsWith('__inherited__/'))
          .map((node) => (
            <TreeNodeItem
              key={node.path}
              node={node}
              expanded={expanded}
              selectedFile={selectedFile}
              onToggle={toggleExpand}
              onSelect={onSelectFile}
              onContextMenu={handleContextMenu}
            />
          ))}
      </div>

      {/* Inherited resources — split into Skills and Memory */}
      {files.some(f => f.path.startsWith('__inherited__/')) && (
        <div className="border-t border-agent-divider">
          <InheritedGroup
            label="Skills"
            files={files.filter(f => f.path.startsWith('__inherited__/skills/'))}
            tree={tree}
            expanded={expanded}
            selectedFile={selectedFile}
            onToggle={toggleExpand}
            onSelect={onSelectFile}
            onContextMenu={handleContextMenu}
          />
          <InheritedGroup
            label="Memory"
            files={files.filter(f => f.path.startsWith('__inherited__/memory/'))}
            tree={tree}
            expanded={expanded}
            selectedFile={selectedFile}
            onToggle={toggleExpand}
            onSelect={onSelectFile}
            onContextMenu={handleContextMenu}
          />
        </div>
      )}

      {/* Context menu */}
      {contextMenu && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={closeContextMenu}
          />
          <div
            className="fixed z-50 bg-agent-surface-raised border border-agent-divider rounded-md shadow-lg py-1 min-w-[150px]"
            style={{ left: contextMenu.x, top: contextMenu.y }}
          >
            {contextMenu.file.type === 'directory' && (
              <>
                <button
                  className="w-full px-3 py-1.5 text-left text-sm hover:bg-agent-hover"
                  onClick={() => {
                    onCreateFile?.(contextMenu.file.path)
                    closeContextMenu()
                  }}
                >
                  新建文件
                </button>
                <button
                  className="w-full px-3 py-1.5 text-left text-sm hover:bg-agent-hover"
                  onClick={() => {
                    onCreateDirectory?.(contextMenu.file.path)
                    closeContextMenu()
                  }}
                >
                  新建目录
                </button>
              </>
            )}
            <button
              className="w-full px-3 py-1.5 text-left text-sm text-agent-error hover:bg-agent-hover"
              onClick={() => {
                onDeleteFile?.(contextMenu.file)
                closeContextMenu()
              }}
            >
              删除
            </button>
          </div>
        </>
      )}
    </div>
  )
}

// Helper: build tree from flat list
function buildTree(files: FileInfo[]): TreeNode[] {
  const map = new Map<string, TreeNode>()
  const roots: TreeNode[] = []

  // Sort: directories first, then alphabetically
  const sorted = [...files].sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
    return a.name.localeCompare(b.name)
  })

  for (const file of sorted) {
    const node: TreeNode = { ...file, children: [], depth: 0 }
    map.set(file.path, node)

    const parentPath = file.path.split('/').slice(0, -1).join('/')
    const parent = map.get(parentPath)

    if (parent) {
      node.depth = parent.depth + 1
      parent.children.push(node)
    } else {
      roots.push(node)
    }
  }

  return roots
}

// Helper: collapsible inherited group
function InheritedGroup({
  label,
  files,
  tree,
  expanded,
  selectedFile,
  onToggle,
  onSelect,
  onContextMenu,
}: {
  label: string
  files: FileInfo[]
  tree: TreeNode[]
  expanded: Set<string>
  selectedFile: FileInfo | null
  onToggle: (path: string) => void
  onSelect: (file: FileInfo) => void
  onContextMenu: (e: React.MouseEvent, file: FileInfo) => void
}) {
  const groupKey = `__inherited_group__${label}`
  const isExpanded = expanded.has(groupKey)
  const count = files.filter(f => f.type === 'file').length

  if (files.length === 0) return null

  // Get top-level nodes for this group (children of the prefix path)
  const prefix = label === 'Skills' ? '__inherited__/skills/' : '__inherited__/memory/'
  const groupNodes = tree.filter(n => {
    // A node is top-level in this group if its path starts with prefix
    // and its parent (one level up) is NOT in the file list (i.e., it's a root in the group)
    if (!n.path.startsWith(prefix)) return false
    const relative = n.path.slice(prefix.length)
    // Top-level = no slashes in relative path (direct child of the group root)
    return !relative.includes('/')
  })

  return (
    <div>
      <div
        className="flex items-center gap-1 px-2 py-1.5 cursor-pointer hover:bg-agent-hover text-xs text-muted-foreground font-medium"
        onClick={() => onToggle(groupKey)}
      >
        {isExpanded ? (
          <ChevronDown className="h-3 w-3" />
        ) : (
          <ChevronRight className="h-3 w-3" />
        )}
        <Lock className="h-3 w-3" />
        <span className="flex-1">继承 {label}</span>
        <span className="text-[10px] opacity-60">{count}</span>
      </div>
      {isExpanded && groupNodes.map((node) => (
        <TreeNodeItem
          key={node.path}
          node={node}
          expanded={expanded}
          selectedFile={selectedFile}
          onToggle={onToggle}
          onSelect={onSelect}
          onContextMenu={onContextMenu}
        />
      ))}
    </div>
  )
}

// Helper: render tree node
function TreeNodeItem({
  node,
  expanded,
  selectedFile,
  onToggle,
  onSelect,
  onContextMenu,
}: {
  node: TreeNode
  expanded: Set<string>
  selectedFile: FileInfo | null
  onToggle: (path: string) => void
  onSelect: (file: FileInfo) => void
  onContextMenu: (e: React.MouseEvent, file: FileInfo) => void
}) {
  const isExpanded = expanded.has(node.path)
  const isSelected = selectedFile?.path === node.path
  const isDirectory = node.type === 'directory'

  const getIcon = () => {
    if (isDirectory) {
      return isExpanded ? (
        <FolderOpen className="h-4 w-4 text-agent-primary" />
      ) : (
        <Folder className="h-4 w-4 text-agent-primary" />
      )
    }
    if (node.name.endsWith('.md')) {
      return <FileText className="h-4 w-4 text-blue-500" />
    }
    if (node.name.endsWith('.json')) {
      return <FileJson className="h-4 w-4 text-yellow-500" />
    }
    return <File className="h-4 w-4 text-muted-foreground" />
  }

  return (
    <>
      <div
        className={`flex items-center gap-1 px-2 py-1 cursor-pointer hover:bg-agent-hover ${
          isSelected ? 'bg-agent-hover' : ''
        } ${node.readonly ? 'opacity-60' : ''}`}
        style={{ paddingLeft: `${node.depth * 12 + 8}px` }}
        onClick={() => {
          if (isDirectory) {
            onToggle(node.path)
          } else {
            onSelect(node)
          }
        }}
        onContextMenu={(e) => onContextMenu(e, node)}
      >
        {isDirectory && (
          isExpanded ? (
            <ChevronDown className="h-3 w-3" />
          ) : (
            <ChevronRight className="h-3 w-3" />
          )
        )}
        {getIcon()}
        <span className="text-sm truncate flex-1">{node.name}</span>
        {node.readonly && <Lock className="h-3 w-3 text-muted-foreground" />}
      </div>
      {isDirectory && isExpanded && node.children.map((child) => (
        <TreeNodeItem
          key={child.path}
          node={child}
          expanded={expanded}
          selectedFile={selectedFile}
          onToggle={onToggle}
          onSelect={onSelect}
          onContextMenu={onContextMenu}
        />
      ))}
    </>
  )
}

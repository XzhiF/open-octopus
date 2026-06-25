"use client"

import { useState, useEffect, useMemo } from "react"
import * as Y from "yjs"
import { cn, copyToClipboard } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import type { FileNode } from "@/lib/types"
import { useYMap } from "@/lib/yjs-provider"
import {
  ChevronRight,
  ChevronDown,
  File,
  Folder,
  FolderOpen,
  FileCode,
  FileJson,
  FileText,
  RefreshCw,
  Plus,
  GitBranch,
  Trash2,
  FolderPlus,
  Search,
  Loader2,
  Copy,
  Pencil,
} from "lucide-react"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { isWorkflowYaml } from "@/lib/yaml-utils"
import { flushSync } from "react-dom"
import { toast } from "sonner"

function buildAbsolutePath(workspacePath: string, relPath: string): string {
  const sep = workspacePath.includes("\\") ? "\\" : "/"
  const cleanRel = relPath.replace(/^\//, "").replace(/\//g, sep)
  const base = workspacePath.replace(/[/\\]$/, "")
  return `${base}${sep}${cleanRel}`
}

interface SidebarFileTreeProps {
  files?: FileNode[]
  doc?: Y.Doc | null
  connected?: boolean
  workspacePath?: string
  onFileSelect?: (file: FileNode) => void
  selectedPath?: string
  onOpenAsWorkflow?: (file: FileNode) => void
  onOpenAsText?: (file: FileNode) => void
  fileContents?: Record<string, string>
  onCreateEntryConfirm?: (parentPath: string, entryName: string, entryType: "file" | "directory") => void
  onDeleteConfirm?: (node: FileNode) => void
  onRenameConfirm?: (node: FileNode, newName: string) => void
  onExpand?: (dirPath: string) => Promise<FileNode[]>
  onRefresh?: () => void
  externalChanges?: Record<string, boolean>
}

const fileIconMap: Record<string, React.ElementType> = {
  tsx: FileCode,
  ts: FileCode,
  js: FileCode,
  jsx: FileCode,
  json: FileJson,
  yaml: FileText,
  yml: FileText,
  md: FileText,
}

function fuzzyMatch(name: string, query: string): boolean {
  const lower = name.toLowerCase()
  let qi = 0
  for (let i = 0; i < lower.length && qi < query.length; i++) {
    if (lower[i] === query[qi]) qi++
  }
  return qi === query.length
}

function filterTree(nodes: FileNode[], query: string): FileNode[] {
  if (!query) return nodes
  const lowerQuery = query.toLowerCase()

  function filterNode(node: FileNode): FileNode | null {
    if (node.type === "file") {
      return fuzzyMatch(node.name, lowerQuery) ? node : null
    }
    const filteredChildren = (node.children || [])
      .map(filterNode)
      .filter((c): c is FileNode => c !== null)
    if (filteredChildren.length > 0) {
      return { ...node, children: filteredChildren, isExpanded: true }
    }
    if (fuzzyMatch(node.name, lowerQuery)) {
      return { ...node, children: [], isExpanded: true }
    }
    return null
  }

  return nodes.map(filterNode).filter((n): n is FileNode => n !== null)
}

function ymapToFileNodes(map: Y.Map<unknown>, parentPath: string): FileNode[] {
  const nodes: FileNode[] = []
  const dirEntries: [string, Y.Map<unknown>][] = []
  const fileEntries: [string, Y.Map<unknown>][] = []

  for (const [key, value] of map.entries()) {
    if (value instanceof Y.Map && (value.has("size") || value.has("extension"))) {
      fileEntries.push([key, value as Y.Map<unknown>])
    } else if (value instanceof Y.Map) {
      dirEntries.push([key, value as Y.Map<unknown>])
    }
  }

  dirEntries.sort((a, b) => a[0].localeCompare(b[0]))
  fileEntries.sort((a, b) => a[0].localeCompare(b[0]))

  for (const [name, childMap] of dirEntries) {
    const childPath = parentPath === "/" ? `/${name}` : `${parentPath}/${name}`
    nodes.push({
      id: `fn-${childPath}`,
      name,
      type: "directory",
      path: childPath,
      children: ymapToFileNodes(childMap, childPath),
      isExpanded: false,
    })
  }

  for (const [name, fileMap] of fileEntries) {
    const childPath = parentPath === "/" ? `/${name}` : `${parentPath}/${name}`
    nodes.push({
      id: `fn-${childPath}`,
      name,
      type: "file",
      path: childPath,
      extension: (fileMap.get("extension") as string) || undefined,
    })
  }

  return nodes
}

function FileTreeNode({
  node,
  level = 0,
  onFileSelect,
  selectedPath,
  onOpenAsWorkflow,
  onOpenAsText,
  fileContents,
  creatingInDir,
  onStartCreating,
  onCreateEntryConfirm,
  onDeleteConfirm,
  onRenameConfirm,
  onExpand,
  externalChanges,
  renamingNode,
  onStartRenaming,
  workspacePath,
}: {
  node: FileNode
  level?: number
  onFileSelect?: (file: FileNode) => void
  selectedPath?: string
  onOpenAsWorkflow?: (file: FileNode) => void
  onOpenAsText?: (file: FileNode) => void
  fileContents?: Record<string, string>
  creatingInDir?: { parentPath: string; type: "file" | "directory" } | null
  onStartCreating?: (parentPath: string, type: "file" | "directory") => void
  onCreateEntryConfirm?: (parentPath: string, entryName: string, entryType: "file" | "directory") => void
  onDeleteConfirm?: (node: FileNode) => void
  onRenameConfirm?: (node: FileNode, newName: string) => void
  onExpand?: (dirPath: string) => Promise<FileNode[]>
  externalChanges?: Record<string, boolean>
  renamingNode?: { node: FileNode } | null
  onStartRenaming?: (node: FileNode) => void
  workspacePath?: string
}) {
  const [isExpanded, setIsExpanded] = useState(node.isExpanded ?? false)
  const [children, setChildren] = useState<FileNode[] | null>(node.children ?? null)
  const [loadingChildren, setLoadingChildren] = useState(false)
  useEffect(() => { setIsExpanded(node.isExpanded ?? false) }, [node.isExpanded])
  useEffect(() => { setChildren(node.children ?? null) }, [node.children])
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; node: FileNode } | null>(null)
  const isDirectory = node.type === "directory"
  const isSelected = selectedPath === node.path
  const isRenaming = renamingNode?.node.path === node.path
  const FileIcon = node.extension ? fileIconMap[node.extension] || File : File

  const handleClick = async () => {
    if (isDirectory) {
      const willExpand = !isExpanded
      setIsExpanded(!isExpanded)
      if (willExpand && node.children === undefined && onExpand) {
        setLoadingChildren(true)
        const newChildren = await onExpand(node.path)
        setChildren(newChildren)
        setLoadingChildren(false)
      }
    } else {
      if (node.extension === "yaml" || node.extension === "yml") {
        const content = fileContents?.[node.path] || ""
        const isWf = isWorkflowYaml(content)
        if (isWf && onOpenAsWorkflow) {
          onOpenAsWorkflow(node)
        } else if (onOpenAsText) {
          onOpenAsText(node)
        }
      } else if (onOpenAsText) {
        onOpenAsText(node)
      }
      onFileSelect?.(node)
    }
  }

  return (
    <div>
      <button
        onClick={handleClick}
        onContextMenu={(e) => {
          e.preventDefault()
          setContextMenu({ x: e.clientX, y: e.clientY, node })
        }}
        className={cn(
          "flex w-full items-center gap-1 rounded-sm px-2 py-1 text-left text-sm transition-colors hover:bg-accent cursor-pointer",
          isSelected && "bg-accent text-accent-foreground"
        )}
        style={{ paddingLeft: `${level * 12 + 8}px` }}
      >
        {isDirectory ? (
          <>
            {isExpanded ? (
              <ChevronDown className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
            )}
            {isExpanded ? (
              <FolderOpen className="h-4 w-4 flex-shrink-0 text-amber-500" />
            ) : (
              <Folder className="h-4 w-4 flex-shrink-0 text-amber-500" />
            )}
          </>
        ) : (
          <>
            <span className="w-3.5" />
            <FileIcon className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
          </>
        )}
        {!isDirectory && externalChanges?.[node.path] && (
          <span className="w-1.5 h-1.5 rounded-full bg-yellow-500 flex-shrink-0" title="文件已被外部修改" />
        )}
        <span className="truncate">{node.name}</span>
      </button>
      {isRenaming && (
        <div style={{ paddingLeft: `${level * 12 + 8}px` }} className="flex items-center gap-1 py-1 px-2">
          {isDirectory ? (
            <>
              <ChevronRight className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
              <Folder className="h-4 w-4 flex-shrink-0 text-amber-500" />
            </>
          ) : (
            <>
              <span className="w-3.5" />
              <FileIcon className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
            </>
          )}
          <input
            autoFocus
            defaultValue={node.name}
            className="h-6 w-full rounded-sm border border-input bg-background px-1 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
            onBlur={(e) => {
              const newName = e.currentTarget.value.trim()
              onRenameConfirm?.(node, newName || node.name)
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                const newName = e.currentTarget.value.trim()
                onRenameConfirm?.(node, newName || node.name)
              }
              if (e.key === "Escape") {
                onRenameConfirm?.(node, node.name)
              }
            }}
          />
        </div>
      )}
      {contextMenu && (
        <DropdownMenu open={true} onOpenChange={(open) => !open && setContextMenu(null)}>
          <DropdownMenuTrigger asChild>
            <div style={{ position: "fixed", left: contextMenu.x, top: contextMenu.y }} />
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            {contextMenu.node.type === "directory" && (
              <DropdownMenuItem onClick={() => { onStartCreating?.(contextMenu.node.path, "file"); setContextMenu(null) }}>
                <Plus className="mr-2 h-4 w-4" />
                新建文件
              </DropdownMenuItem>
            )}
            {contextMenu.node.type === "directory" && (
              <DropdownMenuItem onClick={() => { onStartCreating?.(contextMenu.node.path, "directory"); setContextMenu(null) }}>
                <FolderPlus className="mr-2 h-4 w-4" />
                新建文件夹
              </DropdownMenuItem>
            )}
            {contextMenu.node.type === "file" && (contextMenu.node.extension === "yaml" || contextMenu.node.extension === "yml") && (
              <DropdownMenuItem onClick={() => { onOpenAsWorkflow?.(contextMenu.node); setContextMenu(null) }}>
                <GitBranch className="mr-2 h-4 w-4" />
                Workflow 编辑器
              </DropdownMenuItem>
            )}
            {contextMenu.node.type === "file" && (
              <DropdownMenuItem onClick={() => { onOpenAsText?.(contextMenu.node); setContextMenu(null) }}>
                <FileCode className="mr-2 h-4 w-4" />
                文本编辑器
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => {
                const absPath = workspacePath
                  ? buildAbsolutePath(workspacePath, contextMenu.node.path)
                  : contextMenu.node.path
                if (copyToClipboard(absPath)) {
                  toast.success("路径已复制", { duration: 1500 })
                } else {
                  window.prompt("请手动复制以下内容：", absPath)
                }
                setContextMenu(null)
              }}
            >
              <Copy className="mr-2 h-4 w-4" />
              复制路径
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => {
                if (copyToClipboard(contextMenu.node.name)) {
                  toast.success("名称已复制", { duration: 1500 })
                } else {
                  window.prompt("请手动复制以下内容：", contextMenu.node.name)
                }
                setContextMenu(null)
              }}
            >
              <Copy className="mr-2 h-4 w-4" />
              复制名称
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => { onStartRenaming?.(contextMenu.node); setContextMenu(null) }}
            >
              <Pencil className="mr-2 h-4 w-4" />
              重命名
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="text-destructive focus:text-destructive focus:bg-destructive/10"
              onClick={() => { onDeleteConfirm?.(contextMenu.node); setContextMenu(null) }}
            >
              <Trash2 className="mr-2 h-4 w-4" />
              删除
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {isDirectory && isExpanded && (
        <div>
          {loadingChildren ? (
            <div style={{ paddingLeft: `${(level + 1) * 12 + 8}px` }} className="py-1 text-xs text-muted-foreground">加载中...</div>
          ) : null}
          {creatingInDir?.parentPath === node.path && (
            <div style={{ paddingLeft: `${(level + 1) * 12 + 8}px` }} className="flex items-center gap-1 py-1 px-2">
              <span className="w-3.5" />
              {creatingInDir.type === "directory" ? (
                <Folder className="h-4 w-4 flex-shrink-0 text-amber-500" />
              ) : (
                <File className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
              )}
              <input
                autoFocus
                className="h-6 w-full rounded-sm border border-input bg-background px-1 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
                placeholder={creatingInDir.type === "directory" ? "输入文件夹名..." : "输入文件名..."}
                onBlur={(e) => {
                  const entryName = e.currentTarget.value.trim()
                  onCreateEntryConfirm?.(node.path, entryName || "", creatingInDir.type)
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    const entryName = e.currentTarget.value.trim()
                    onCreateEntryConfirm?.(node.path, entryName || "", creatingInDir.type)
                  }
                  if (e.key === "Escape") {
                    onCreateEntryConfirm?.(node.path, "", creatingInDir.type)
                  }
                }}
              />
            </div>
          )}
          {(children && children.length > 0 ? children : []).map((child) => (
            <FileTreeNode
              key={child.id}
              node={child}
              level={level + 1}
              onFileSelect={onFileSelect}
              selectedPath={selectedPath}
              onOpenAsWorkflow={onOpenAsWorkflow}
              onOpenAsText={onOpenAsText}
              fileContents={fileContents}
              creatingInDir={creatingInDir}
              onStartCreating={onStartCreating}
              onCreateEntryConfirm={onCreateEntryConfirm}
              onDeleteConfirm={onDeleteConfirm}
              onRenameConfirm={onRenameConfirm}
              onExpand={onExpand}
              externalChanges={externalChanges}
              renamingNode={renamingNode}
              onStartRenaming={onStartRenaming}
              workspacePath={workspacePath}
            />
          ))}
          </div>
        )}
    </div>
  )
}

export function SidebarFileTree({ files, doc, connected, workspacePath, onFileSelect, selectedPath, onOpenAsWorkflow, onOpenAsText, fileContents, onCreateEntryConfirm, onDeleteConfirm, onRenameConfirm, onExpand, onRefresh, externalChanges }: SidebarFileTreeProps) {
  const [creatingInDir, setCreatingInDir] = useState<{ parentPath: string; type: "file" | "directory" } | null>(null)
  const [renamingNode, setRenamingNode] = useState<{ node: FileNode } | null>(null)
  const [searchQuery, setSearchQuery] = useState("")
  const [refreshing, setRefreshing] = useState(false)
  const { map: fileTreeMap, version: treeVersion } = useYMap(doc ?? null, "fileTree")
  const useYjsMode = doc !== undefined && doc !== null

  const yjsFiles = useMemo(
    () => useYjsMode && fileTreeMap ? ymapToFileNodes(fileTreeMap, "/") : [],
    [useYjsMode, fileTreeMap, treeVersion]
  )

  const sourceFiles = useYjsMode ? yjsFiles : (files || [])
  const displayFiles = useMemo(() => filterTree(sourceFiles, searchQuery), [sourceFiles, searchQuery])
  const hasSearch = searchQuery.trim().length > 0

  return (
    <div className="flex h-full flex-col border-r border-border bg-sidebar">
      {/* Header */}
      <div className="flex h-10 items-center gap-2 border-b border-border px-3">
        <div className="relative flex-1">
          <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="搜索文件..."
            className="h-7 w-full rounded-md border border-input bg-background pl-7 pr-2 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </div>
        <div className="flex items-center gap-1">
          {useYjsMode && connected === false && (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-6 w-6">
                <Plus className="h-3.5 w-3.5" />
                <span className="sr-only">新建</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem onClick={() => setCreatingInDir({ parentPath: "/", type: "file" })}>
                <File className="mr-2 h-4 w-4" />
                新建文件
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setCreatingInDir({ parentPath: "/", type: "directory" })}>
                <Folder className="mr-2 h-4 w-4 text-amber-500" />
                新建文件夹
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button variant="ghost" size="icon" className={`h-6 w-6 ${refreshing ? "text-primary" : ""}`}
              onClick={async () => {
                if (onRefresh) {
                  flushSync(() => setRefreshing(true))
                  const start = Date.now()
                  try {
                    await onRefresh()
                  } catch {}
                  const elapsed = Date.now() - start
                  if (elapsed < 400) {
                    await new Promise(r => setTimeout(r, 400 - elapsed))
                  }
                  setRefreshing(false)
                }
              }}
              disabled={refreshing}>
            <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} />
            <span className="sr-only">刷新</span>
          </Button>
        </div>
      </div>

      {useYjsMode && connected === false && (
        <div className="flex items-center justify-center gap-2 border-b border-border py-2 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          正在连接...
        </div>
      )}

      {/* Tree */}
      <ScrollArea className="flex-1 min-h-0">
        <div className="p-2">
          {displayFiles.length === 0 && hasSearch && (
            <div className="py-4 text-center text-xs text-muted-foreground">
              未找到匹配文件
            </div>
          )}
          {!hasSearch && creatingInDir?.parentPath === "/" && (
            <div className="flex items-center gap-1 py-1 px-2" style={{ paddingLeft: `${0 * 12 + 8}px` }}>
              <span className="w-3.5" />
              {creatingInDir.type === "directory" ? (
                <Folder className="h-4 w-4 flex-shrink-0 text-amber-500" />
              ) : (
                <File className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
              )}
              <input
                autoFocus
                className="h-6 w-full rounded-sm border border-input bg-background px-1 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
                placeholder={creatingInDir.type === "directory" ? "输入文件夹名..." : "输入文件名..."}
                onBlur={(e) => {
                  const entryName = e.currentTarget.value.trim()
                  if (entryName) {
                    onCreateEntryConfirm?.("/", entryName, creatingInDir.type)
                  }
                  setCreatingInDir(null)
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    const entryName = e.currentTarget.value.trim()
                    if (entryName) {
                      onCreateEntryConfirm?.("/", entryName, creatingInDir.type)
                    }
                    setCreatingInDir(null)
                  }
                  if (e.key === "Escape") {
                    setCreatingInDir(null)
                  }
                }}
              />
            </div>
          )}
          {displayFiles.map((node) => (
            <FileTreeNode
              key={node.id}
              node={node}
              onFileSelect={onFileSelect}
              selectedPath={selectedPath}
              onOpenAsWorkflow={onOpenAsWorkflow}
              onOpenAsText={onOpenAsText}
              fileContents={fileContents}
              creatingInDir={!hasSearch ? creatingInDir : null}
              onStartCreating={(parentPath, type) => setCreatingInDir({ parentPath, type })}
              onCreateEntryConfirm={(parentPath, entryName, entryType) => {
                onCreateEntryConfirm?.(parentPath, entryName, entryType)
                setCreatingInDir(null)
              }}
              onDeleteConfirm={onDeleteConfirm}
              onRenameConfirm={(node, newName) => {
                onRenameConfirm?.(node, newName)
                setRenamingNode(null)
              }}
              onExpand={onExpand}
              externalChanges={externalChanges}
              renamingNode={renamingNode}
              onStartRenaming={(node) => setRenamingNode({ node })}
              workspacePath={workspacePath}
            />
          ))}
        </div>
      </ScrollArea>
    </div>
  )
}
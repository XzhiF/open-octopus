"use client"

import { use, useState, useCallback, useEffect, useRef } from "react"
import { notFound, useRouter, useSearchParams } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { SidebarFileTree } from "@/components/workspace/sidebar-file-tree"
import { ChatPanel } from "@/components/workspace/chat/chat-panel"
import { WorkflowFlowPanel } from "@/components/workspace/workflow-flow-panel"
import { WorkflowDetailPanel } from "@/components/workspace/workflow-detail-panel"
import { WorkflowEditorTab } from "@/components/workspace/workflow-editor-tab"
import { TextEditorTab, getYText, INTERNAL_ORIGIN } from "@/components/workspace/text-editor-tab"
import { ConflictDialog } from "@/components/workspace/conflict-dialog"
import { ScheduleTab } from "@/components/schedules/schedule-tab"
import {
  getWorkspace,
  listExecutions,
  fetchWorkflows,
  fetchBuiltInWorkflows,
  createFileEntry,
  saveFileEntry,
  deleteFileEntry,
  renameFileEntry,
  refreshFileTree,
  sendDebugLog,
  fetchFileContent,
} from "@/lib/api-client"
import { stripExt } from "@/lib/utils"
import { useYDoc } from "@/lib/yjs-provider"
import { useChatStream } from "@/components/workspace/chat/use-chat-stream"
import { CommandPalette, useGlobalCommandPalette } from "@/components/command-palette"
import { useCommandPaletteData } from "@/hooks/use-command-palette"
import * as Y from "yjs"

const getYContent = (doc: Y.Doc, filePath: string): string => {
  const tree = doc.getMap("fileTree")
  const segs = filePath.replace(/^\//, "").split("/")
  let current: Y.Map<unknown> = tree
  for (let i = 0; i < segs.length - 1; i++) {
    const next = current.get(segs[i])
    if (!next || !(next instanceof Y.Map)) return ""
    current = next as Y.Map<unknown>
  }
  const fileNode = current.get(segs[segs.length - 1])
  if (!fileNode || !(fileNode instanceof Y.Map)) return ""
  const ytext = fileNode.get("content")
  if (ytext instanceof Y.Text) return ytext.toString()
  return ""
}

function deleteFromYTree(doc: Y.Doc, filePath: string): void {
  const tree = doc.getMap("fileTree")
  const segs = filePath.replace(/^\//, "").split("/").filter(Boolean)
  if (segs.length === 0) return
  const baseName = segs.pop()!
  if (segs.length === 0) {
    tree.delete(baseName)
    return
  }
  let current: Y.Map<unknown> = tree
  for (const seg of segs) {
    const next = current.get(seg)
    if (!(next instanceof Y.Map)) return
    current = next
  }
  current.delete(baseName)
}

function addToYTree(doc: Y.Doc, filePath: string, isDir: boolean): void {
  const tree = doc.getMap("fileTree")
  const segs = filePath.replace(/^\//, "").split("/").filter(Boolean)
  if (segs.length === 0) return
  const baseName = segs.pop()!
  let current: Y.Map<unknown> = tree
  for (const seg of segs) {
    let next = current.get(seg)
    if (!(next instanceof Y.Map)) {
      next = new Y.Map()
      current.set(seg, next)
    }
    current = next as Y.Map<unknown>
  }
  if (current.has(baseName)) return
  if (isDir) {
    current.set(baseName, new Y.Map())
    return
  }
  const ext = baseName.includes(".") ? baseName.split(".").pop() : undefined
  const ytext = new Y.Text()
  const meta = new Y.Map()
  meta.set("content", ytext)
  meta.set("size", 0)
  if (ext) meta.set("extension", ext)
  current.set(baseName, meta)
}

function renameInYTree(doc: Y.Doc, oldPath: string, newPath: string): void {
  const tree = doc.getMap("fileTree")

  function getNode(t: Y.Map<unknown>, segs: string[]): { parent: Y.Map<unknown>; key: string; node: Y.AbstractType<unknown> | null } {
    let current: Y.Map<unknown> = t
    for (let i = 0; i < segs.length - 1; i++) {
      const next = current.get(segs[i])
      if (!(next instanceof Y.Map)) return { parent: current, key: segs[i], node: null }
      current = next
    }
    const key = segs[segs.length - 1]
    const node = current.get(key) as Y.AbstractType<unknown> | undefined
    return { parent: current, key, node: node ?? null }
  }

  const oldSegs = oldPath.replace(/^\//, "").split("/").filter(Boolean)
  const newSegs = newPath.replace(/^\//, "").split("/").filter(Boolean)

  const oldResult = getNode(tree, oldSegs)
  if (!oldResult.node) return

  const newParentPath = newSegs.slice(0, -1)
  const newBaseName = newSegs[newSegs.length - 1]

  let newParent: Y.Map<unknown> = tree
  for (const seg of newParentPath) {
    let next = newParent.get(seg)
    if (!(next instanceof Y.Map)) {
      next = new Y.Map()
      newParent.set(seg, next)
    }
    newParent = next as Y.Map<unknown>
  }

  // Clone the node
  const cloned = oldResult.node.clone() as Y.AbstractType<unknown>
  oldResult.parent.delete(oldResult.key)
  newParent.set(newBaseName, cloned)
}

const MAX_TAB_NAME_LEN = 20

function truncateName(name: string): string {
  if (name.length <= MAX_TAB_NAME_LEN) return name
  const head = name.slice(0, 8)
  const tail = name.slice(-7)
  return `${head}...${tail}`
}

function getTabDisplayName(tab: EditorTab, allTabs: EditorTab[]): string {
  if (!tab.filePath) return truncateName(tab.name)
  const fileName = tab.fileName ?? tab.name
  const sameNameTabs = allTabs.filter(t => t.fileName === fileName && t.filePath !== tab.filePath)
  if (sameNameTabs.length === 0) return truncateName(fileName)
  const parentDir = tab.filePath.replace(/^\//, "").split("/").slice(-2, -1)[0] ?? ""
  return truncateName(`${parentDir}/${fileName}`)
}

import { toast } from "sonner"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from "@/components/ui/context-menu"
import type { EditorTab, FileNode, ChatMessage, ChatSession, Execution, WorkflowOption } from "@/lib/types"
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels"
import {
  PanelLeftClose,
  PanelRightClose,
  Settings,
  Play,
  X,
  GitBranch,
  FileCode,
  Save,
  Trash2,
  Clock,
} from "lucide-react"
import { getServerUrl } from "@/lib/server-config"

interface WorkspaceDetailPageProps {
  params: Promise<{ id: string }>
}

export default function WorkspaceDetailPage({ params }: WorkspaceDetailPageProps) {
  const { id } = use(params)
  const router = useRouter()
  const searchParams = useSearchParams()

  const [workspace, setWorkspace] = useState<Awaited<ReturnType<typeof getWorkspace>>>(undefined)
  const [executions, setExecutions] = useState<Execution[]>([])
  const [workflows, setWorkflows] = useState<Awaited<ReturnType<typeof fetchWorkflows>>>([])
  const [builtInWorkflows, setBuiltInWorkflows] = useState<{ ref: string; name: string; inputs?: Record<string, { description: string; required: boolean; default: string }> }[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const hasLoaded = useRef(false)

  // Reset hasLoaded when navigating to a different workspace
  useEffect(() => {
    hasLoaded.current = false
  }, [id])

  const fetchWorkspaceData = useCallback(async () => {
    // Only show loading skeleton on first fetch; subsequent refetches
    // (e.g. visibility change) update data silently to preserve UI state (dialogs, etc.)
    if (!hasLoaded.current) {
      setLoading(true)
    }
    setLoadError(null)
    try {
      const [wsData, execData, wfData] = await Promise.all([
        getWorkspace(id),
        listExecutions(id),
        fetchWorkflows(id),
      ])
      // Fetch built-in workflows with the correct org
      const builtInData = await fetchBuiltInWorkflows(wsData.org)
      setWorkspace(wsData)
      setExecutions(Array.isArray(execData) ? execData : execData.nodes ?? [])
      setWorkflows(Array.isArray(wfData) ? wfData : wfData.workflows ?? [])
      setBuiltInWorkflows(Array.isArray(builtInData) ? builtInData : [])
      hasLoaded.current = true
      // Chat sessions are now managed by useChatStream hook
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "加载工作空间数据失败")
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => {
    fetchWorkspaceData()
  }, [fetchWorkspaceData])

  // Re-fetch data when page becomes visible (handles server restart / SSE disconnection)
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (!document.hidden) {
        fetchWorkspaceData()
      }
    }
    document.addEventListener("visibilitychange", handleVisibilityChange)
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange)
  }, [fetchWorkspaceData])

  // Command Palette
  const { open: cmdOpen, setOpen: setCmdOpen } = useGlobalCommandPalette()
  const { workflows: cmdWorkflows, executions: cmdExecutions } = useCommandPaletteData(id)

  // Combine local + built-in workflows into WorkflowOption[]
  const workflowOptions: WorkflowOption[] = [
    ...workflows.map((w: Record<string, unknown>) => ({
      value: (w.ref as string) || (w.name as string),
      label: (w.ref as string) || (w.name as string),
      name: (w.name as string),
      group: "local" as const,
      path: `workflows/${(w.ref as string) || (w.name as string)}`,
      inputs: w.inputs as Record<string, { description: string; required: boolean; default: string }> | undefined,
    })),
    ...builtInWorkflows.map((w) => ({
      value: w.ref,
      label: w.ref,
      name: w.name,
      group: "built-in" as const,
      inputs: w.inputs,
    })),
  ]

  const { doc: yDoc, connected, synced } = useYDoc(id)

  const [activeSessionId, setActiveSessionId] = useState<string | null>(() => {
    if (typeof window !== "undefined") {
      const stored = localStorage.getItem(`octopus:ws:${id}:activeSession`)
      return stored || null
    }
    return null
  })

  const {
    messages,
    sessions: allSessions,
    isStreaming,
    isCurrentSessionStreaming,
    status,
    streamStartMs,
    streamEndState,
    hasMoreMessages,
    sendMessage,
    abort,
    createSession,
    switchSession,
    deleteSession,
    renameSession,
    loadMoreMessages,
  } = useChatStream(id, activeSessionId)
  const [showFileTree, setShowFileTree] = useState(true)
  const [showChat, setShowChat] = useState(true)
  const [selectedFile, setSelectedFile] = useState<FileNode | null>(null)

  const ACTIVE_SESSION_KEY = `octopus:ws:${id}:activeSession`

  // Auto-select most recent session when none is active and sessions are loaded
  const initialSelectDone = useRef(false)
  useEffect(() => {
    if (!activeSessionId && !initialSelectDone.current && allSessions.length > 0) {
      initialSelectDone.current = true
      const latest = allSessions[0]
      setActiveSessionId(latest.id)
      switchSession(latest.id)
    }
  }, [activeSessionId, allSessions, switchSession])

  useEffect(() => {
    if (activeSessionId) {
      localStorage.setItem(ACTIVE_SESSION_KEY, activeSessionId)
    } else {
      localStorage.removeItem(ACTIVE_SESSION_KEY)
    }
  }, [activeSessionId])
  

  const [fileContents, setFileContents] = useState<Record<string, string>>({})
  const [savedContents, setSavedContents] = useState<Record<string, string>>({})

  const isDirty = (filePath: string) => {
    const current = fileContents[filePath]
    const saved = savedContents[filePath]
    if (current === undefined && saved === undefined) return false
    return current !== saved
  }

  const [pendingCloseTab, setPendingCloseTab] = useState<EditorTab | null>(null)
  const [pendingDeleteNode, setPendingDeleteNode] = useState<FileNode | null>(null)
  const [pendingDeleteAfterClose, setPendingDeleteAfterClose] = useState<FileNode | null>(null)
  const [fileOpenedAt, setFileOpenedAt] = useState<Record<string, string>>({})
  const [externalContent, setExternalContent] = useState<Record<string, string>>({})
  const [hasExternalChange, setHasExternalChange] = useState<Record<string, boolean>>({})
  const [conflictFile, setConflictFile] = useState<string | null>(null)
  const [conflictResetKey, setConflictResetKey] = useState(0)
  const [forceContentVersion, setForceContentVersion] = useState(0)
  const [isSaving, setIsSaving] = useState(false)

  const TABS_KEY = (wsId: string) => `octopus:ws:${wsId}:tabs`

  function loadPersistedTabs(wsId: string): { tabs: EditorTab[]; activeTabId: string } {
    const defaultTab: EditorTab = { id: "execution", name: "执行流程图", type: "execution", closable: false }
    const fallback = { tabs: [defaultTab], activeTabId: "execution" }
    try {
      const raw = localStorage.getItem(TABS_KEY(wsId))
      if (!raw) return fallback
      const data = JSON.parse(raw)
      if (!Array.isArray(data.tabs) || data.tabs.length === 0) return fallback
      const hasExecution = data.tabs.some((t: EditorTab) => t.type === "execution")
      const restored = hasExecution ? data.tabs : [defaultTab, ...data.tabs]
      const activeExists = restored.some((t: EditorTab) => t.id === data.activeTabId)
      return { tabs: restored, activeTabId: activeExists ? data.activeTabId : restored[restored.length - 1].id }
    } catch {
      return fallback
    }
  }

  // Messages are already scoped to activeSessionId by the hook
  const [tabs, setTabs] = useState<EditorTab[]>(() => loadPersistedTabs(id).tabs)
  const [activeTabId, setActiveTabIdInner] = useState(() => loadPersistedTabs(id).activeTabId)

  const setActiveTabId = useCallback((tabId: string) => {
    setActiveTabIdInner(tabId)
    if (tabId.startsWith("detail-")) {
      const execId = tabId.replace("detail-", "")
      router.push(`?tab=detail&execId=${execId}`, { scroll: false })
    } else {
      router.push("?tab=execution", { scroll: false })
    }
  }, [router])

  const detailTabExecutionId = activeTabId.startsWith("detail-")
    ? tabs.find(t => t.id === activeTabId)?.executionId
    : null

  // Persist tabs + activeTabId to localStorage
  useEffect(() => {
    try {
      localStorage.setItem(TABS_KEY(id), JSON.stringify({ tabs, activeTabId }))
    } catch { /* quota */ }
  }, [tabs, activeTabId, id])

  // Initialize file contents for restored tabs from YDoc once synced
  useEffect(() => {
    if (!synced || !yDoc) return
    const filePaths = tabs.filter(t => t.filePath).map(t => t.filePath!)
    if (filePaths.length === 0) return
    const updates: Record<string, string> = {}
    for (const fp of filePaths) {
      const content = getYContent(yDoc, fp)
      if (content) updates[fp] = content
    }
    if (Object.keys(updates).length === 0) return
    setFileContents(prev => {
      const next = { ...prev }
      for (const [fp, content] of Object.entries(updates)) {
        if (next[fp] === undefined) next[fp] = content
      }
      return next
    })
    setSavedContents(prev => {
      const next = { ...prev }
      for (const [fp, content] of Object.entries(updates)) {
        if (next[fp] === undefined) next[fp] = content
      }
      return next
    })
    setFileOpenedAt(prev => {
      const next = { ...prev }
      for (const [fp, content] of Object.entries(updates)) {
        if (next[fp] === undefined) next[fp] = content
      }
      return next
    })
  }, [synced, yDoc, tabs])

  const activeExecution = (detailTabExecutionId
    ? executions.find(e => e.id === detailTabExecutionId)
    : null)

  const activeWorkflow = activeExecution
    ? (workflows as any[]).concat(builtInWorkflows).find((w: any) =>
        w.id === activeExecution.workflowId || w.ref === (activeExecution as any).workflow_ref
      )
    : undefined

  useEffect(() => {
    if (!detailTabExecutionId || (activeExecution as any)?.steps) return
    fetch(`${getServerUrl()}/api/workspaces/${id}/executions/${detailTabExecutionId}`)
      .then(r => r.json())
      .then(d => {
        if (d.id) {
          setExecutions(prev => [...prev.filter(e => e.id !== d.id), d])
          setTabs(prev => prev.map(t =>
            t.executionId === d.id ? { ...t, name: d.workflow_name ?? d.workflow_ref ?? d.id } : t
          ))
        }
      })
      .catch(() => {})
  }, [detailTabExecutionId, activeExecution, id])

  // Auto-open detail tab from URL params (e.g., from dashboard navigation)
  const urlTabOpenDone = useRef(false)
  useEffect(() => {
    if (urlTabOpenDone.current || loading || executions.length === 0) return
    const tabParam = searchParams.get("tab")
    const execIdParam = searchParams.get("execId")
    if (tabParam === "detail" && execIdParam) {
      urlTabOpenDone.current = true
      const execution = executions.find(e => e.id === execIdParam)
      if (execution) {
        handleNodeClick(execution)
      }
    }
  }, [loading, executions, searchParams])

  const handleFileSelect = (file: FileNode) => {
    setSelectedFile(file)
  }

  const handleNodeClick = (execution: Execution) => {
    const existingTab = tabs.find(t => t.executionId === execution.id)
    if (existingTab) {
      setActiveTabId(existingTab.id)
      return
    }

    const newTab: EditorTab = {
      id: `detail-${execution.id}`,
      name: execution.workflowName ?? execution.id,
      type: "detail",
      closable: true,
      executionId: execution.id,
    }
    setTabs(prev => [...prev.slice(0, 1), newTab, ...prev.slice(1)])
    setActiveTabId(newTab.id)
  }

  const handleOpenAsWorkflow = async (file: FileNode) => {
    const existingTab = tabs.find(t => t.filePath === file.path && t.type === "workflow-editor")
    if (existingTab) {
      setActiveTabId(existingTab.id)
      return
    }
    // YDoc content first; if empty, fetch via API
    let content = yDoc ? getYContent(yDoc, file.path) : ""
    if (!content) {
      try {
        content = await fetchFileContent(id, file.path)
      } catch { content = "" }
    }
    setFileContents(prev => ({...prev, [file.path]: content}))
    setSavedContents(prev => ({...prev, [file.path]: content}))
    const newTab: EditorTab = {
      id: `wf-${file.id}`,
      name: `${file.name} (流程图)`,
      type: "workflow-editor",
      closable: true,
      filePath: file.path,
      fileName: file.name,
    }
    setTabs(prev => [...prev.slice(0, 1), newTab, ...prev.slice(1)])
    setActiveTabId(newTab.id)
  }

const handleOpenAsText = async (file: FileNode) => {
    const existingTab = tabs.find(t => t.filePath === file.path && t.type === "text-editor")
    if (existingTab) {
      setActiveTabId(existingTab.id)
      return
    }
    // YDoc content first; if empty (large file not in YDoc), fetch via API
    let content = yDoc ? getYContent(yDoc, file.path) : ""
    if (!content) {
      try {
        content = await fetchFileContent(id, file.path)
      } catch { content = "" }
    }
    setFileContents(prev => ({...prev, [file.path]: content}))
    setSavedContents(prev => ({...prev, [file.path]: content}))
    setFileOpenedAt(prev => ({...prev, [file.path]: content}))
    setHasExternalChange(prev => ({...prev, [file.path]: false}))
    const newTab: EditorTab = {
      id: `txt-${file.id}`,
      name: file.name,
      type: "text-editor",
      closable: true,
      filePath: file.path,
      fileName: file.name,
      extension: file.extension ?? file.name.split(".").pop() ?? "",
    }
    setTabs(prev => [...prev.slice(0, 1), newTab, ...prev.slice(1)])
    setActiveTabId(newTab.id)
  }

  const handleContentChange = useCallback((filePath: string, content: string) => {
    setFileContents(prev => ({...prev, [filePath]: content}))
  }, [])

  const handleSave = useCallback(async (filePath: string, content?: string) => {
    if (hasExternalChange[filePath]) {
      setConflictFile(filePath)
      return
    }
    const finalContent = content ?? fileContents[filePath] ?? ""
    const originalContent = fileOpenedAt[filePath] ?? ""
    setIsSaving(true)
    try {
      const result = await saveFileEntry(id, { path: filePath, content: finalContent, originalContent })
      if (result && "conflict" in result && result.conflict) {
        setExternalContent(prev => ({...prev, [filePath]: result.externalContent ?? ""}))
        setHasExternalChange(prev => ({...prev, [filePath]: true}))
        setConflictFile(filePath)
        return
      }
      setSavedContents(prev => ({...prev, [filePath]: finalContent}))
      setFileOpenedAt(prev => ({...prev, [filePath]: finalContent}))
      toast.success(`文件已保存: ${filePath}`, { duration: 2000 })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "保存失败")
    } finally {
      setIsSaving(false)
    }
  }, [fileContents, hasExternalChange, id, fileOpenedAt])

  const handleForceSave = useCallback(async () => {
    if (!conflictFile) return
    const content = fileContents[conflictFile] ?? ""
    const originalContent = fileOpenedAt[conflictFile] ?? ""
    setSavedContents(prev => ({...prev, [conflictFile]: content}))
    try {
      const result = await saveFileEntry(id, { path: conflictFile, content, originalContent })
      if (result && "conflict" in result && result.conflict) {
        setExternalContent(prev => ({...prev, [conflictFile]: result.externalContent ?? ""}))
        setHasExternalChange(prev => ({...prev, [conflictFile]: true}))
        setConflictFile(conflictFile)
        return
      }
      setHasExternalChange(prev => ({...prev, [conflictFile]: false}))
      setExternalContent(prev => { const n = {...prev}; delete n[conflictFile]; return n })
      setConflictFile(null)
      setConflictResetKey(k => k + 1)
      toast.success(`文件已保存: ${conflictFile}`, { duration: 2000 })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "保存失败")
    }
  }, [conflictFile, fileContents, fileOpenedAt, id])

  const handleDiscardEdits = useCallback(() => {
    if (!conflictFile) return
    const external = externalContent[conflictFile] ?? ""
    if (yDoc) {
      yDoc.transact(() => {
        const ytext = getYText(yDoc, conflictFile)
        if (ytext) {
          ytext.delete(0, ytext.length)
          ytext.insert(0, external)
        }
      }, INTERNAL_ORIGIN)
    }
    setFileContents(prev => ({...prev, [conflictFile]: external}))
    setSavedContents(prev => ({...prev, [conflictFile]: external}))
    setFileOpenedAt(prev => ({...prev, [conflictFile]: external}))
    setHasExternalChange(prev => ({...prev, [conflictFile]: false}))
    setExternalContent(prev => { const n = {...prev}; delete n[conflictFile]; return n })
    setConflictFile(null)
    setConflictResetKey(k => k + 1)
    setForceContentVersion(v => v + 1)
  }, [conflictFile, externalContent, yDoc])

  const handleSaveMerged = useCallback(async (content: string) => {
    if (!conflictFile) return
    setFileContents(prev => ({...prev, [conflictFile]: content}))
    setSavedContents(prev => ({...prev, [conflictFile]: content}))
    setFileOpenedAt(prev => ({...prev, [conflictFile]: content}))
    setHasExternalChange(prev => ({...prev, [conflictFile]: false}))
    setExternalContent(prev => { const n = {...prev}; delete n[conflictFile]; return n })
    setConflictFile(null)
    setConflictResetKey(k => k + 1)
    setForceContentVersion(v => v + 1)
    if (yDoc) {
      yDoc.transact(() => {
        const ytext = getYText(yDoc, conflictFile)
        if (ytext) {
          ytext.delete(0, ytext.length)
          ytext.insert(0, content)
        }
      }, INTERNAL_ORIGIN)
    }
    try {
      await saveFileEntry(id, { path: conflictFile, content, force: true })
      toast.success(`文件已保存: ${conflictFile}`, { duration: 2000 })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "保存失败")
    }
  }, [conflictFile, id, yDoc])

  const handleConflictDetected = useCallback((filePath: string) => {
    const current = yDoc ? getYContent(yDoc, filePath) : ""
    if (current && current !== fileOpenedAt[filePath]) {
      setExternalContent(prev => ({...prev, [filePath]: current}))
      setHasExternalChange(prev => ({...prev, [filePath]: true}))
    }
  }, [yDoc, fileOpenedAt])

  const handleCloseTab = (tabId: string, e: React.MouseEvent) => {
    e.stopPropagation()
    const tab = tabs.find(t => t.id === tabId)
    if (!tab?.closable) return

    if (tab.filePath && isDirty(tab.filePath)) {
      setPendingCloseTab(tab)
      return
    }

    closeTab(tabId)
  }

  const closeTab = (tabId: string) => {
    const newTabs = tabs.filter(t => t.id !== tabId)
    setTabs(newTabs)
    if (activeTabId === tabId) {
      setActiveTabId(newTabs.length > 0 ? newTabs[newTabs.length - 1].id : "execution")
    }
  }

  const handleCloseAllTabs = () => {
    const newTabs = tabs.filter(t => !t.closable)
    setTabs(newTabs)
    if (!newTabs.find(t => t.id === activeTabId)) {
      setActiveTabId(newTabs.length > 0 ? newTabs[newTabs.length - 1].id : "execution")
    }
  }

  const handleCloseOtherTabs = () => {
    const newTabs = tabs.filter(t => !t.closable || t.id === activeTabId)
    setTabs(newTabs)
  }

  const handleSaveAndClose = () => {
    if (!pendingCloseTab?.filePath) return
    const fp = pendingCloseTab.filePath
    setSavedContents(prev => ({...prev, [fp]: fileContents[fp]}))
    toast.success(`文件已保存: ${fp}`, { duration: 2000 })
    closeTab(pendingCloseTab.id)
    setPendingCloseTab(null)

    if (pendingDeleteAfterClose) {
      setPendingDeleteNode(pendingDeleteAfterClose)
      setPendingDeleteAfterClose(null)
    }
  }

  const handleDiscardAndClose = () => {
    if (!pendingCloseTab) return
    closeTab(pendingCloseTab.id)
    setPendingCloseTab(null)

    if (pendingDeleteAfterClose) {
      setPendingDeleteNode(pendingDeleteAfterClose)
      setPendingDeleteAfterClose(null)
    }
  }

  const handleCancelClose = () => {
    setPendingCloseTab(null)
    setPendingDeleteAfterClose(null)
  }

  const handleConfirmDelete = async () => {
    if (!pendingDeleteNode) return
    const delPath = pendingDeleteNode.path
    const descendantPaths = getDescendantFilePaths(pendingDeleteNode)
    const label = pendingDeleteNode.type === "file" ? "文件" : "文件夹"

    descendantPaths.forEach(filePath => {
      const tab = tabs.find(t => t.filePath === filePath)
      if (tab) closeTab(tab.id)
      setFileContents(prev => {
        const next = {...prev}
        delete next[filePath]
        return next
      })
      setSavedContents(prev => {
        const next = {...prev}
        delete next[filePath]
        return next
      })
    })

    if (selectedFile && descendantPaths.includes(selectedFile.path)) {
      setSelectedFile(null)
    }
    setPendingDeleteNode(null)

    try {
      await deleteFileEntry(id, { path: delPath })
      if (yDoc) deleteFromYTree(yDoc, delPath)
      toast.success(`已删除${label}: ${delPath}`, { duration: 2000 })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "删除失败")
    }
  }

  const handleCancelDelete = () => {
    setPendingDeleteNode(null)
  }

  function getDescendantFilePaths(node: FileNode): string[] {
    if (node.type === "file") return [node.path]
    return (node.children || []).flatMap(child => getDescendantFilePaths(child))
  }

  const handleCreateEntry = useCallback(async (parentPath: string, entryName: string, entryType: "file" | "directory") => {
    if (!entryName) return

    const filePath = parentPath === "/" ? `/${entryName}` : `${parentPath}/${entryName}`

    try {
      await createFileEntry(id, { path: filePath, type: entryType })
      if (yDoc) addToYTree(yDoc, filePath, entryType === "directory")
      toast.success(`已创建${entryType === "file" ? "文件" : "文件夹"}: ${filePath}`, { duration: 2000 })

      if (entryType === "file") {
        setFileContents(prev => ({...prev, [filePath]: ""}))
        setSavedContents(prev => ({...prev, [filePath]: ""}))
        const newTab: EditorTab = {
          id: `txt-new-${Date.now()}`,
          name: entryName,
          type: "text-editor",
          closable: true,
          filePath,
          fileName: entryName,
          extension: entryName.split(".").pop() ?? "",
        }
        setTabs(prev => [...prev.slice(0, 1), newTab, ...prev.slice(1)])
        setActiveTabId(newTab.id)
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "创建失败")
    }
  }, [id, yDoc])

  const handleDeleteEntry = useCallback((node: FileNode) => {
    if (node.type === "file") {
      const tab = tabs.find(t => t.filePath === node.path)
      if (tab && isDirty(node.path)) {
        setPendingCloseTab(tab)
        setPendingDeleteAfterClose(node)
        return
      }
      setPendingDeleteNode(node)
      return
    }

    setPendingDeleteNode(node)
  }, [tabs])

  const handleRenameEntry = useCallback(async (node: FileNode, newName: string) => {
    if (newName === node.name) return

    const parentDir = node.path.substring(0, node.path.lastIndexOf("/")) || ""
    const newPath = parentDir === "" ? `/${newName}` : `${parentDir}/${newName}`

    try {
      await renameFileEntry(id, { path: node.path, newName })
      if (yDoc) renameInYTree(yDoc, node.path, newPath)
      toast.success(`已重命名: ${node.name} → ${newName}`, { duration: 2000 })

      // Update open tabs that reference the old path
      setTabs(prev => prev.map(t => {
        if (t.filePath === node.path) {
          return { ...t, filePath: newPath, fileName: newName, name: t.type === "workflow-editor" ? `${newName} (流程图)` : newName }
        }
        return t
      }))

      // Migrate file contents
      setFileContents(prev => {
        const next = { ...prev }
        if (node.path in next) {
          next[newPath] = next[node.path]
          delete next[node.path]
        }
        return next
      })
      setSavedContents(prev => {
        const next = { ...prev }
        if (node.path in next) {
          next[newPath] = next[node.path]
          delete next[node.path]
        }
        return next
      })
      if (selectedFile?.path === node.path) {
        setSelectedFile(null)
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "重命名失败")
    }
  }, [id, yDoc, selectedFile])

  const activeTab = tabs.find(t => t.id === activeTabId)!

  const workspaceName: string = workspace?.name ?? id
  const workspaceStatus: string = workspace?.status ?? "active"

  if (loading) {
    return (
      <div className="flex h-[calc(100vh-3.5rem)] items-center justify-center">
        <p className="text-muted-foreground">加载中...</p>
      </div>
    )
  }

  if (loadError || !workspace) {
    if (!loadError && !workspace) notFound()
    return (
      <div className="flex h-[calc(100vh-3.5rem)] flex-col items-center justify-center gap-2">
        <p className="text-destructive">{loadError ?? "工作空间不存在"}</p>
        <button className="text-sm text-primary underline" onClick={fetchWorkspaceData}>重试</button>
      </div>
    )
  }

  return (
    <div className="flex h-[calc(100vh-3.5rem)] flex-col">
      {/* Workspace Header */}
      <div className="flex h-11 items-center justify-between border-b border-border px-4 bg-background">
        <div className="flex items-center gap-3">
          <h1 className="font-semibold">{workspaceName}</h1>
          <Badge variant={workspaceStatus === "active" ? "default" : "secondary"}>
            {workspaceStatus === "active" ? "活跃" : workspaceStatus === "error" ? "异常" : "未激活"}
          </Badge>
          <span className="text-xs text-muted-foreground">org: {workspace.org}</span>
          <span className="text-xs text-muted-foreground">{workspace.path}</span>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => setShowFileTree(!showFileTree)}>
            <PanelLeftClose className="h-4 w-4" />
            <span className="sr-only">切换文件树</span>
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setShowChat(!showChat)}>
            <PanelRightClose className="h-4 w-4" />
            <span className="sr-only">切换聊天</span>
          </Button>
          <Button variant="outline" size="sm">
            <Settings className="mr-2 h-4 w-4" />
            设置
          </Button>

        </div>
      </div>

      {/* Three-column layout: File Tree | Workflow Panel | Chat */}
      <PanelGroup direction="horizontal" className="flex-1">
        {/* Left: File Tree */}
        {showFileTree && (
          <>
            <Panel defaultSize={15} minSize={10} maxSize={30} className="min-w-0">
              <div className="h-full">
                <SidebarFileTree
                  doc={yDoc}
                  connected={connected}
                  workspacePath={workspace?.path}
                  onFileSelect={handleFileSelect}
                  selectedPath={selectedFile?.path}
                  onOpenAsWorkflow={handleOpenAsWorkflow}
                  onOpenAsText={handleOpenAsText}
                  fileContents={savedContents}
                  onCreateEntryConfirm={handleCreateEntry}
                  onDeleteConfirm={handleDeleteEntry}
                  onRenameConfirm={handleRenameEntry}
                  onRefresh={async () => { await refreshFileTree(id) }}
                  externalChanges={hasExternalChange}
                />
                {/* Schedule entry button */}
                <div className="border-t border-border/40 p-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="w-full justify-start gap-2"
                    onClick={() => {
                      const scheduleTab: EditorTab = { id: "schedule", name: "调度管理", type: "schedule", closable: true }
                      const exists = tabs.some(t => t.id === "schedule")
                      if (!exists) setTabs(prev => [...prev, scheduleTab])
                      setActiveTabId("schedule")
                    }}
                  >
                    <Clock className="h-4 w-4" />
                    调度管理
                  </Button>
                </div>
              </div>
            </Panel>
            <PanelResizeHandle className="w-1 bg-border/40 hover:bg-border transition-colors" />
          </>
        )}

        {/* Center: Workflow Panel with Tabs */}
        <Panel
          defaultSize={showFileTree && showChat ? 60 : showFileTree ? 80 : showChat ? 75 : 100}
          minSize={40}
          className="min-w-0"
        >
          <div className="flex flex-col h-full">
            {/* Tab Bar */}
            <ContextMenu>
              <ContextMenuTrigger asChild>
                <div className="flex items-center border-b border-border bg-background">
                  <div className="flex flex-1 overflow-x-auto">
                    {tabs.map((tab) => (
                      <button
                        key={tab.id}
                        className={"flex items-center gap-2 px-3 py-2 text-sm border-b-2 transition-colors whitespace-nowrap " +
                          (activeTabId === tab.id
                            ? "border-primary text-primary font-medium"
                            : "border-transparent text-muted-foreground hover:text-foreground")
                        }
                        onClick={() => setActiveTabId(tab.id)}
                      >
                        {tab.type === "execution" && <GitBranch className="h-4 w-4" />}
                        {tab.type === "detail" && <Play className="h-4 w-4" />}
                        {tab.type === "workflow-editor" && <GitBranch className="h-4 w-4 text-violet-500" />}
                        {tab.type === "text-editor" && <FileCode className="h-4 w-4" />}
                        {tab.type === "schedule" && <Clock className="h-4 w-4 text-blue-500" />}
                        <span title={tab.name}>{getTabDisplayName(tab, tabs)}</span>
                        {tab.filePath && isDirty(tab.filePath) && (
                          <span className="text-orange-500 text-xs">●</span>
                        )}
                        {tab.closable && (
                          <span
                            className="ml-1 rounded-full p-0.5 hover:bg-muted"
                            onClick={(e) => handleCloseTab(tab.id, e)}
                          >
                            <X className="h-3 w-3" />
                          </span>
                        )}
                      </button>
                    ))}
                  </div>
                  <div className="flex items-center gap-1 px-2">
                    {activeTab.filePath && isDirty(activeTab.filePath) && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleSave(activeTab.filePath!)}
                        disabled={isSaving}
                      >
                        {isSaving ? (
                          <span className="flex items-center gap-1">
                            <span className="h-3 w-3 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                            <span className="text-xs">保存中...</span>
                          </span>
                        ) : (
                          <Save className="h-4 w-4" />
                        )}
                        <span className="sr-only">保存</span>
                      </Button>
                    )}
                  </div>
                </div>
              </ContextMenuTrigger>
              <ContextMenuContent className="w-48">
                <ContextMenuItem onClick={handleCloseOtherTabs}>
                  关闭其他标签
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem onClick={handleCloseAllTabs}>
                  关闭所有标签
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>

            {/* Tab Content */}
            <div className="flex-1 overflow-hidden">
              {activeTab.type === "execution" ? (
                <WorkflowFlowPanel
                  workspaceId={id}
                  executions={executions}
                  workflowOptions={workflowOptions}
                  org={workspace?.org ?? "default"}
                  onNodeClick={handleNodeClick}
                  onRefresh={fetchWorkspaceData}
                />
              ) : activeTab.type === "workflow-editor" ? (
                <WorkflowEditorTab
                  key={activeTab.filePath}
                  filePath={activeTab.filePath!}
                  initialContent={savedContents[activeTab.filePath!] || ""}
                  onContentChange={handleContentChange}
                  onSave={handleSave}
                />
              ) : activeTab.type === "text-editor" ? (
                <TextEditorTab
                  key={activeTab.filePath}
                  filePath={activeTab.filePath!}
                  fileName={activeTab.fileName!}
                  extension={activeTab.extension}
                  initialContent={savedContents[activeTab.filePath!] || ""}
                  doc={yDoc}
                  onContentChange={handleContentChange}
                  onSave={handleSave}
                  baseContent={activeTab.filePath ? fileOpenedAt[activeTab.filePath] ?? "" : ""}
                  hasConflict={activeTab.filePath ? hasExternalChange[activeTab.filePath] ?? false : false}
                  onViewConflict={() => {
                    if (activeTab.filePath) setConflictFile(activeTab.filePath)
                  }}
                  onConflictDetected={handleConflictDetected}
                  conflictResetKey={conflictResetKey}
                  forceContentVersion={forceContentVersion}
                />
              ) : activeTab.type === "schedule" ? (
                <ScheduleTab workspaceId={id} />
              ) : activeExecution ? (
                <WorkflowDetailPanel
                  execution={activeExecution}
                  workflow={activeWorkflow}
                  workspaceId={id}
                />
              ) : null}
            </div>
          </div>
        </Panel>

        {/* Right: Session Tabs + Chat Panel */}
        {showChat && (
          <>
            <PanelResizeHandle className="w-1 bg-border/40 hover:bg-border transition-colors" />
            <Panel defaultSize={25} minSize={15} maxSize={40} className="min-w-0">
              <div className="h-full">
                <ChatPanel
                  messages={messages}
                  sessions={allSessions}
                  activeSessionId={activeSessionId}
                  isStreaming={isCurrentSessionStreaming}
                  status={status}
                  streamStartMs={streamStartMs}
                  streamEndState={streamEndState}
                  hasMoreMessages={hasMoreMessages}
                  onLoadMoreMessages={loadMoreMessages}
                  onSendMessage={async (content) => {
                    const sid = await sendMessage(content)
                    if (sid && sid !== activeSessionId) {
                      setActiveSessionId(sid)
                    }
                  }}
                  onAbort={abort}
                  onCreateSession={createSession}
                  onSelectSession={(sessionId) => {
                    setActiveSessionId(sessionId)
                    switchSession(sessionId)
                  }}
                  onDeleteSession={(sessionId) => {
                    deleteSession(sessionId)
                    if (activeSessionId === sessionId) {
                      const remaining = allSessions.filter(s => s.id !== sessionId)
                      if (remaining.length > 0) {
                        const nextId = remaining[0].id
                        setActiveSessionId(nextId)
                        switchSession(nextId)
                      } else {
                        setActiveSessionId(null)
                      }
                    }
                  }}
                  onRenameSession={renameSession}
                />
              </div>
            </Panel>
          </>
        )}
      </PanelGroup>
      <AlertDialog open={pendingCloseTab !== null} onOpenChange={(open) => !open && handleCancelClose()}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>未保存的修改</AlertDialogTitle>
            <AlertDialogDescription>
              文件 &ldquo;{pendingCloseTab?.fileName || pendingCloseTab?.filePath}&rdquo; 有未保存的修改，关闭前是否保存？
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={handleCancelClose}>取消</AlertDialogCancel>
            <AlertDialogAction onClick={handleDiscardAndClose} className="border border-input bg-background hover:bg-accent text-foreground">
              不保存
            </AlertDialogAction>
            <AlertDialogAction onClick={handleSaveAndClose} className="bg-primary text-primary-foreground hover:bg-primary/90">
              保存
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={pendingDeleteNode !== null} onOpenChange={(open) => !open && handleCancelDelete()}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除确认</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDeleteNode?.type === "file"
                ? `确定要删除文件「${pendingDeleteNode?.name}」吗？删除将不可恢复。`
                : `此文件夹包含 ${pendingDeleteNode ? getDescendantFilePaths(pendingDeleteNode).length : 0} 个文件，确定要删除吗？删除将不可恢复。`
              }
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={handleCancelDelete}>取消</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirmDelete} className="bg-destructive text-white hover:bg-destructive/90">
              确认删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <ConflictDialog
        open={conflictFile !== null}
        filePath={conflictFile ?? ""}
        myContent={conflictFile ? fileContents[conflictFile] ?? "" : ""}
        externalContent={conflictFile ? externalContent[conflictFile] ?? "" : ""}
        onDiscardEdits={handleDiscardEdits}
        onCancel={handleCancelDelete}
        onOpenChange={(open) => !open && setConflictFile(null)}
        onSaveMerged={handleSaveMerged}
      />
      <CommandPalette
        open={cmdOpen}
        onOpenChange={setCmdOpen}
        workflows={cmdWorkflows}
        executions={cmdExecutions}
        workspaceId={id}
      />
    </div>
  )
}
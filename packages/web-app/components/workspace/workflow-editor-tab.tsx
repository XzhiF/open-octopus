"use client"

import { useState, useCallback, useEffect } from "react"
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels"
import { WorkflowYamlEditor } from "./workflow-yaml-editor"
import { WorkflowFlowViewer } from "./workflow-flow-viewer"
import { parseYaml } from "@/lib/yaml-utils"
import { yamlToFlowData } from "@/lib/workflow-parser"
import { toast } from "sonner"
import type { Node, Edge } from "@xyflow/react"

interface WorkflowEditorTabProps {
  filePath: string
  initialContent: string
  onContentChange?: (filePath: string, content: string) => void
  onSave?: (filePath: string, content: string) => void
}

interface ParsedState {
  nodes: Node[]
  edges: Edge[]
}

export function WorkflowEditorTab({ filePath, initialContent, onContentChange, onSave }: WorkflowEditorTabProps) {
  const [yamlContent, setYamlContent] = useState(initialContent)
  const [lastValidParsed, setLastValidParsed] = useState<ParsedState | null>(() => {
    const parsed = parseYaml(initialContent)
    if (parsed) {
      const flowData = yamlToFlowData(parsed)
      if (flowData) return { nodes: flowData.nodes, edges: flowData.edges }
    }
    return null
  })
  const [isEmpty, setIsEmpty] = useState(() => {
    const parsed = parseYaml(initialContent)
    return !parsed || !Array.isArray(parsed.nodes) || parsed.nodes.length === 0
  })

  useEffect(() => {
    setYamlContent(initialContent)
    const parsed = parseYaml(initialContent)
    if (parsed) {
      const flowData = yamlToFlowData(parsed)
      if (flowData) {
        setLastValidParsed({ nodes: flowData.nodes, edges: flowData.edges })
        setIsEmpty(false)
      } else {
        setLastValidParsed(null)
        setIsEmpty(!parsed.nodes || !Array.isArray(parsed.nodes) || parsed.nodes.length === 0)
      }
    } else {
      setLastValidParsed(null)
      setIsEmpty(true)
    }
  }, [filePath, initialContent])

  const handleYamlChange = useCallback((value: string) => {
    setYamlContent(value)
    onContentChange?.(filePath, value)
    const parsed = parseYaml(value)
    if (!parsed) {
      toast.error("YAML 语法错误，流程图保持上次合法状态", { duration: 3000 })
      return
    }
    const flowData = yamlToFlowData(parsed)
    if (!flowData) {
      if (!parsed.nodes || !Array.isArray(parsed.nodes) || parsed.nodes.length === 0) {
        setIsEmpty(true)
        setLastValidParsed(null)
      } else {
        toast.error("Workflow 结构不合规，流程图保持上次合法状态", { duration: 3000 })
      }
      return
    }
    setIsEmpty(false)
    setLastValidParsed({ nodes: flowData.nodes, edges: flowData.edges })
  }, [filePath, onContentChange])

  const handleSave = useCallback(() => {
    onSave?.(filePath, yamlContent)
  }, [filePath, yamlContent, onSave])

  const flowNodes = lastValidParsed?.nodes || []
  const flowEdges = lastValidParsed?.edges || []

  return (
    <PanelGroup direction="horizontal" className="h-full">
      <Panel defaultSize={60} minSize={30}>
        <WorkflowYamlEditor value={yamlContent} onChange={handleYamlChange} onSave={handleSave} />
      </Panel>
      <PanelResizeHandle className="w-1 bg-border/40 hover:bg-border transition-colors" />
      <Panel defaultSize={40} minSize={20}>
        <WorkflowFlowViewer nodes={flowNodes} edges={flowEdges} isEmpty={isEmpty} />
      </Panel>
    </PanelGroup>
  )
}
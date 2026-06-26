"use client"

import { useRef, useCallback, useEffect } from "react"
import "@/lib/monaco-config"
import Editor, { type OnMount } from "@monaco-editor/react"

interface WorkflowYamlEditorProps {
  value: string
  onChange: (value: string) => void
  onSave?: () => void
}

export function WorkflowYamlEditor({ value, onChange, onSave }: WorkflowYamlEditorProps) {
  const editorRef = useRef<unknown>(null)
  const onSaveRef = useRef(onSave)
  onSaveRef.current = onSave

  // Global Cmd+S / Ctrl+S — capture phase prevents the browser's native
  // "Save Page" dialog from stealing the event on macOS.
  useEffect(() => {
    if (!onSave) return
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault()
        e.stopPropagation()
        onSaveRef.current?.()
      }
    }
    window.addEventListener("keydown", handler, { capture: true })
    return () => window.removeEventListener("keydown", handler, { capture: true })
  }, [!!onSave])

  const handleMount: OnMount = (editor, monaco) => {
    editorRef.current = editor
    if (onSave) {
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
        onSaveRef.current?.()
      })
    }
  }

  const handleChange = useCallback(
    (value: string | undefined) => {
      onChange(value || "")
    },
    [onChange]
  )

  return (
    <div className="h-full w-full">
      <Editor
        height="100%"
        language="yaml"
        value={value}
        onChange={handleChange}
        onMount={handleMount}
        theme="vs-dark"
        options={{
          minimap: { enabled: false },
          fontSize: 13,
          lineNumbers: "on",
          scrollBeyondLastLine: false,
          automaticLayout: true,
          tabSize: 2,
          wordWrap: "on",
          folding: true,
          renderLineHighlight: "all",
          scrollbar: {
            verticalScrollbarSize: 8,
            horizontalScrollbarSize: 8,
          },
          padding: { top: 8 },
        }}
      />
    </div>
  )
}
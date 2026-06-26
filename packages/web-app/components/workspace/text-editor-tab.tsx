"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import * as Y from "yjs"
import { configureMonaco } from "@/lib/monaco-config"
import Editor, { type OnMount } from "@monaco-editor/react"
import type { editor } from "monaco-editor"
import { getLanguageFromExtension } from "@/lib/yaml-utils"

interface TextEditorTabProps {
  filePath: string
  fileName: string
  extension?: string
  initialContent: string
  doc?: Y.Doc | null
  onContentChange?: (filePath: string, content: string) => void
  onSave?: (filePath: string, content: string) => void
  baseContent?: string
  hasConflict?: boolean
  onViewConflict?: () => void
  onConflictDetected?: (filePath: string) => void
  conflictResetKey?: number
  forceContentVersion?: number
}

export const INTERNAL_ORIGIN = "__internal__"

function getYText(doc: Y.Doc, filePath: string): Y.Text | null {
  const tree = doc.getMap("fileTree")
  const segs = filePath.replace(/^\//, "").split("/")
  let current: Y.Map<unknown> = tree
  for (let i = 0; i < segs.length - 1; i++) {
    const next = current.get(segs[i])
    if (!next || !(next instanceof Y.Map)) return null
    current = next as Y.Map<unknown>
  }
  const fileNode = current.get(segs[segs.length - 1])
  if (!fileNode || !(fileNode instanceof Y.Map)) return null
  const ytext = fileNode.get("content")
  if (ytext instanceof Y.Text) return ytext
  return null
}

export { getYText }

export function TextEditorTab({
  filePath, fileName, extension, initialContent, doc,
  hasConflict, onContentChange, onSave,
  onViewConflict,
  forceContentVersion,
}: TextEditorTabProps) {
  const language = getLanguageFromExtension(extension)
  const [content, setContent] = useState(initialContent)
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null)
  const bindingRef = useRef<any>(null)
  const observerRef = useRef<(() => void) | null>(null)
  const ytextRef = useRef<Y.Text | null>(null)
  // Refs for latest values — avoids stale closure in keyboard handlers
  const contentRef = useRef(content)
  const onSaveRef = useRef(onSave)
  contentRef.current = content
  onSaveRef.current = onSave

  useEffect(() => {
    setContent(initialContent)
  }, [initialContent])

  // Configure Monaco editor on client side
  useEffect(() => {
    configureMonaco()
  }, [])

  useEffect(() => {
    if (editorRef.current && bindingRef.current && ytextRef.current) {
      const current = ytextRef.current.toString()
      const model = editorRef.current.getModel()
      if (model && model.getValue() !== current) {
        model.setValue(current)
      }
      onContentChange?.(filePath, current)
    }
  }, [forceContentVersion, filePath, onContentChange])

  // Global Cmd+S / Ctrl+S handler — intercepts at capture phase so the
  // browser's native "Save Page" dialog does not steal the event on macOS.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault()
        e.stopPropagation()
        const currentContent = ytextRef.current?.toString() ?? contentRef.current
        onSaveRef.current?.(filePath, currentContent)
      }
    }
    window.addEventListener("keydown", handler, { capture: true })
    return () => window.removeEventListener("keydown", handler, { capture: true })
  }, [filePath])

  const handleMount: OnMount = async (editor, monaco) => {
    editorRef.current = editor

    if (doc) {
      const { MonacoBinding } = await import("y-monaco")
      const ytext = getYText(doc, filePath)
      if (ytext) {
        ytextRef.current = ytext
        const model = editor.getModel()
        if (model) {
          bindingRef.current = new MonacoBinding(ytext, model, new Set(), undefined)

          const observer = () => {
            onContentChange?.(filePath, ytext.toString())
          }
          ytext.observe(observer)

          observerRef.current = () => {
            ytext.unobserve(observer)
          }

          // Belt-and-suspenders: also register inside Monaco (works when
          // the editor has focus and the global handler above doesn't fire).
          editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
            onSaveRef.current?.(filePath, ytext.toString())
          })
          return
        }
      }
    }

    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      onSaveRef.current?.(filePath, contentRef.current)
    })
  }

  useEffect(() => {
    return () => {
      observerRef.current?.()
    }
  }, [])

  const handleChange = useCallback((value: string | undefined) => {
    if (bindingRef.current) return
    const newContent = value || ""
    setContent(newContent)
    onContentChange?.(filePath, newContent)
  }, [filePath, onContentChange])

  return (
    <div className="h-full w-full">
      {hasConflict && (
        <div className="flex items-center gap-2 bg-yellow-50 border-b border-yellow-200 px-3 py-1.5 text-sm">
          <span className="text-yellow-600">&#9888;</span>
          <span className="text-yellow-800 text-xs">其他人修改了此文件</span>
          <button
            onClick={onViewConflict}
            className="ml-auto text-xs text-blue-600 hover:text-blue-800 underline font-medium"
          >
            查看 diff
          </button>
        </div>
      )}
      <Editor
        height="100%"
        language={language}
        value={bindingRef.current ? undefined : content}
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

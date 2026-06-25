"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { DiffEditor } from "@monaco-editor/react"
import Editor, { type OnMount } from "@monaco-editor/react"
import type { editor } from "monaco-editor"
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

import { getLanguageFromExtension } from "@/lib/yaml-utils"

interface ConflictDialogProps {
  open: boolean
  filePath: string
  myContent: string
  externalContent: string
  onDiscardEdits: () => void
  onCancel: () => void
  onSaveMerged: (content: string) => void
  onOpenChange: (open: boolean) => void
}

function detectLanguage(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? ""
  return getLanguageFromExtension(ext)
}

function buildConflictMarkers(myContent: string, externalContent: string): string {
  return `<<<<<<< 外部版本
${externalContent}
=======
${myContent}
>>>>>>> 我的版本`
}

type Mode = "diff" | "merge"

export function ConflictDialog({
  open,
  filePath,
  myContent,
  externalContent,
  onDiscardEdits,
  onCancel,
  onSaveMerged,
  onOpenChange,
}: ConflictDialogProps) {
  const language = detectLanguage(filePath)

  const [mode, setMode] = useState<Mode>("diff")
  const [mergeContent, setMergeContent] = useState("")
  const mergeEditorRef = useRef<editor.IStandaloneCodeEditor | null>(null)

  useEffect(() => {
    if (open) {
      setMode("diff")
      setMergeContent(buildConflictMarkers(myContent, externalContent))
    }
  }, [open, myContent, externalContent])

  const handleMergeMount: OnMount = useCallback((editor) => {
    mergeEditorRef.current = editor
  }, [])

  const handleEnterMerge = useCallback(() => {
    setMergeContent(buildConflictMarkers(myContent, externalContent))
    setMode("merge")
  }, [myContent, externalContent])

  const handleCancelMerge = useCallback(() => {
    setMergeContent(buildConflictMarkers(myContent, externalContent))
    setMode("diff")
  }, [myContent, externalContent])

  const handleSaveMerge = useCallback(() => {
    const content = mergeEditorRef.current?.getValue() ?? mergeContent
    onSaveMerged(content)
  }, [mergeContent, onSaveMerged])

  if (mode === "merge") {
    return (
      <AlertDialog open={open} onOpenChange={onOpenChange}>
        <AlertDialogContent className="max-w-[95vw] w-[95vw] sm:max-w-[95vw] max-h-[95vh] p-4 flex flex-col">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-lg">
              <span className="text-orange-400">&#9888;</span>
              解决冲突：{filePath}
            </AlertDialogTitle>
            <AlertDialogDescription>
              下方标记了冲突区域，请手动编辑合并，然后保存结果。
            </AlertDialogDescription>
          </AlertDialogHeader>

          <div className="flex-1 min-h-0 mt-2 border border-border rounded-lg overflow-hidden">
            <Editor
              height="calc(95vh - 240px)"
              language={language}
              value={mergeContent}
              onChange={(v) => setMergeContent(v ?? "")}
              onMount={handleMergeMount}
              theme="vs"
              options={{
                minimap: { enabled: false },
                scrollBeyondLastLine: false,
                lineNumbers: "on",
                fontSize: 13,
                wordWrap: "on",
                automaticLayout: true,
                readOnly: false,
              }}
            />
          </div>

          <AlertDialogFooter className="mt-3 pt-3 border-t border-border flex-shrink-0 sm:justify-center">
            <div className="flex justify-center gap-2 w-full">
              <AlertDialogCancel onClick={handleCancelMerge}>
                取消
              </AlertDialogCancel>
              <AlertDialogAction onClick={handleSaveMerge} className="bg-green-600 hover:bg-green-700">
                确定保存
              </AlertDialogAction>
            </div>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    )
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="max-w-[95vw] w-[95vw] sm:max-w-[95vw] max-h-[95vh] p-4 flex flex-col">
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2 text-lg">
            <span className="text-yellow-500">&#9888;</span>
            文件冲突：{filePath}
          </AlertDialogTitle>
          <AlertDialogDescription>
            左侧你的版本，右侧外部修改。请选择如何处理。
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="flex-1 min-h-0 mt-2 border border-border rounded-lg overflow-hidden">
          <DiffEditor
            height="calc(95vh - 200px)"
            language={language}
            original={myContent}
            modified={externalContent}
            theme="vs"
            options={{
              readOnly: true,
              renderSideBySide: true,
              originalEditable: false,
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              lineNumbers: "on",
              fontSize: 13,
              wordWrap: "on",
              automaticLayout: true,
            }}
          />
        </div>

        <AlertDialogFooter className="mt-3 pt-3 border-t border-border flex-shrink-0 sm:justify-center">
          <div className="flex justify-center gap-2 w-full">
            <AlertDialogCancel onClick={onCancel}>
              返回编辑
            </AlertDialogCancel>
            <AlertDialogCancel
              onClick={onDiscardEdits}
              className="border-red-300 text-red-600 hover:bg-red-50"
            >
              外部覆盖
            </AlertDialogCancel>
            {/* Use native button instead of AlertDialogAction to prevent dialog close */}
            <button
              onClick={handleEnterMerge}
              className="inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 bg-blue-600 text-white hover:bg-blue-700 h-9 px-4 py-2 shadow"
            >
              解决冲突
            </button>
          </div>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

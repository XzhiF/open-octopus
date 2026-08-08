"use client"

import { useState, useEffect, useCallback, useRef } from "react"
import {
  fetchHarnessConfig,
  saveHarnessConfig,
  type HarnessConfigResponse,
} from "@/lib/harness-config-api"

interface UseHarnessConfigReturn {
  /** Current YAML content in the editor */
  content: string
  /** The last successfully saved content (for dirty-checking) */
  savedContent: string
  /** Current config version */
  version: number
  /** Where the config came from: 'db' or 'defaults' */
  source: "db" | "defaults" | null
  /** Whether the initial load is in progress */
  loading: boolean
  /** Whether a save operation is in progress */
  saving: boolean
  /** Load error message, if any */
  loadError: string | null
  /** Validation errors from the last save attempt */
  validationErrors: Array<{ path: string; message: string; code: string }>
  /** Whether the editor content differs from the saved version */
  isDirty: boolean
  /** Update the editor content */
  setContent: (value: string) => void
  /** Save the current content to the server */
  save: () => Promise<boolean>
  /** Reset the editor to the last saved content */
  reset: () => void
  /** Reload from server (discards unsaved changes) */
  reload: () => Promise<void>
  /** Reset to shipped defaults (replaces editor content with defaults YAML) */
  resetToDefaults: (defaultsYaml: string) => void
}

export function useHarnessConfig(): UseHarnessConfigReturn {
  const [content, setContent] = useState("")
  const [savedContent, setSavedContent] = useState("")
  const [version, setVersion] = useState(0)
  const [source, setSource] = useState<"db" | "defaults" | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [validationErrors, setValidationErrors] = useState<
    Array<{ path: string; message: string; code: string }>
  >([])

  const contentRef = useRef(content)
  contentRef.current = content

  const loadConfig = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const data: HarnessConfigResponse = await fetchHarnessConfig()
      setContent(data.config)
      setSavedContent(data.config)
      setVersion(data.version)
      setSource(data.source)
    } catch (err: unknown) {
      setLoadError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoading(true)
      setLoadError(null)
      try {
        const data = await fetchHarnessConfig()
        if (!cancelled) {
          setContent(data.config)
          setSavedContent(data.config)
          setVersion(data.version)
          setSource(data.source)
        }
      } catch (err: unknown) {
        if (!cancelled) {
          setLoadError(err instanceof Error ? err.message : String(err))
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const isDirty = content !== savedContent

  const save = useCallback(async (): Promise<boolean> => {
    if (saving) return false
    setSaving(true)
    setValidationErrors([])
    try {
      const result = await saveHarnessConfig(contentRef.current)
      setSavedContent(contentRef.current)
      setVersion(result.version)
      setSource("db")
      return true
    } catch (err: unknown) {
      const e = err as Error & {
        details?: Array<{ path: string; message: string; code: string }>
      }
      if (e.details && Array.isArray(e.details)) {
        setValidationErrors(e.details)
      }
      return false
    } finally {
      setSaving(false)
    }
  }, [saving])

  const reset = useCallback(() => {
    setContent(savedContent)
    setValidationErrors([])
  }, [savedContent])

  const reload = useCallback(async () => {
    await loadConfig()
  }, [loadConfig])

  const resetToDefaults = useCallback((defaultsYaml: string) => {
    setContent(defaultsYaml)
    setValidationErrors([])
  }, [])

  return {
    content,
    savedContent,
    version,
    source,
    loading,
    saving,
    loadError,
    validationErrors,
    isDirty,
    setContent,
    save,
    reset,
    reload,
    resetToDefaults,
  }
}

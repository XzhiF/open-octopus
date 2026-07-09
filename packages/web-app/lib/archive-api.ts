import { getServerUrl } from "@/lib/server-config"

async function handleResponse(res: Response) {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error?.message ?? body.error ?? `HTTP ${res.status}`)
  }
  return res.json()
}

function apiFetch(url: string, init?: RequestInit): Promise<Response> {
  return fetch(url, { ...init, credentials: "include" })
}

// ── Archive V2 Types ──────────────────────────────────────────────

export interface WorkspaceStats {
  execution_count: number
  success_rate: number
  total_cost: number
  total_duration_ms: number
  avg_cost_per_execution: number
  avg_duration_ms: number
  lifespan_days?: number
  workflow_count?: number
}

export interface CostEfficiency {
  rating: string
  analysis: string
  optimization_ideas: string[]
}

export interface AnalysisReport {
  summary: string
  execution_patterns: string[]
  cost_efficiency: CostEfficiency
  error_patterns: string[]
  recommendations: string[]
}

export interface ExperienceCandidate {
  id: string
  text: string
  scope: string
  confidence: number
  evidence?: string
  source?: string
  category?: string
  target?: string
  action?: "add" | "update" | "delete"
  replaces_text?: string
}

export interface SkillCandidate {
  name: string
  description: string
  reason: string
  content?: string
  content_outline?: string[]
  estimated_reuse?: string
}

export interface ArchivePreview {
  stats: WorkspaceStats
  analysis: AnalysisReport
  experiences: ExperienceCandidate[]
  skills: SkillCandidate[]
}

export async function previewArchive(workspaceId: string, org?: string): Promise<ArchivePreview> {
  const params = org ? `?org=${encodeURIComponent(org)}` : ""
  const res = await apiFetch(`${getServerUrl()}/api/archive/workspaces/${workspaceId}/archive-preview${params}`, {
    method: "POST",
  })
  return handleResponse(res)
}

export interface ArchiveResult {
  success: boolean
  archivedExecutions: number
  extractedExperiences: number
  installedSkills: number
  fileDeleted: boolean
  error?: string
}

export async function archiveWorkspace(
  workspaceId: string,
  options: {
    extractExperiences?: string[]
    installSkills?: string[]
  },
  org?: string
): Promise<ArchiveResult> {
  const params = org ? `?org=${encodeURIComponent(org)}` : ""
  const res = await apiFetch(`${getServerUrl()}/api/archive/workspaces/${workspaceId}/archive${params}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(options),
  })
  return handleResponse(res)
}

// ── Draft API ────────────────────────────────────────────────

export interface ArchiveDraft {
  workspace_id: string
  org: string
  analysis_report: AnalysisReport
  experiences: ExperienceCandidate[]
  skills: SkillCandidate[]
  stats: WorkspaceStats
  created_at: string
  updated_at: string
}

export async function getArchiveDraft(workspaceId: string): Promise<ArchiveDraft | null> {
  const res = await apiFetch(`${getServerUrl()}/api/archive/workspaces/${workspaceId}/archive-draft`, {
    credentials: "include",
  })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`Failed to load draft: ${res.status}`)
  return res.json()
}

export async function deleteArchiveDraft(workspaceId: string): Promise<void> {
  await apiFetch(`${getServerUrl()}/api/archive/workspaces/${workspaceId}/archive-draft`, {
    method: "DELETE",
    credentials: "include",
  })
}

// ── SSE Archive ──────────────────────────────────────────────

export interface StepEvent {
  step: string
  status: "running" | "progress" | "done" | "error"
  detail?: string
  data?: Record<string, unknown>
}

export function archiveWorkspaceSSE(
  workspaceId: string,
  options: {
    extractExperiences?: string[]
    installSkills?: string[]
    analysisReport?: unknown
    stats?: Record<string, unknown>
  },
  onStep: (event: StepEvent) => void,
  onLog: (message: string) => void,
  onComplete: (result: ArchiveResult) => void,
  onError: (error: Error) => void,
): AbortController {
  const abort = new AbortController()

  fetch(`${getServerUrl()}/api/archive/workspaces/${workspaceId}/archive`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(options),
    credentials: "include",
    signal: abort.signal,
  }).then(async (res) => {
    if (!res.ok || !res.body) {
      onError(new Error(`HTTP ${res.status}`))
      return
    }
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split("\n")
      buffer = lines.pop() || ""

      let currentEvent = ""
      for (const line of lines) {
        if (line.startsWith("event:")) {
          currentEvent = line.slice(6).trim()
        } else if (line.startsWith("data:")) {
          const raw = line.slice(5).trim()
          try {
            const data = JSON.parse(raw)
            if (currentEvent === "step") onStep(data as StepEvent)
            else if (currentEvent === "log") onLog(data.message)
            else if (currentEvent === "complete") onComplete(data as ArchiveResult)
            else if (currentEvent === "error") onError(new Error(data.message))
          } catch {
            // Skip malformed JSON
          }
          currentEvent = ""
        }
      }
    }
  }).catch((err) => {
    if (err.name !== "AbortError") onError(err)
  })

  return abort
}

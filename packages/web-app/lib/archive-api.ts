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
}

export interface AnalysisReport {
  summary: string
  execution_patterns: string[]
  cost_efficiency: string
  error_patterns: string[]
  recommendations: string[]
}

export interface ExperienceCandidate {
  id: string
  text: string
  scope: string
  confidence: number
  source: string
}

export interface SkillCandidate {
  name: string
  description: string
  content: string
  reason: string
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

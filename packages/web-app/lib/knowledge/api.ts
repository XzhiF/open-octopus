import { getServerUrl } from '@/lib/server-config'

// ── Helpers (mirrors lib/api-client.ts pattern) ──────────────────────

async function handleResponse(res: Response) {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error?.message ?? body.error ?? `HTTP ${res.status}`)
  }
  return res.json()
}

function apiFetch(url: string, init?: RequestInit): Promise<Response> {
  return fetch(url, { ...init, credentials: 'include' })
}

// ============ Knowledge API ============

export async function getKnowledgeFiles(scope?: string, org?: string) {
  const params = new URLSearchParams()
  if (scope) params.set('scope', scope)
  if (org) params.set('org', org)
  const qs = params.toString()
  const res = await apiFetch(`${getServerUrl()}/api/knowledge/files${qs ? `?${qs}` : ''}`)
  return handleResponse(res)
}

export async function getKnowledgeFile(filePath: string, org?: string) {
  const params = new URLSearchParams({ path: filePath })
  if (org) params.set('org', org)
  const res = await apiFetch(
    `${getServerUrl()}/api/knowledge/file?${params.toString()}`
  )
  return handleResponse(res)
}

export async function updateKnowledgeFile(filePath: string, content: string, org?: string) {
  const params = new URLSearchParams({ path: filePath })
  if (org) params.set('org', org)
  const res = await apiFetch(
    `${getServerUrl()}/api/knowledge/file?${params.toString()}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    }
  )
  return handleResponse(res)
}

export async function deleteKnowledgeFile(filePath: string, org?: string) {
  const params = new URLSearchParams({ path: filePath })
  if (org) params.set('org', org)
  const res = await apiFetch(
    `${getServerUrl()}/api/knowledge/file?${params.toString()}`,
    { method: 'DELETE' }
  )
  return handleResponse(res)
}

export async function getPreference(scope: 'global' | 'org', orgId?: string) {
  const params = new URLSearchParams({ scope })
  if (orgId) params.set('org', orgId)
  const res = await apiFetch(
    `${getServerUrl()}/api/knowledge/preference?${params.toString()}`
  )
  return handleResponse(res)
}

export async function updatePreference(
  scope: 'global' | 'org',
  content: string,
  orgId?: string
) {
  const body: Record<string, string> = { scope, content }
  if (orgId) body.org = orgId
  const res = await apiFetch(`${getServerUrl()}/api/knowledge/preference`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return handleResponse(res)
}

export async function getEffectiveness(ruleId?: string) {
  const params = ruleId ? `?ruleId=${encodeURIComponent(ruleId)}` : ''
  const res = await apiFetch(`${getServerUrl()}/api/knowledge/effectiveness${params}`)
  return handleResponse(res)
}

export async function restoreRule(ruleId: string, org?: string) {
  const params = org ? `?org=${encodeURIComponent(org)}` : ''
  const res = await apiFetch(
    `${getServerUrl()}/api/knowledge/rule/${encodeURIComponent(ruleId)}/restore${params}`,
    { method: 'POST' }
  )
  return handleResponse(res)
}

export async function compactKnowledge(org: string, filePath: string) {
  const res = await apiFetch(`${getServerUrl()}/api/knowledge/compact`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ org, filePath }),
  })
  return handleResponse(res)
}

export function createCompactStream(org: string, filePath: string): {
  reader: ReadableStreamDefaultReader<string>
  abort: () => void
} {
  const controller = new AbortController()

  const reader = new ReadableStream<string>({
    async start(ctrl) {
      try {
        const res = await fetch(`${getServerUrl()}/api/knowledge/compact-preview`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ org, filePath }),
          credentials: 'include',
          signal: controller.signal,
        })

        if (!res.ok || !res.body) {
          ctrl.error(new Error(`Stream failed: ${res.status}`))
          return
        }

        const textDecoder = new TextDecoder()
        const bodyReader = res.body.getReader()
        let currentEvent = 'message'

        while (true) {
          const { done, value } = await bodyReader.read()
          if (done) break

          const text = textDecoder.decode(value, { stream: true })
          const lines = text.split('\n')
          for (const line of lines) {
            if (line.startsWith('event: ')) {
              currentEvent = line.slice(7).trim()
            } else if (line.startsWith('data: ')) {
              // Combine event type with data for the consumer
              ctrl.enqueue(JSON.stringify({ event: currentEvent, data: JSON.parse(line.slice(6)) }))
              currentEvent = 'message'
            }
          }
        }
        ctrl.close()
      } catch (err) {
        if ((err as Error).name !== 'AbortError') ctrl.error(err)
      }
    },
  }).getReader()

  return { reader, abort: () => controller.abort() }
}

export async function generateKnowledge(
  org: string,
  type: 'project' | 'workflow',
  name: string
): Promise<{ content: string; suggestedPath: string }> {
  const res = await apiFetch(`${getServerUrl()}/api/knowledge/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ org, type, name }),
  })
  return handleResponse(res)
}

export async function getAvailableWorkflows(): Promise<{ workflows: string[] }> {
  const res = await apiFetch(`${getServerUrl()}/api/knowledge/workflows`)
  return handleResponse(res)
}

// ============ Review API ============

export async function getPendingReviews(params?: {
  type?: string
  status?: string
  page?: number
  pageSize?: number
}) {
  const searchParams = new URLSearchParams()
  if (params?.type) searchParams.set('type', params.type)
  if (params?.status) searchParams.set('status', params.status)
  if (params?.page) searchParams.set('page', String(params.page))
  if (params?.pageSize) searchParams.set('pageSize', String(params.pageSize))
  const qs = searchParams.toString()
  const res = await apiFetch(
    `${getServerUrl()}/api/review/pending${qs ? `?${qs}` : ''}`
  )
  return handleResponse(res)
}

export async function reviewAction(
  id: string,
  action: string,
  content?: string,
  userNotes?: string
) {
  const res = await apiFetch(`${getServerUrl()}/api/review/${encodeURIComponent(id)}/action`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, content, userNotes }),
  })
  return handleResponse(res)
}

export async function batchReview(ids: string[], action: 'approve' | 'reject') {
  const res = await apiFetch(`${getServerUrl()}/api/review/batch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids, action }),
  })
  return handleResponse(res)
}

export async function getReviewSummary() {
  const res = await apiFetch(`${getServerUrl()}/api/review/summary`)
  return handleResponse(res)
}

// ============ Archive API ============

export async function getArchiveSummary(executionId: string) {
  const res = await apiFetch(
    `${getServerUrl()}/api/archive/${encodeURIComponent(executionId)}/summary`
  )
  return handleResponse(res)
}

export async function proposeArchive(
  executionId: string,
  org: string,
  skipSkillProposal?: boolean
) {
  const res = await apiFetch(
    `${getServerUrl()}/api/archive/${encodeURIComponent(executionId)}/propose`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ org, skipSkillProposal }),
    }
  )
  return handleResponse(res)
}

// ============ SSE Stream ============

export function createAssistantStream(params: {
  mode: 'review' | 'archive' | 'chat'
  ruleContent?: string
  skillContent?: string
  userPreference?: string
  executionContext?: string
}): { reader: ReadableStreamDefaultReader<string>; abort: () => void } {
  const controller = new AbortController()
  const searchParams = new URLSearchParams()
  searchParams.set('mode', params.mode)
  if (params.ruleContent) searchParams.set('ruleContent', params.ruleContent)
  if (params.skillContent) searchParams.set('skillContent', params.skillContent)
  if (params.userPreference) searchParams.set('userPreference', params.userPreference)
  if (params.executionContext) searchParams.set('executionContext', params.executionContext)

  const url = `${getServerUrl()}/api/review/assistant/stream?${searchParams}`
  const fetchPromise = fetch(url, { signal: controller.signal, credentials: 'include' })

  const reader = new ReadableStream<string>({
    async start(ctrl) {
      try {
        const res = await fetchPromise
        if (!res.ok || !res.body) {
          ctrl.error(new Error(`Stream failed: ${res.status}`))
          return
        }
        const textDecoder = new TextDecoder()
        const bodyReader = res.body.getReader()
        while (true) {
          const { done, value } = await bodyReader.read()
          if (done) break
          // Parse SSE format: "data: {...}\n\n"
          const text = textDecoder.decode(value, { stream: true })
          const lines = text.split('\n')
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              ctrl.enqueue(line.slice(6))
            }
          }
        }
        ctrl.close()
      } catch (err) {
        if ((err as Error).name !== 'AbortError') ctrl.error(err)
      }
    },
  }).getReader()

  return { reader, abort: () => controller.abort() }
}

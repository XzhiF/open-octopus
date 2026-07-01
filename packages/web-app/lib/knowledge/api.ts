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

export async function getKnowledgeFiles(scope?: string) {
  const params = scope ? `?scope=${encodeURIComponent(scope)}` : ''
  const res = await apiFetch(`${getServerUrl()}/api/knowledge/files${params}`)
  return handleResponse(res)
}

export async function getKnowledgeFile(path: string) {
  const res = await apiFetch(
    `${getServerUrl()}/api/knowledge/file/${encodeURIComponent(path)}`
  )
  return handleResponse(res)
}

export async function updateKnowledgeFile(path: string, content: string) {
  const res = await apiFetch(
    `${getServerUrl()}/api/knowledge/file/${encodeURIComponent(path)}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    }
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

export async function restoreRule(ruleId: string) {
  const res = await apiFetch(
    `${getServerUrl()}/api/knowledge/rule/${encodeURIComponent(ruleId)}/restore`,
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

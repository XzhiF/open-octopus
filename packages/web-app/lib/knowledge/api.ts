import { getServerUrl } from '@/lib/server-config'
import { apiFetch, handleResponse } from '@/lib/api-client'

// ============ 知识 API（票09 收口后余量）============
// 旧世界 CRUD 面（知识文件 files/file、偏好 get/update、effectiveness restore、
// compact 流、generate、workflows 列表、审核队列 pending/action/summary）已随
// /wiki、/experience 页面与 org knowledge 库物理删除——本模块只剩 workspace 归档流
// 共享件（ArchiveDialog/助手面板，红线保留）消费的四函数。
// 知识中心读面在 knowledge-center-api.ts（数据钉 global）；wiki-api.ts 随 /wiki 页删除。

export async function batchReview(ids: string[], action: 'approve' | 'reject', org?: string) {
  const res = await apiFetch(`${getServerUrl()}/api/review/batch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids, action, org }),
  })
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
) {
  const res = await apiFetch(
    `${getServerUrl()}/api/archive/${encodeURIComponent(executionId)}/propose`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ org }),
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

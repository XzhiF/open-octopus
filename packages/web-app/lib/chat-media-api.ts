'use client'

// 会话级文档接口（2026-11-26 桌面文档窗）：
//   GET /api/chat-media/:sessionId/doc?path=   文本回内容、媒体只回 kind
//   GET /api/chat-media/:sessionId/raw?path=   图片 / 视频 / 音频字节流（支持 Range）
// 与全舱的 /api/cabins/:id/doc 同一套返回形状，白名单改按会话解析。

import { getServerUrl } from '@/lib/server-config'

export type ChatDocKind = 'text' | 'image' | 'video' | 'audio' | 'binary'

export interface ChatDocResult {
  /** 解析后的绝对路径（与请求一致）。 */
  path: string
  ext: string
  size: number
  kind: ChatDocKind
  /** kind=text 才有 */
  content?: string
  /** 媒体类的 MIME */
  mime?: string
}

function docUrl(sessionId: string, absPath: string, route: 'doc' | 'raw'): string {
  return `${getServerUrl()}/api/chat-media/${encodeURIComponent(sessionId)}/${route}`
    + `?path=${encodeURIComponent(absPath)}`
}

export async function getChatDoc(sessionId: string, absPath: string): Promise<ChatDocResult> {
  const res = await fetch(docUrl(sessionId, absPath, 'doc'))
  if (!res.ok) {
    let message = `读取文档失败（${res.status}）`
    try {
      const body = await res.json() as { error?: string }
      if (body.error) message = body.error
    } catch { /* 非 JSON 错误体，保留状态码文案 */ }
    throw new Error(message)
  }
  return res.json() as Promise<ChatDocResult>
}

/** 媒体字节流地址（<img src> / <video src> 直连）。 */
export function chatDocRawUrl(sessionId: string, absPath: string): string {
  return docUrl(sessionId, absPath, 'raw')
}

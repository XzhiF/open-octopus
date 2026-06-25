import { getServerUrl } from "@/lib/server-config"

export function createChatConnection(workspaceId: string, sessionId: string): WebSocket {
  const serverUrl = getServerUrl()
  const protocol = serverUrl.startsWith("https") ? "wss" : "ws"
  const host = serverUrl.replace(/^https?:\/\//, "")
  const url = `${protocol}://${host}/api/workspaces/${workspaceId}/chat/sessions/${sessionId}/stream`
  return new WebSocket(url)
}

export interface WSChatMessage {
  role: "user" | "assistant"
  content: string
}

export function onChatMessage(ws: WebSocket, handler: (msg: WSChatMessage) => void): void {
  ws.onmessage = (e) => {
    try {
      const parsed = JSON.parse(e.data as string)
      handler(parsed)
    } catch {
      handler({ role: "assistant", content: e.data as string })
    }
  }
}

export function sendChatMessage(ws: WebSocket, message: WSChatMessage): void {
  ws.send(JSON.stringify(message))
}
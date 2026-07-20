// ── Types ──────────────────────────────────────────────────────────

export interface SyncResult {
  success: boolean
  syncedAt: string
  chatbotUrl?: string
}

// ── ChatbotSyncService ─────────────────────────────────────────────

/**
 * Sync discussion results and proposals to the chatbot knowledge base.
 *
 * ponytail: placeholder HTTP POST — wire to real chatbot API when available.
 * The endpoint is configurable via constructor or CHATBOT_API_URL env var.
 */
export class ChatbotSyncService {
  private endpoint: string

  constructor(endpoint?: string) {
    this.endpoint = endpoint
      ?? process.env.CHATBOT_API_URL
      ?? 'http://localhost:3001/api/chatbot/sync'
  }

  /**
   * Sync a discussion result + proposal to the chatbot.
   * Retries 3 times on failure.
   */
  async syncToChatbot(
    discussionId: string,
    proposal: string,
    attempt = 1,
    maxAttempts = 3,
  ): Promise<SyncResult> {
    try {
      const res = await fetch(this.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ discussionId, proposal }),
      })

      if (!res.ok) {
        throw new Error(`Chatbot API returned ${res.status}`)
      }

      const data = await res.json() as { chatbotUrl?: string }

      return {
        success: true,
        syncedAt: new Date().toISOString(),
        chatbotUrl: data.chatbotUrl,
      }
    } catch (err: any) {
      if (attempt < maxAttempts) {
        // Exponential backoff: 100ms, 200ms
        await new Promise(r => setTimeout(r, 100 * attempt))
        return this.syncToChatbot(discussionId, proposal, attempt + 1, maxAttempts)
      }
      return {
        success: false,
        syncedAt: new Date().toISOString(),
      }
    }
  }
}

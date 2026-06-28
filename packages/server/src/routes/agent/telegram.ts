// packages/server/src/routes/agent/telegram.ts
import { Hono } from "hono"

interface TelegramConfig {
  botToken: string
  secretToken: string
}

export function createTelegramRoutes(config: {
  getConfig: () => TelegramConfig | null
  handler: { handleMessage: (chatId: number, text: string, from: { id: number; first_name: string; username?: string }) => Promise<string> }
}) {
  const app = new Hono()

  app.post("/webhook", async (c) => {
    const cfg = config.getConfig()
    if (!cfg) {
      console.warn("[telegram] Not configured")
      return c.json({ error: "Telegram integration not configured" }, 503)
    }

    // Verify secret token
    const secretHeader = c.req.header("X-Telegram-Bot-Api-Token")
    const body = await c.req.json()

    // Check secret from header or body
    const secret = secretHeader || body?.secret_token
    if (secret !== cfg.secretToken) {
      return c.json({ error: "Unauthorized" }, 401)
    }

    // Extract message
    const message = body?.message
    if (!message?.text || !message?.chat?.id) {
      return c.json({ error: "Invalid payload" }, 400)
    }

    // Process asynchronously (202 pattern)
    const chatId = message.chat.id
    const text = message.text
    const from = {
      id: message.from?.id ?? 0,
      first_name: message.from?.first_name ?? "Unknown",
      username: message.from?.username,
    }

    // Don't await — respond immediately with 200
    config.handler.handleMessage(chatId, text, from).catch(err => {
      console.warn(`[telegram] Message handling failed for chat ${chatId}:`, err)
    })

    return c.json({ ok: true }, 200)
  })

  return app
}

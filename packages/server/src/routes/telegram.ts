// packages/server/src/routes/telegram.ts
// Telegram webhook route — receives Telegram Bot API updates.

import { Hono } from "hono"
import type { TelegramBotService } from "../services/telegram-bot"

let botService: TelegramBotService | undefined

export function setTelegramBotService(svc: TelegramBotService): void {
  botService = svc
}

const telegramRoutes = new Hono()

telegramRoutes.post("/webhook", async (c) => {
  // Verify secret token (if configured)
  const expectedToken = process.env.TELEGRAM_BOT_SECRET_TOKEN
  const actualToken = c.req.header("X-Telegram-Bot-Api-Secret-Token")
  if (expectedToken && actualToken !== expectedToken) {
    return c.json({ error: "Invalid secret token" }, 401)
  }

  if (!botService) {
    return c.json({ error: "Telegram bot not configured" }, 503)
  }

  try {
    const update = await c.req.json()
    const result = await botService.processUpdate(update)

    if (!result.text) {
      return c.json({ ok: true })
    }

    // Respond with sendMessage payload for Telegram Bot API
    const chatId = update?.message?.chat?.id
    if (!chatId) {
      return c.json({ ok: true })
    }

    return c.json({
      method: "sendMessage",
      chat_id: chatId,
      text: result.text,
      parse_mode: result.parse_mode ?? "Markdown",
    })
  } catch (err) {
    console.error("[telegram] Webhook error:", err)
    return c.json({ error: "Webhook processing failed" }, 500)
  }
})

export default telegramRoutes

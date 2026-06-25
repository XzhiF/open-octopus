import { Hono } from "hono"
import { parseCronExpression, naturalLanguageToCron } from "../services/cron-utils"

const cronRoutes = new Hono()

cronRoutes.post("/parse", async (c) => {
  let body: Record<string, unknown>
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: "Invalid or missing JSON body" }, 400)
  }
  const { expression, timezone } = body as { expression?: string; timezone?: string }
  if (!expression || !timezone) {
    return c.json({ error: "expression and timezone are required" }, 400)
  }
  const result = parseCronExpression(expression, timezone)
  return c.json(result)
})

cronRoutes.post("/natural-language", async (c) => {
  let body: Record<string, unknown>
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: "Invalid or missing JSON body" }, 400)
  }
  const text = (body.text ?? body.input) as string | undefined
  if (!text) {
    return c.json({ error: "text or input is required" }, 400)
  }
  const result = naturalLanguageToCron(text)
  return c.json(result)
})

export default cronRoutes

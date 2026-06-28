// packages/server/src/services/agent/telegram-commands.ts

export interface ParsedCommand {
  command: "scan" | "develop" | "status" | "report" | "experience" | "register" | "stop" | "unknown"
  args: Record<string, string>
  rawText: string
}

export function parseTelegramCommand(text: string): ParsedCommand {
  const trimmed = text.trim()

  // Check for slash commands
  const slashMatch = trimmed.match(/^\/(\w+)\s*(.*)?$/i)

  // Also support natural language commands
  const lower = trimmed.toLowerCase()

  // Scan: "扫描 engine" or "/scan engine"
  if (slashMatch?.[1] === "scan" || lower.startsWith("扫描")) {
    const scope = slashMatch ? (slashMatch[2]?.trim() || "") : trimmed.replace(/^扫描\s*/i, "").trim()
    return { command: "scan", args: { scope }, rawText: trimmed }
  }

  // Develop: "开发 xxx" or "/develop xxx"
  if (slashMatch?.[1] === "develop" || lower.startsWith("开发")) {
    const desc = slashMatch ? (slashMatch[2]?.trim() || "") : trimmed.replace(/^开发\s*/i, "").trim()
    return { command: "develop", args: { description: desc }, rawText: trimmed }
  }

  // Status: "状态" or "/status"
  if (slashMatch?.[1] === "status" || lower === "状态") {
    return { command: "status", args: {}, rawText: trimmed }
  }

  // Report: "报告" or "/report"
  if (slashMatch?.[1] === "report" || lower === "报告") {
    return { command: "report", args: {}, rawText: trimmed }
  }

  // Experience: "经验 xxx" or "/experience xxx"
  if (slashMatch?.[1] === "experience" || lower.startsWith("经验")) {
    const keyword = slashMatch ? (slashMatch[2]?.trim() || "") : trimmed.replace(/^经验\s*/i, "").trim()
    return { command: "experience", args: { keyword }, rawText: trimmed }
  }

  // Register: "注册 xxx cron描述" or "/register xxx cron"
  if (slashMatch?.[1] === "register" || lower.startsWith("注册")) {
    const rest = slashMatch ? (slashMatch[2]?.trim() || "") : trimmed.replace(/^注册\s*/i, "").trim()
    const parts = rest.split(/\s+/, 2)
    return { command: "register", args: { workflow: parts[0] || "", cron: parts[1] || "" }, rawText: trimmed }
  }

  // Stop: "停止 xxx" or "/stop xxx"
  if (slashMatch?.[1] === "stop" || lower.startsWith("停止")) {
    const executionId = slashMatch ? (slashMatch[2]?.trim() || "") : trimmed.replace(/^停止\s*/i, "").trim()
    return { command: "stop", args: { executionId }, rawText: trimmed }
  }

  return { command: "unknown", args: {}, rawText: trimmed }
}

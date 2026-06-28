// packages/server/src/services/agent/telegram-command-parser.ts
// Parses incoming Telegram message text into structured commands.

export type TelegramCommand =
  | { type: "scan"; scope: string }
  | { type: "develop"; description: string }
  | { type: "status" }
  | { type: "report" }
  | { type: "experience"; query: string }
  | { type: "register"; workflow: string; cronDesc: string }
  | { type: "stop"; executionId?: string }
  | { type: "unknown"; text: string }

export class TelegramCommandParser {
  static parse(text: string): TelegramCommand {
    const trimmed = text.trim()
    if (!trimmed) return { type: "unknown", text: "" }

    // Remove leading / or emoji prefixes
    const cleaned = trimmed.replace(/^[/\u{1F50D}\u{1F4CA}\u{1F4DD}\u{23F0}\u{1F6D1}]?\s*/u, "").trim()

    if (cleaned.startsWith("扫描") || cleaned.toLowerCase().startsWith("scan")) {
      const scope = cleaned.replace(/^(扫描|scan)\s*/i, "").trim()
      return { type: "scan", scope: scope || "all" }
    }

    if (cleaned.startsWith("开发") || cleaned.toLowerCase().startsWith("develop")) {
      const desc = cleaned.replace(/^(开发|develop)\s*/i, "").trim()
      return { type: "develop", description: desc || "未指定" }
    }

    if (/^(状态|status)$/i.test(cleaned)) {
      return { type: "status" }
    }

    if (/^(报告|report)$/i.test(cleaned)) {
      return { type: "report" }
    }

    if (cleaned.startsWith("经验") || cleaned.toLowerCase().startsWith("experience")) {
      const query = cleaned.replace(/^(经验|experience)\s*/i, "").trim()
      return { type: "experience", query: query || "" }
    }

    if (cleaned.startsWith("注册") || cleaned.toLowerCase().startsWith("register")) {
      const rest = cleaned.replace(/^(注册|register)\s*/i, "").trim()
      const parts = rest.split(/\s+/)
      return { type: "register", workflow: parts[0] || "", cronDesc: parts.slice(1).join(" ") || "" }
    }

    if (cleaned.startsWith("停止") || cleaned.toLowerCase().startsWith("stop")) {
      const id = cleaned.replace(/^(停止|stop)\s*/i, "").trim()
      return { type: "stop", executionId: id || undefined }
    }

    return { type: "unknown", text: trimmed }
  }
}

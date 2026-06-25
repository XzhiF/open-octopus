import fs from "fs"
import path from "path"
import os from "os"

const LOG_DIR = path.join(os.homedir(), ".octopus", "logs")
const MAX_LOG_SIZE = 10 * 1024 * 1024 // 10MB per file
const MAX_LOG_FILES = 5

function getLogFileName(): string {
  const branch = process.env.OCTOPUS_BRANCH ?? "main"
  const safe = branch.replace(/\//g, "-").replace(/[^a-zA-Z0-9\-_.]/g, "_")
  return `server-${safe}.log`
}

function getLogPath(): string {
  return path.join(LOG_DIR, getLogFileName())
}

function ensureLogDir(): void {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true })
  }
}

function rotateIfNeeded(logPath: string): void {
  if (!fs.existsSync(logPath)) return
  const stat = fs.statSync(logPath)
  if (stat.size < MAX_LOG_SIZE) return

  // Rotate: server-main.log → server-main.1.log → server-main.2.log ...
  for (let i = MAX_LOG_FILES - 1; i >= 1; i--) {
    const older = logPath.replace(/\.log$/, `.${i}.log`)
    const newer = i === 1 ? logPath : logPath.replace(/\.log$/, `.${i - 1}.log`)
    if (fs.existsSync(newer)) {
      fs.copyFileSync(newer, older)
    }
  }
  // Truncate current
  fs.writeFileSync(logPath, "", "utf-8")
}

let stream: fs.WriteStream | null = null

function getStream(): fs.WriteStream {
  if (stream) return stream
  ensureLogDir()
  const logPath = getLogPath()
  rotateIfNeeded(logPath)
  stream = fs.createWriteStream(logPath, { flags: "a" })
  return stream
}

function formatMessage(level: string, msg: string, meta?: Record<string, unknown>): string {
  const ts = new Date().toISOString()
  const metaStr = meta ? ` ${JSON.stringify(meta)}` : ""
  return `[${ts}] [${level}] ${msg}${metaStr}\n`
}

export function logInfo(msg: string, meta?: Record<string, unknown>): void {
  try { getStream().write(formatMessage("INFO", msg, meta)) } catch {}
}

export function logError(msg: string, err?: unknown, meta?: Record<string, unknown>): void {
  const errorDetail = err instanceof Error
    ? { message: err.message, stack: err.stack }
    : err ? { detail: String(err) } : undefined
  try { getStream().write(formatMessage("ERROR", msg, { ...meta, ...errorDetail })) } catch {}
}

export function logWarn(msg: string, meta?: Record<string, unknown>): void {
  try { getStream().write(formatMessage("WARN", msg, meta)) } catch {}
}

/** Get the current log file path (for debugging) */
export function getLogFilePath(): string {
  return getLogPath()
}

/** Install global uncaughtException / unhandledRejection handlers that write to log file */
export function installGlobalErrorHandlers(): void {
  process.on("uncaughtException", (err) => {
    logError("Uncaught Exception", err)
    console.error("[FATAL] Uncaught Exception:", err)
  })

  process.on("unhandledRejection", (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason))
    logError("Unhandled Rejection", err)
    console.error("[FATAL] Unhandled Rejection:", err)
  })
}

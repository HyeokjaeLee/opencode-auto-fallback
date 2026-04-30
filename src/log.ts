import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { homedir } from "node:os"

const LOG_DIR = join(
  process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"),
  "opencode",
  "log"
)
const LOG_FILE = join(LOG_DIR, "fallback.log")
const MAX_LINES = 500

type Level = "INFO" | "WARN" | "ERROR"

const NOISY_EVENT_TYPES = new Set([
  "message.part.delta",
  "message.part.updated",
  "message.updated",
  "session.status",
  "session.idle",
  "session.updated",
])

let dirPromise: Promise<void> | null = null

function ensureDir(): Promise<void> {
  if (!dirPromise) {
    dirPromise = mkdir(LOG_DIR, { recursive: true }).then(
      () => {},
      () => {},
    )
  }
  return dirPromise
}

async function trimLogFile(): Promise<void> {
  try {
    const content = await readFile(LOG_FILE, "utf-8")
    const lines = content.split("\n").filter(Boolean)
    if (lines.length <= MAX_LINES) return
    const trimmed = lines.slice(-MAX_LINES).join("\n") + "\n"
    await writeFile(LOG_FILE, trimmed, "utf-8")
  } catch {}
}

function getEventType(extra?: Record<string, unknown>): string | undefined {
  const directType = extra?.type
  if (typeof directType === "string") return directType

  const event = extra?.event
  if (event && typeof event === "object" && "type" in event) {
    const eventType = event.type
    if (typeof eventType === "string") return eventType
  }

  return undefined
}

export function shouldWriteLog(message: string, extra?: Record<string, unknown>): boolean {
  const normalizedMessage = message.trim().toLowerCase()
  if (normalizedMessage !== "event received") return true

  const eventType = getEventType(extra)
  return eventType === undefined || !NOISY_EVENT_TYPES.has(eventType)
}

export async function log(
  level: Level,
  message: string,
  extra?: Record<string, unknown>
): Promise<void> {
  if (!shouldWriteLog(message, extra)) return

  await ensureDir()
  const timestamp = new Date().toISOString()
  const extraStr = extra ? " " + JSON.stringify(extra) : ""
  const line = `${timestamp} [${level}] ${message}${extraStr}\n`
  await appendFile(LOG_FILE, line).catch(() => {})
  await trimLogFile()
}

export function createLogger(enabled: boolean) {
  return {
    info: (message: string, extra?: Record<string, unknown>) =>
      enabled ? log("INFO", message, extra) : Promise.resolve(),
    warn: (message: string, extra?: Record<string, unknown>) =>
      enabled ? log("WARN", message, extra) : Promise.resolve(),
    error: (message: string, extra?: Record<string, unknown>) =>
      enabled ? log("ERROR", message, extra) : Promise.resolve(),
  }
}

import { appendFile, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { homedir } from "node:os"

const LOG_DIR = join(
  process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
  "opencode"
)
const LOG_FILE = join(LOG_DIR, "fallback.log")

type Level = "INFO" | "WARN" | "ERROR"

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

export async function log(
  level: Level,
  message: string,
  extra?: Record<string, unknown>
): Promise<void> {
  await ensureDir()
  const timestamp = new Date().toISOString()
  const extraStr = extra ? " " + JSON.stringify(extra) : ""
  const line = `${timestamp} [${level}] ${message}${extraStr}\n`
  await appendFile(LOG_FILE, line).catch(() => {})
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

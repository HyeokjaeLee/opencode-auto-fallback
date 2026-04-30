import { spawn } from "node:child_process"
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const REGISTRY_URL = "https://registry.npmjs.org/opencode-auto-fallback/latest"
const PACKAGE_NAME = "opencode-auto-fallback"
const STATE_FILE = join(
  process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"),
  "opencode",
  "log",
  "fallback-update-state.json"
)

export interface UpdateInfo {
  current: string
  latest: string
  hasUpdate: boolean
}

function getLastNotifiedVersion(): string | null {
  try {
    if (!existsSync(STATE_FILE)) return null
    return (JSON.parse(readFileSync(STATE_FILE, "utf-8")) as { lastNotified?: string }).lastNotified ?? null
  } catch {
    return null
  }
}

export function saveNotifiedVersion(version: string): void {
  try {
    const dir = join(STATE_FILE, "..")
    mkdirSync(dir, { recursive: true })
    writeFileSync(STATE_FILE, JSON.stringify({ lastNotified: version }), "utf-8")
  } catch {}
}

export async function checkForUpdates(currentVersion: string): Promise<UpdateInfo> {
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 5000)

    const response = await fetch(REGISTRY_URL, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    })
    clearTimeout(timeout)

    if (!response.ok) {
      return { current: currentVersion, latest: currentVersion, hasUpdate: false }
    }

    const data = (await response.json()) as { version?: string }
    const latest = data.version ?? currentVersion

    return {
      current: currentVersion,
      latest,
      hasUpdate: latest !== currentVersion && latest !== getLastNotifiedVersion(),
    }
  } catch {
    return { current: currentVersion, latest: currentVersion, hasUpdate: false }
  }
}

function findInstallDirs(): string[] {
  const candidates = [
    join(homedir(), ".cache", "opencode", "packages"),
    join(homedir(), ".config", "opencode"),
  ]
  const dirs: string[] = []
  for (const dir of candidates) {
    if (existsSync(join(dir, "node_modules", PACKAGE_NAME))) {
      dirs.push(dir)
    }
  }
  return dirs
}

function detectPackageManager(dir: string): { bin: string; args: string[] } {
  if (existsSync(join(dir, "bun.lock"))) return { bin: "bun", args: ["add", `${PACKAGE_NAME}@latest`] }
  return { bin: "npm", args: ["install", `${PACKAGE_NAME}@latest`] }
}

export function tryInstallUpdate(): Promise<boolean> {
  return new Promise((resolve) => {
    const dirs = findInstallDirs()
    if (dirs.length === 0) {
      resolve(false)
      return
    }

    let remaining = dirs.length
    let anySuccess = false

    for (const installDir of dirs) {
      const { bin, args } = detectPackageManager(installDir)
      const proc = spawn(bin, args, {
        cwd: installDir,
        stdio: "ignore",
        timeout: 30_000,
      })

      proc.on("close", (code) => {
        if (code === 0) anySuccess = true
        remaining--
        if (remaining === 0) resolve(anySuccess)
      })

      proc.on("error", () => {
        remaining--
        if (remaining === 0) resolve(anySuccess)
      })
    }
  })
}

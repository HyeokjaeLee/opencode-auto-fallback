import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const REGISTRY_URL = "https://registry.npmjs.org/opencode-auto-fallback/latest"
const PACKAGE_NAME = "opencode-auto-fallback"

export interface UpdateInfo {
  current: string
  latest: string
  hasUpdate: boolean
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
      hasUpdate: latest !== currentVersion,
    }
  } catch {
    return { current: currentVersion, latest: currentVersion, hasUpdate: false }
  }
}

function findInstallDir(): string | null {
  const candidates = [
    join(homedir(), ".bun", "install", "global"),
    join(homedir(), ".cache", "opencode", "packages"),
    join(homedir(), ".config", "opencode"),
  ]
  for (const dir of candidates) {
    if (existsSync(join(dir, "node_modules", PACKAGE_NAME))) {
      return dir
    }
  }
  return null
}

function detectPackageManager(dir: string): { bin: string; args: string[] } {
  if (existsSync(join(dir, "bun.lock"))) return { bin: "bun", args: ["update", PACKAGE_NAME] }
  return { bin: "npm", args: ["update", PACKAGE_NAME] }
}

export function tryInstallUpdate(): Promise<boolean> {
  return new Promise((resolve) => {
    const installDir = findInstallDir()
    if (!installDir) {
      resolve(false)
      return
    }

    const { bin, args } = detectPackageManager(installDir)

    const proc = spawn(bin, args, {
      cwd: installDir,
      stdio: "ignore",
      timeout: 30_000,
    })

    proc.on("close", (code) => {
      resolve(code === 0)
    })

    proc.on("error", () => {
      resolve(false)
    })
  })
}

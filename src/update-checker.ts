import { spawn } from "node:child_process"
import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const REGISTRY_URL = "https://registry.npmjs.org/opencode-auto-fallback/latest"
const PACKAGE_NAME = "opencode-auto-fallback"
const CACHE_PACKAGES_DIR = join(
  process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"),
  "opencode",
  "packages",
)

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

/**
 * Find opencode's per-package isolated directory:
 * ~/.cache/opencode/packages/opencode-auto-fallback@latest/
 */
function findIsolatedPackageDir(): string | null {
  const dir = join(CACHE_PACKAGES_DIR, `${PACKAGE_NAME}@latest`)
  if (existsSync(join(dir, "package.json"))) return dir
  return null
}

/**
 * Invalidate the cached package so bun resolves fresh:
 * 1. Remove node_modules/{package}/
 * 2. Remove lockfile (package-lock.json or bun.lock)
 */
function invalidatePackage(workspaceDir: string): void {
  const pkgDir = join(workspaceDir, "node_modules", PACKAGE_NAME)
  if (existsSync(pkgDir)) {
    rmSync(pkgDir, { recursive: true, force: true })
  }

  const lockfiles = ["package-lock.json", "bun.lock", "bun.lockb"]
  for (const lock of lockfiles) {
    const lockPath = join(workspaceDir, lock)
    if (existsSync(lockPath)) {
      rmSync(lockPath, { force: true })
    }
  }
}

function readInstalledPackageVersion(workspaceDir: string): string | null {
  const pkgJsonPath = join(workspaceDir, "node_modules", PACKAGE_NAME, "package.json")
  if (!existsSync(pkgJsonPath)) return null

  try {
    const content = JSON.parse(readFileSync(pkgJsonPath, "utf-8")) as { version?: unknown }
    return typeof content.version === "string" ? content.version : null
  } catch {
    return null
  }
}

/**
 * Sync the workspace package.json to use "latest" so bun resolves the newest version.
 */
function syncPackageJson(workspaceDir: string): void {
  const pkgJsonPath = join(workspaceDir, "package.json")
  const content = JSON.parse(readFileSync(pkgJsonPath, "utf-8")) as { dependencies: Record<string, string> }
  content.dependencies[PACKAGE_NAME] = "latest"
  writeFileSync(pkgJsonPath, JSON.stringify(content, null, 2) + "\n", "utf-8")
}

export function tryInstallUpdate(expectedVersion: string): Promise<boolean> {
  return new Promise((resolve) => {
    const workspaceDir = findIsolatedPackageDir()
    if (!workspaceDir) {
      resolve(false)
      return
    }

    syncPackageJson(workspaceDir)
    const hasBunLock = existsSync(join(workspaceDir, "bun.lock")) || existsSync(join(workspaceDir, "bun.lockb"))
    const hasNpmLock = existsSync(join(workspaceDir, "package-lock.json"))

    if (!hasBunLock && !hasNpmLock) {
      invalidatePackage(workspaceDir)
    }

    const bin = hasBunLock || !hasNpmLock ? "bun" : "npm"
    const args = bin === "bun"
      ? hasBunLock ? ["update", PACKAGE_NAME] : ["install"]
      : ["install", `${PACKAGE_NAME}@latest`]

    const proc = spawn(bin, args, {
      cwd: workspaceDir,
      stdio: "ignore",
      timeout: 60_000,
    })

    proc.on("close", (code) => {
      resolve(code === 0 && readInstalledPackageVersion(workspaceDir) === expectedVersion)
    })

    proc.on("error", () => {
      resolve(false)
    })
  })
}

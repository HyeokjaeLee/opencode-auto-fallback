const REGISTRY_URL = "https://registry.npmjs.org/opencode-auto-fallback/latest"

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

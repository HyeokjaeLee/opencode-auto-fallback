const brokenProviders = new Set<string>()

export function markProviderBroken(providerID: string): void {
  brokenProviders.add(providerID)
}

export function isProviderBroken(providerID: string): boolean {
  return brokenProviders.has(providerID)
}

export function clearBrokenProviders(): void {
  brokenProviders.clear()
}

export function clearBrokenProvider(providerID: string): void {
  brokenProviders.delete(providerID)
}

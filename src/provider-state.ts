const brokenModels = new Set<string>()

function modelKey(providerID: string, modelID: string): string {
  return `${providerID}/${modelID}`
}

export function markModelBroken(providerID: string, modelID: string): void {
  brokenModels.add(modelKey(providerID, modelID))
}

export function isModelBroken(providerID: string, modelID: string): boolean {
  return brokenModels.has(modelKey(providerID, modelID))
}

export function clearBrokenModels(): void {
  brokenModels.clear()
}

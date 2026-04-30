import type { FallbackModel } from "../types"

type LargeContextPhase = "active" | "summarizing"

const activeFallbackParams = new Map<string, FallbackModel>()
const largeContextSessions = new Map<string, { providerID: string; modelID: string }>()
const currentModelSessions = new Map<string, { providerID: string; modelID: string }>()
const sessionCooldownModel = new Map<string, { providerID: string; modelID: string }>()
const largeContextPhase = new Map<string, LargeContextPhase>()
const modelContextLimits = new Map<string, number>()
const sessionOriginalAgent = new Map<string, string>()

export function setActiveFallbackParams(sessionID: string, model: FallbackModel): void {
  activeFallbackParams.set(sessionID, model)
}

export function getAndClearFallbackParams(sessionID: string): FallbackModel | undefined {
  const params = activeFallbackParams.get(sessionID)
  activeFallbackParams.delete(sessionID)
  return params
}

export function clearActiveFallbackParams(sessionID: string): void {
  activeFallbackParams.delete(sessionID)
}

export function setCurrentModel(sessionID: string, providerID: string, modelID: string): void {
  currentModelSessions.set(sessionID, { providerID, modelID })
}

export function getCurrentModel(sessionID: string): { providerID: string; modelID: string } | undefined {
  return currentModelSessions.get(sessionID)
}

export function hasModelChanged(
  sessionID: string,
  providerID: string,
  modelID: string,
): { changed: boolean; previous: { providerID: string; modelID: string } | undefined } {
  const prev = currentModelSessions.get(sessionID)
  const changed = !prev || prev.providerID !== providerID || prev.modelID !== modelID
  return { changed, previous: prev }
}

export function getOrSetOriginalModel(sessionID: string, providerID: string, modelID: string): { providerID: string; modelID: string } {
  if (!largeContextSessions.has(sessionID)) {
    largeContextSessions.set(sessionID, { providerID, modelID })
  }
  return largeContextSessions.get(sessionID)!
}

export function getOriginalModel(sessionID: string): { providerID: string; modelID: string } | undefined {
  return largeContextSessions.get(sessionID)
}

export function setLargeContextPhase(sessionID: string, phase: LargeContextPhase): void {
  largeContextPhase.set(sessionID, phase)
}

export function getLargeContextPhase(sessionID: string): LargeContextPhase | undefined {
  return largeContextPhase.get(sessionID)
}

export function deleteLargeContextPhase(sessionID: string): void {
  largeContextPhase.delete(sessionID)
}

export function setModelContextLimit(modelKey: string, limit: number): void {
  modelContextLimits.set(modelKey, limit)
}

export function getModelContextLimit(modelKey: string): number | undefined {
  return modelContextLimits.get(modelKey)
}

export function setSessionCooldownModel(sessionID: string, providerID: string, modelID: string): void {
  sessionCooldownModel.set(sessionID, { providerID, modelID })
}

export function getSessionCooldownModel(sessionID: string): { providerID: string; modelID: string } | undefined {
  return sessionCooldownModel.get(sessionID)
}

export function deleteSessionCooldownModel(sessionID: string): void {
  sessionCooldownModel.delete(sessionID)
}

export function setSessionOriginalAgent(sessionID: string, agent: string): void {
  if (!sessionOriginalAgent.has(sessionID)) {
    sessionOriginalAgent.set(sessionID, agent)
  }
}

export function getSessionOriginalAgent(sessionID: string): string | undefined {
  return sessionOriginalAgent.get(sessionID)
}

export function cleanupSession(sessionID: string): void {
  largeContextSessions.delete(sessionID)
  currentModelSessions.delete(sessionID)
  sessionCooldownModel.delete(sessionID)
  largeContextPhase.delete(sessionID)
  activeFallbackParams.delete(sessionID)
  sessionOriginalAgent.delete(sessionID)
}



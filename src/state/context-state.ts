import type { FallbackModel, LargeContextPhase, ResolvedModel } from "../types"
import { normalizeAgentName } from "../config"

const activeFallbackParams = new Map<string, FallbackModel>()
const largeContextSessions = new Map<string, { providerID: string; modelID: string }>()
const currentModelSessions = new Map<string, { providerID: string; modelID: string }>()
const sessionCooldownModel = new Map<string, { providerID: string; modelID: string }>()
const largeContextPhase = new Map<string, LargeContextPhase>()
const modelContextLimits = new Map<string, number>()
const sessionOriginalAgent = new Map<string, string>()
const sessionRestoreModel = new Map<string, ResolvedModel>()
const registeredAgentSet = new Set<string>()

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

const modelInputLimits = new Map<string, number>()
const modelOutputLimits = new Map<string, number>()

export function setModelLimit(modelKey: string, type: "input" | "output", limit: number): void {
  if (type === "input") modelInputLimits.set(modelKey, limit)
  else modelOutputLimits.set(modelKey, limit)
}

export function getModelInputLimit(modelKey: string): number | undefined {
  return modelInputLimits.get(modelKey)
}

export function getModelOutputLimit(modelKey: string): number | undefined {
  return modelOutputLimits.get(modelKey)
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

export function setRestoreModel(sessionID: string, providerID: string, modelID: string): void {
  sessionRestoreModel.set(sessionID, { providerID, modelID })
}

export function getRestoreModel(sessionID: string): ResolvedModel | undefined {
  return sessionRestoreModel.get(sessionID)
}

export function deleteRestoreModel(sessionID: string): void {
  sessionRestoreModel.delete(sessionID)
}

export function cleanupSession(sessionID: string): void {
  largeContextSessions.delete(sessionID)
  currentModelSessions.delete(sessionID)
  sessionCooldownModel.delete(sessionID)
  largeContextPhase.delete(sessionID)
  activeFallbackParams.delete(sessionID)
  sessionOriginalAgent.delete(sessionID)
  sessionRestoreModel.delete(sessionID)
  compactionTarget.delete(sessionID)
}

export function setRegisteredAgents(agents: string[]): void {
  registeredAgentSet.clear()
  for (const agent of agents) {
    registeredAgentSet.add(agent)
  }
}

export function isRegisteredAgent(agent: string): boolean {
  return registeredAgentSet.has(normalizeAgentName(agent))
}

let compactionReserved: number | undefined = undefined

export function setCompactionReserved(v: number | undefined): void {
  compactionReserved = v
}

export function getCompactionReserved(): number | undefined {
  return compactionReserved
}

// Distinguishes manual /compact from our internal session.summarize() calls
// "large" = our self-compaction call (use large context prompt)
// "default" = user ran /compact (use default model prompt)
const compactionTarget = new Map<string, "large" | "default">()

export function setCompactionTarget(sessionID: string, target: "large" | "default"): void {
  compactionTarget.set(sessionID, target)
}

export function getAndClearCompactionTarget(sessionID: string): "large" | "default" | undefined {
  const t = compactionTarget.get(sessionID)
  compactionTarget.delete(sessionID)
  return t
}

export function clearCompactionTarget(sessionID: string): void {
  compactionTarget.delete(sessionID)
}



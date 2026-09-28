import { normalizeAgentName } from "@/config/config";
import type { FallbackModel, LargeContextPhase, ResolvedModel } from "@/config/types";

const activeFallbackParams = new Map<string, FallbackModel>();
const largeContextSessions = new Map<string, { providerID: string; modelID: string }>();
const currentModelSessions = new Map<string, { providerID: string; modelID: string }>();
const sessionCooldownModel = new Map<string, { providerID: string; modelID: string }>();
const largeContextPhase = new Map<string, LargeContextPhase>();
const modelContextLimits = new Map<string, number>();
const sessionOriginalAgent = new Map<string, string>();
const sessionRestoreModel = new Map<string, ResolvedModel>();
const registeredAgentSet = new Set<string>();

const compactionTarget = new Map<string, "large" | "default">();
const opencodeCompacting = new Set<string>();
const selfCompactionCount = new Map<string, number>();
const returnDeferred = new Set<string>();
const syntheticPromptActive = new Set<string>();
const selfCompactionInFlight = new Set<string>();
/** Sessions the plugin itself aborted — lets session.error attribute MessageAbortedError. */
const pluginAbortedSessions = new Map<string, number>();

const MAX_SELF_COMPACTION_CYCLES = 2;
/** Marks older than this are stale and no longer attributed to the plugin. */
const PLUGIN_ABORT_MARK_TTL_MS = 10_000;

export function setActiveFallbackParams(sessionID: string, model: FallbackModel): void {
  activeFallbackParams.set(sessionID, model);
}

export function getAndClearFallbackParams(sessionID: string): FallbackModel | undefined {
  const params = activeFallbackParams.get(sessionID);
  activeFallbackParams.delete(sessionID);
  return params;
}

export function clearActiveFallbackParams(sessionID: string): void {
  activeFallbackParams.delete(sessionID);
}

export function setCurrentModel(sessionID: string, providerID: string, modelID: string): void {
  currentModelSessions.set(sessionID, { providerID, modelID });
}

export function getCurrentModel(
  sessionID: string,
): { providerID: string; modelID: string } | undefined {
  return currentModelSessions.get(sessionID);
}

export function hasModelChanged(
  sessionID: string,
  providerID: string,
  modelID: string,
): { changed: boolean; previous: { providerID: string; modelID: string } | undefined } {
  const prev = currentModelSessions.get(sessionID);
  const changed = prev?.providerID !== providerID || prev.modelID !== modelID;
  return { changed, previous: prev };
}

export function getOrSetOriginalModel(
  sessionID: string,
  providerID: string,
  modelID: string,
): { providerID: string; modelID: string } {
  const existing = largeContextSessions.get(sessionID);
  if (existing) return existing;
  const value = { providerID, modelID };
  largeContextSessions.set(sessionID, value);
  return value;
}

export function getOriginalModel(
  sessionID: string,
): { providerID: string; modelID: string } | undefined {
  return largeContextSessions.get(sessionID);
}

export function setLargeContextPhase(sessionID: string, phase: LargeContextPhase): void {
  largeContextPhase.set(sessionID, phase);
}

export function getLargeContextPhase(sessionID: string): LargeContextPhase | undefined {
  return largeContextPhase.get(sessionID);
}

export function deleteLargeContextPhase(sessionID: string): void {
  largeContextPhase.delete(sessionID);
}

export function setModelContextLimit(modelKey: string, limit: number): void {
  modelContextLimits.set(modelKey, limit);
}

export function getModelContextLimit(modelKey: string): number | undefined {
  return modelContextLimits.get(modelKey);
}

const modelInputLimits = new Map<string, number>();

export function setModelInputLimit(modelKey: string, limit: number): void {
  modelInputLimits.set(modelKey, limit);
}

export function getModelInputLimit(modelKey: string): number | undefined {
  return modelInputLimits.get(modelKey);
}

export function setSessionCooldownModel(
  sessionID: string,
  providerID: string,
  modelID: string,
): void {
  sessionCooldownModel.set(sessionID, { providerID, modelID });
}

export function getSessionCooldownModel(
  sessionID: string,
): { providerID: string; modelID: string } | undefined {
  return sessionCooldownModel.get(sessionID);
}

export function deleteSessionCooldownModel(sessionID: string): void {
  sessionCooldownModel.delete(sessionID);
}

export function setSessionOriginalAgent(sessionID: string, agent: string): void {
  if (!sessionOriginalAgent.has(sessionID)) {
    sessionOriginalAgent.set(sessionID, agent);
  }
}

export function getSessionOriginalAgent(sessionID: string): string | undefined {
  return sessionOriginalAgent.get(sessionID);
}

export function setRestoreModel(sessionID: string, providerID: string, modelID: string): void {
  sessionRestoreModel.set(sessionID, { providerID, modelID });
}

export function incrementSelfCompactionCount(sessionID: string): number {
  const current = selfCompactionCount.get(sessionID) ?? 0;
  const next = current + 1;
  selfCompactionCount.set(sessionID, next);
  return next;
}

export function getSelfCompactionCount(sessionID: string): number {
  return selfCompactionCount.get(sessionID) ?? 0;
}

export function resetSelfCompactionCount(sessionID: string): void {
  selfCompactionCount.delete(sessionID);
}

export function getMaxSelfCompactionCycles(): number {
  return MAX_SELF_COMPACTION_CYCLES;
}

export function setReturnDeferred(sessionID: string): void {
  returnDeferred.add(sessionID);
}

export function isReturnDeferred(sessionID: string): boolean {
  return returnDeferred.has(sessionID);
}

export function clearReturnDeferred(sessionID: string): void {
  returnDeferred.delete(sessionID);
}

export function setSyntheticPromptActive(sessionID: string): void {
  syntheticPromptActive.add(sessionID);
}

export function isSyntheticPromptActive(sessionID: string): boolean {
  return syntheticPromptActive.has(sessionID);
}

export function clearSyntheticPromptActive(sessionID: string): void {
  syntheticPromptActive.delete(sessionID);
}

export function setSelfCompactionInFlight(sessionID: string): void {
  selfCompactionInFlight.add(sessionID);
}

export function isSelfCompactionInFlight(sessionID: string): boolean {
  return selfCompactionInFlight.has(sessionID);
}

export function clearSelfCompactionInFlight(sessionID: string): void {
  selfCompactionInFlight.delete(sessionID);
}

/** Called right before the plugin aborts a session, to attribute the resulting MessageAbortedError. */
export function markPluginAbort(sessionID: string): void {
  pluginAbortedSessions.set(sessionID, Date.now());
}

/** Single-use: consumes a fresh plugin-abort mark; returns false for absent/stale marks. */
export function consumePluginAbortMark(sessionID: string): boolean {
  const markedAt = pluginAbortedSessions.get(sessionID);
  if (markedAt === undefined) return false;
  pluginAbortedSessions.delete(sessionID);
  return Date.now() - markedAt <= PLUGIN_ABORT_MARK_TTL_MS;
}

/** Clears the mark when the abort request itself failed (no MessageAbortedError will follow). */
export function clearPluginAbortMark(sessionID: string): void {
  pluginAbortedSessions.delete(sessionID);
}

export function getRecoveryModel(sessionID: string): ResolvedModel | undefined {
  return sessionRestoreModel.get(sessionID) ?? largeContextSessions.get(sessionID);
}

export function deleteRestoreModel(sessionID: string): void {
  sessionRestoreModel.delete(sessionID);
}

export function cleanupSession(sessionID: string): void {
  largeContextSessions.delete(sessionID);
  currentModelSessions.delete(sessionID);
  sessionCooldownModel.delete(sessionID);
  largeContextPhase.delete(sessionID);
  activeFallbackParams.delete(sessionID);
  sessionOriginalAgent.delete(sessionID);
  sessionRestoreModel.delete(sessionID);
  compactionTarget.delete(sessionID);
  opencodeCompacting.delete(sessionID);
  selfCompactionCount.delete(sessionID);
  returnDeferred.delete(sessionID);
  syntheticPromptActive.delete(sessionID);
  selfCompactionInFlight.delete(sessionID);
  pluginAbortedSessions.delete(sessionID);
}

export function setRegisteredAgents(agents: string[]): void {
  registeredAgentSet.clear();
  for (const agent of agents) {
    registeredAgentSet.add(agent);
  }
}

export function isRegisteredAgent(agent: string): boolean {
  return registeredAgentSet.has(normalizeAgentName(agent));
}

const largeContextEligibleAgentSet = new Set<string>();

export function setLargeContextEligibleAgents(agents: string[]): void {
  largeContextEligibleAgentSet.clear();
  for (const agent of agents) {
    largeContextEligibleAgentSet.add(agent);
  }
}

/** True when any configured agent has an effective large-context model. */
export function hasLargeContextEligibleAgents(): boolean {
  return largeContextEligibleAgentSet.size > 0;
}

// Distinguishes manual /compact from our internal session.summarize() calls
// "large" = our self-compaction call (use large context prompt)
// "default" = user ran /compact (use default model prompt)
export function setCompactionTarget(sessionID: string, target: "large" | "default"): void {
  compactionTarget.set(sessionID, target);
}

export function getAndClearCompactionTarget(sessionID: string): "large" | "default" | undefined {
  const t = compactionTarget.get(sessionID);
  compactionTarget.delete(sessionID);
  return t;
}

export function clearCompactionTarget(sessionID: string): void {
  compactionTarget.delete(sessionID);
}

export function setOpencodeCompacting(sessionID: string): void {
  opencodeCompacting.add(sessionID);
}

export function clearOpencodeCompacting(sessionID: string): void {
  opencodeCompacting.delete(sessionID);
}

export function isOpencodeCompacting(sessionID: string): boolean {
  return opencodeCompacting.has(sessionID);
}

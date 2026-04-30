import type { SessionState } from "./types"

const sessions = new Map<string, SessionState>()

function ensureState(sessionID: string): SessionState {
  let state = sessions.get(sessionID)
  if (!state) {
    state = { fallbackActive: false, cooldownEndTime: 0, backoffLevel: 0 }
    sessions.set(sessionID, state)
  }
  return state
}

export function isCooldownActive(sessionID: string): boolean {
  const state = sessions.get(sessionID)
  return !!(state?.fallbackActive && Date.now() < state.cooldownEndTime)
}

export function activateCooldown(sessionID: string, cooldownMs: number): void {
  const state = ensureState(sessionID)
  state.fallbackActive = true
  state.cooldownEndTime = Date.now() + cooldownMs
}

export function deactivateCooldown(sessionID: string): void {
  const state = sessions.get(sessionID)
  if (state) {
    state.fallbackActive = false
  }
}

export function incrementBackoff(sessionID: string): number {
  const state = ensureState(sessionID)
  state.backoffLevel++
  return state.backoffLevel
}

export function getBackoffLevel(sessionID: string): number {
  return sessions.get(sessionID)?.backoffLevel ?? 0
}

export function resetBackoff(sessionID: string): void {
  const state = sessions.get(sessionID)
  if (state) {
    state.backoffLevel = 0
  }
}

export function resetIfExpired(sessionID: string): boolean {
  const state = sessions.get(sessionID)
  if (state?.fallbackActive && Date.now() >= state.cooldownEndTime) {
    state.fallbackActive = false
    state.backoffLevel = 0
    return true
  }
  return false
}

export function removeSession(sessionID: string): void {
  sessions.delete(sessionID)
}

import type { SessionState } from "./types"

const sessions = new Map<string, SessionState>()

export function isCooldownActive(sessionID: string): boolean {
  const state = sessions.get(sessionID)
  return !!(state?.fallbackActive && Date.now() < state.cooldownEndTime)
}

export function activateCooldown(sessionID: string, cooldownMs: number): void {
  sessions.set(sessionID, {
    fallbackActive: true,
    cooldownEndTime: Date.now() + cooldownMs,
  })
}

export function resetIfExpired(sessionID: string): boolean {
  const state = sessions.get(sessionID)
  if (state?.fallbackActive && Date.now() >= state.cooldownEndTime) {
    state.fallbackActive = false
    return true
  }
  return false
}

export function removeSession(sessionID: string): void {
  sessions.delete(sessionID)
}

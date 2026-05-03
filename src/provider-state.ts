import { formatModelKey } from "./utils/model";

const cooldownExpiry = new Map<string, number>();

function modelKey(providerID: string, modelID: string): string {
  return formatModelKey({ providerID, modelID });
}

export function markModelCooldown(providerID: string, modelID: string, durationMs: number): void {
  const key = modelKey(providerID, modelID);
  const current = cooldownExpiry.get(key);
  const newExpiry = Date.now() + durationMs;
  if (current === undefined || newExpiry > current) {
    cooldownExpiry.set(key, newExpiry);
  }
}

export function isModelInCooldown(providerID: string, modelID: string): boolean {
  const expiry = cooldownExpiry.get(modelKey(providerID, modelID));
  if (expiry === undefined) return false;
  if (Date.now() < expiry) return true;
  cooldownExpiry.delete(modelKey(providerID, modelID));
  return false;
}

export function getCooldownExpiry(providerID: string, modelID: string): number | undefined {
  return cooldownExpiry.get(modelKey(providerID, modelID));
}

export function cleanupExpired(): number {
  let removed = 0;
  const now = Date.now();
  for (const [key, expiry] of cooldownExpiry) {
    if (now >= expiry) {
      cooldownExpiry.delete(key);
      removed++;
    }
  }
  return removed;
}

export function clearAllCooldowns(): void {
  cooldownExpiry.clear();
}

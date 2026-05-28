import { describe, expect, it } from "vitest";

import { cleanupExpired, isModelInCooldown, markModelCooldown } from "@/state/provider-state";

describe("provider-state timed cooldown", () => {
  it("starts as not in cooldown", () => {
    expect(isModelInCooldown("test-a", "model-1")).toBe(false);
  });

  it("marks model in cooldown", () => {
    markModelCooldown("test-b", "model-1", 60_000);
    expect(isModelInCooldown("test-b", "model-1")).toBe(true);
  });

  it("different models are independent", () => {
    markModelCooldown("test-c", "model-1", 60_000);
    expect(isModelInCooldown("test-c", "model-2")).toBe(false);
    expect(isModelInCooldown("test-d", "model-1")).toBe(false);
  });

  it("auto-expires after duration", () => {
    markModelCooldown("test-e", "model-1", -1);
    expect(isModelInCooldown("test-e", "model-1")).toBe(false);
  });

  it("re-mark extends but never shortens", () => {
    markModelCooldown("test-f", "model-1", 60_000);
    const firstCheck = isModelInCooldown("test-f", "model-1");
    markModelCooldown("test-f", "model-1", 10);
    expect(isModelInCooldown("test-f", "model-1")).toBe(firstCheck);
  });

  it("cleanupExpired removes expired entries", () => {
    markModelCooldown("test-g", "model-1", -1);
    markModelCooldown("test-g", "model-2", 60_000);
    const removed = cleanupExpired();
    expect(removed).toBeGreaterThanOrEqual(1);
    expect(isModelInCooldown("test-g", "model-1")).toBe(false);
    expect(isModelInCooldown("test-g", "model-2")).toBe(true);
  });
});

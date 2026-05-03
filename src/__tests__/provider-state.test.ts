import { describe, it, expect, afterEach } from "vitest";
import {
  markModelCooldown,
  isModelInCooldown,
  getCooldownExpiry,
  cleanupExpired,
  clearAllCooldowns,
} from "../provider-state";

describe("provider-state timed cooldown", () => {
  afterEach(() => clearAllCooldowns());

  it("starts as not in cooldown", () => {
    expect(isModelInCooldown("openai", "gpt-5.4")).toBe(false);
  });

  it("marks model in cooldown", () => {
    markModelCooldown("openai", "gpt-5.4", 60_000);
    expect(isModelInCooldown("openai", "gpt-5.4")).toBe(true);
  });

  it("different models are independent", () => {
    markModelCooldown("openai", "gpt-5.4", 60_000);
    expect(isModelInCooldown("openai", "gpt-5.5")).toBe(false);
    expect(isModelInCooldown("anthropic", "claude-sonnet-4")).toBe(false);
  });

  it("auto-expires after duration", () => {
    markModelCooldown("openai", "gpt-5.4", -1);
    expect(isModelInCooldown("openai", "gpt-5.4")).toBe(false);
  });

  it("re-mark extends but never shortens", () => {
    markModelCooldown("openai", "gpt-5.4", 60_000);
    const firstExpiry = getCooldownExpiry("openai", "gpt-5.4")!;
    markModelCooldown("openai", "gpt-5.4", 10);
    expect(getCooldownExpiry("openai", "gpt-5.4")).toBe(firstExpiry);
  });

  it("cleanupExpired removes expired entries", () => {
    markModelCooldown("openai", "gpt-5.4", -1);
    markModelCooldown("anthropic", "claude-sonnet-4", 60_000);
    const removed = cleanupExpired();
    expect(removed).toBe(1);
    expect(isModelInCooldown("openai", "gpt-5.4")).toBe(false);
    expect(isModelInCooldown("anthropic", "claude-sonnet-4")).toBe(true);
  });

  it("clearAllCooldowns resets everything", () => {
    markModelCooldown("openai", "gpt-5.4", 60_000);
    markModelCooldown("anthropic", "claude-sonnet-4", 60_000);
    clearAllCooldowns();
    expect(isModelInCooldown("openai", "gpt-5.4")).toBe(false);
    expect(isModelInCooldown("anthropic", "claude-sonnet-4")).toBe(false);
  });

  it("getCooldownExpiry returns undefined for unknown", () => {
    expect(getCooldownExpiry("openai", "gpt-5.4")).toBeUndefined();
  });
});

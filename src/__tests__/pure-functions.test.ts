import { describe, it, expect } from "vitest"
import { parseModel, getFallbackForAgent } from "../config"
import { isSyntheticPart, convertToPromptPart, extractUserParts } from "../message"
import type { FallbackConfig, MessagePart, MessageWithParts } from "../types"

describe("parseModel", () => {
  it("parses 'provider/model' string into object", () => {
    const result = parseModel("anthropic/claude-sonnet-4")
    expect(result).toEqual({ providerID: "anthropic", modelID: "claude-sonnet-4" })
  })

  it("returns providerID = modelID when no slash", () => {
    const result = parseModel("mymodel")
    expect(result).toEqual({ providerID: "mymodel", modelID: "mymodel" })
  })

  it("passes through object unchanged", () => {
    const obj = { providerID: "google", modelID: "gemini-2.5-flash" }
    expect(parseModel(obj)).toBe(obj)
  })

  it("handles provider with multiple slashes in model ID", () => {
    const result = parseModel("openai/gpt-4/o3-mini")
    expect(result).toEqual({ providerID: "openai", modelID: "gpt-4/o3-mini" })
  })
})

describe("getFallbackForAgent", () => {
  const config: FallbackConfig = {
    enabled: true,
    defaultFallback: "anthropic/claude-opus-4-5",
    agentFallbacks: {
      build: "anthropic/claude-sonnet-4",
      explore: "google/gemini-2.5-flash",
    },
    cooldownMs: 300000,
    patterns: ["rate limit"],
    logging: false,
  }

  it("returns agent-specific fallback when agent is configured", () => {
    expect(getFallbackForAgent(config, "build")).toEqual({
      providerID: "anthropic",
      modelID: "claude-sonnet-4",
    })
  })

  it("returns default fallback when agent is not in map", () => {
    expect(getFallbackForAgent(config, "unknown-agent")).toEqual({
      providerID: "anthropic",
      modelID: "claude-opus-4-5",
    })
  })

  it("returns default fallback when agent is undefined", () => {
    expect(getFallbackForAgent(config, undefined)).toEqual({
      providerID: "anthropic",
      modelID: "claude-opus-4-5",
    })
  })

  it("handles object-form agent fallback", () => {
    const objectConfig: FallbackConfig = {
      ...config,
      agentFallbacks: {
        oracle: { providerID: "anthropic", modelID: "claude-opus-4-5" },
      },
    }
    expect(getFallbackForAgent(objectConfig, "oracle")).toEqual({
      providerID: "anthropic",
      modelID: "claude-opus-4-5",
    })
  })
})

describe("isSyntheticPart", () => {
  it("returns true when synthetic flag is set", () => {
    expect(isSyntheticPart({ type: "text", synthetic: true } as any)).toBe(true)
  })

  it("returns false when synthetic flag is not set", () => {
    expect(isSyntheticPart({ type: "text", text: "hello" } as MessagePart)).toBe(false)
  })

  it("returns false when synthetic is false", () => {
    expect(isSyntheticPart({ type: "text", synthetic: false } as any)).toBe(false)
  })
})

describe("convertToPromptPart", () => {
  it("converts text part with text content", () => {
    const part = { id: "1", type: "text", text: "hello" } as MessagePart
    expect(convertToPromptPart(part)).toEqual({ type: "text", text: "hello" })
  })

  it("returns null for text part without text", () => {
    const part = { id: "1", type: "text" } as MessagePart
    expect(convertToPromptPart(part)).toBeNull()
  })

  it("converts file part with url and mime", () => {
    const part = { id: "2", type: "file", url: "file:///a.png", mime: "image/png", filename: "a.png" } as MessagePart
    expect(convertToPromptPart(part)).toEqual({
      type: "file",
      mime: "image/png",
      filename: "a.png",
      url: "file:///a.png",
    })
  })

  it("returns null for file part without url", () => {
    const part = { id: "2", type: "file", mime: "image/png" } as MessagePart
    expect(convertToPromptPart(part)).toBeNull()
  })

  it("returns null for file part without mime", () => {
    const part = { id: "2", type: "file", url: "file:///a.png" } as MessagePart
    expect(convertToPromptPart(part)).toBeNull()
  })

  it("converts agent part with name", () => {
    const part = { id: "3", type: "agent", name: "build" } as MessagePart
    expect(convertToPromptPart(part)).toEqual({ type: "agent", name: "build" })
  })

  it("returns null for agent part without name", () => {
    const part = { id: "3", type: "agent" } as MessagePart
    expect(convertToPromptPart(part)).toBeNull()
  })

  it("returns null for unknown part type", () => {
    const part = { id: "4", type: "unknown" } as MessagePart
    expect(convertToPromptPart(part)).toBeNull()
  })
})

describe("extractUserParts", () => {
  it("extracts last user message parts", () => {
    const messages: MessageWithParts[] = [
      {
        info: { id: "1", role: "user", sessionID: "s1", parts: [{ id: "p1", type: "text", text: "hello" }] } as any,
        parts: [{ id: "p1", type: "text", text: "hello" } as MessagePart],
      },
      {
        info: { id: "2", role: "assistant", sessionID: "s1" },
        parts: [{ id: "p2", type: "text", text: "world" } as MessagePart],
      },
    ]
    const result = extractUserParts(messages)
    expect(result).not.toBeNull()
    expect(result!.info.role).toBe("user")
    expect(result!.parts).toEqual([{ type: "text", text: "hello" }])
  })

  it("returns null when no user message exists", () => {
    const messages: MessageWithParts[] = [
      {
        info: { id: "1", role: "assistant", sessionID: "s1" },
        parts: [{ id: "p1", type: "text", text: "response" } as MessagePart],
      },
    ]
    expect(extractUserParts(messages)).toBeNull()
  })

  it("filters out synthetic parts", () => {
    const messages: MessageWithParts[] = [
      {
        info: { id: "1", role: "user", sessionID: "s1" },
        parts: [
          { id: "p1", type: "text", text: "real" } as MessagePart,
          { id: "p2", type: "text", text: "synthetic", synthetic: true } as any,
        ],
      },
    ]
    const result = extractUserParts(messages)!
    expect(result.parts).toHaveLength(1)
    expect(result.parts[0]).toEqual({ type: "text", text: "real" })
  })

  it("returns null when all parts are invalid", () => {
    const messages: MessageWithParts[] = [
      {
        info: { id: "1", role: "user", sessionID: "s1" },
        parts: [{ id: "p1", type: "unknown" } as MessagePart],
      },
    ]
    expect(extractUserParts(messages)).toBeNull()
  })
})

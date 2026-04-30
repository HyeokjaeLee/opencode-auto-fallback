import { describe, it, expect, vi, afterEach } from "vitest"
import { forkSessionForLargeContext, injectForkResult } from "../session-fork"
import {
  setForkTracking,
  getForkTracking,
  updateForkStatus,
  deleteForkTracking,
} from "../state/context-state"
import { createMockContext } from "./mocks"
import type { ForkTrackingEntry, FallbackModel, ResolvedModel } from "../types"
import { FORK_TIMEOUT_MS } from "../constants"

// ---------------------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------------------

const noopLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }

const largeModel: FallbackModel = {
  providerID: "openai",
  modelID: "gpt-5.5",
  reasoningEffort: "high",
}

const originalModel: ResolvedModel = {
  providerID: "anthropic",
  modelID: "claude-sonnet-4",
}

const FORKED_SESSION_ID = "forked-session-id"
const MAIN_SESSION_ID = "main-session-1"
const AGENT = "agent-x"

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function createTrackingEntry(
  overrides?: Partial<ForkTrackingEntry>,
): ForkTrackingEntry {
  return {
    forkedSessionID: FORKED_SESSION_ID,
    mainSessionID: MAIN_SESSION_ID,
    status: "forking",
    agent: AGENT,
    largeModel,
    originalModel,
    createdAt: Date.now(),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

afterEach(() => {
  // Safety net: always restore real timers in case a test using fake timers
  // threw before it could restore them itself.
  vi.useRealTimers()
  vi.clearAllMocks()
  deleteForkTracking(FORKED_SESSION_ID)
})

// ===========================================================================
// forkSessionForLargeContext
// ===========================================================================

describe("forkSessionForLargeContext", () => {
  // -----------------------------------------------------------------------
  // Test 1 – Happy path
  // -----------------------------------------------------------------------
  it("fork succeeds → returns ok=true with forked session id", async () => {
    const mockFork = vi
      .fn()
      .mockResolvedValue({ data: { id: FORKED_SESSION_ID } })
    const ctx = createMockContext({ fork: mockFork })

    const result = await forkSessionForLargeContext(
      MAIN_SESSION_ID,
      AGENT,
      largeModel,
      originalModel,
      ctx,
      noopLogger,
    )

    // Return value
    expect(result).toEqual({ ok: true, forkedSessionID: FORKED_SESSION_ID })

    // Fork API called with the original session ID
    expect(mockFork).toHaveBeenCalledTimes(1)
    expect(mockFork).toHaveBeenCalledWith({ path: { id: MAIN_SESSION_ID } })

    // Prompt is NOT sent from forkSessionForLargeContext — it is dispatched
    // asynchronously when the fork session's compaction completes.

    // Tracking entry is created with "forking" status (prompt sent later)
    const entry = getForkTracking(FORKED_SESSION_ID)
    expect(entry).toBeDefined()
    expect(entry!.status).toBe("forking")
    expect(entry!.agent).toBe(AGENT)
    expect(entry!.largeModel).toEqual(largeModel)
    expect(entry!.originalModel).toEqual(originalModel)
  })

  // -----------------------------------------------------------------------
  // Test 2 – Rejected fork promise
  // -----------------------------------------------------------------------
  it("fork API rejects → returns ok=false with error message", async () => {
    const mockFork = vi
      .fn()
      .mockRejectedValue(new Error("Fork API error"))
    const ctx = createMockContext({ fork: mockFork })

    const result = await forkSessionForLargeContext(
      MAIN_SESSION_ID,
      AGENT,
      largeModel,
      originalModel,
      ctx,
      noopLogger,
    )

    expect(result.ok).toBe(false)
    expect(result.error).toBe("Fork API error")
    expect(result.forkedSessionID).toBeUndefined()

    // No prompt should have been sent
    expect(ctx.client.session.prompt).not.toHaveBeenCalled()

    // No tracking entry created
    expect(getForkTracking(FORKED_SESSION_ID)).toBeUndefined()

    // Logger received the error
    expect(noopLogger.error).toHaveBeenCalledWith(
      "Fork: failed to fork session",
      expect.objectContaining({ sessionID: MAIN_SESSION_ID }),
    )
  })

  // -----------------------------------------------------------------------
  // Test 3 – Empty fork response (no id)
  // -----------------------------------------------------------------------
  it("fork returns empty data → returns ok=false", async () => {
    const mockFork = vi.fn().mockResolvedValue({ data: {} })
    const ctx = createMockContext({ fork: mockFork })

    const result = await forkSessionForLargeContext(
      MAIN_SESSION_ID,
      AGENT,
      largeModel,
      originalModel,
      ctx,
      noopLogger,
    )

    expect(result).toEqual({ ok: false, error: "Empty fork response" })

    // No tracking entry and no prompt
    expect(getForkTracking(FORKED_SESSION_ID)).toBeUndefined()
    expect(ctx.client.session.prompt).not.toHaveBeenCalled()
  })

  // -----------------------------------------------------------------------
  // Test 4 – Timeout mechanism
  // -----------------------------------------------------------------------
  it("timeout marks fork as failed after FORK_TIMEOUT_MS", async () => {
    vi.useFakeTimers()

    try {
      const ctx = createMockContext()

      const result = await forkSessionForLargeContext(
        MAIN_SESSION_ID,
        AGENT,
        largeModel,
        originalModel,
        ctx,
        noopLogger,
      )

      // Fork succeeded and status is "forking" (prompt sent later)
      expect(result.ok).toBe(true)
      expect(getForkTracking(FORKED_SESSION_ID)?.status).toBe("forking")

      // Advance clock beyond the timeout threshold
      vi.advanceTimersByTime(FORK_TIMEOUT_MS + 1)

      // Timeout callback should have fired and set status to "failed"
      expect(getForkTracking(FORKED_SESSION_ID)?.status).toBe("failed")
      expect(noopLogger.warn).toHaveBeenCalledWith(
        "Fork: timeout reached, marking as failed",
        expect.objectContaining({
          sessionID: MAIN_SESSION_ID,
          forkedSessionID: FORKED_SESSION_ID,
        }),
      )
    } finally {
      vi.useRealTimers()
    }
  })
})

// ===========================================================================
// injectForkResult
// ===========================================================================

describe("injectForkResult", () => {
  // -----------------------------------------------------------------------
  // Test 5 – Happy path
  // -----------------------------------------------------------------------
  it("reads messages → finds assistant text → prompts main session → returns true", async () => {
    const mockMessages = vi.fn().mockResolvedValue({
      data: [
        {
          info: { role: "user", id: "u1" },
          parts: [{ type: "text", text: "hello" }],
        },
        {
          info: { role: "assistant", id: "a1" },
          parts: [{ type: "text", text: "Here is the result" }],
        },
      ],
    })
    const mockPrompt = vi.fn().mockResolvedValue(undefined)
    const ctx = createMockContext({ messages: mockMessages, prompt: mockPrompt })

    // Seed a tracking entry so status transitions can be observed
    setForkTracking(createTrackingEntry({ status: "running", lastRequest: "optimize the query" }))

    const result = await injectForkResult(
      FORKED_SESSION_ID,
      MAIN_SESSION_ID,
      AGENT,
      ctx,
      noopLogger,
    )

    expect(result).toBe(true)

    // Messages fetched from the forked session
    expect(mockMessages).toHaveBeenCalledWith({
      path: { id: FORKED_SESSION_ID },
    })

    // Result injected into the main session — prompt body should contain
    // the assistant text extracted from the forked session
    expect(mockPrompt).toHaveBeenCalledTimes(1)
    const promptCall = mockPrompt.mock.calls[0][0]
    expect(promptCall.path).toEqual({ id: MAIN_SESSION_ID })
    expect(promptCall.body.agent).toBe(AGENT)
    // The result is embedded in the inject prompt with structured context
    const injectText = promptCall.body.parts.map((p: { text: string }) => p.text).join("")
    expect(injectText).toContain("Your conversation context was compacted")
    expect(injectText).toContain("Your last task before compaction was")
    expect(injectText).toContain("Here is the result")
    expect(injectText).toContain("Review the result above")
    expect(injectText).toContain("If there are remaining steps")

    // Final status is "done"
    expect(getForkTracking(FORKED_SESSION_ID)?.status).toBe("done")
  })

  // -----------------------------------------------------------------------
  // Test 6 – No assistant message found
  // -----------------------------------------------------------------------
  it("no assistant message in forked session → returns false without injecting", async () => {
    const mockMessages = vi.fn().mockResolvedValue({
      data: [
        {
          info: { role: "user", id: "u1" },
          parts: [{ type: "text", text: "hello" }],
        },
      ],
    })
    const ctx = createMockContext({ messages: mockMessages })

    setForkTracking(createTrackingEntry({ status: "running" }))

    const result = await injectForkResult(
      FORKED_SESSION_ID,
      MAIN_SESSION_ID,
      AGENT,
      ctx,
      noopLogger,
    )

    expect(result).toBe(false)

    // Main session was never prompted
    expect(ctx.client.session.prompt).not.toHaveBeenCalled()

    // Status goes to "completed" (not "injecting" → "completed")
    expect(getForkTracking(FORKED_SESSION_ID)?.status).toBe("completed")
  })

  // -----------------------------------------------------------------------
  // Test 7 – Messages API failure
  // -----------------------------------------------------------------------
  it("messages API rejects → returns false", async () => {
    const mockMessages = vi
      .fn()
      .mockRejectedValue(new Error("Messages API error"))
    const ctx = createMockContext({ messages: mockMessages })

    setForkTracking(createTrackingEntry({ status: "running" }))

    const result = await injectForkResult(
      FORKED_SESSION_ID,
      MAIN_SESSION_ID,
      AGENT,
      ctx,
      noopLogger,
    )

    expect(result).toBe(false)

    // Status set to "failed" by the catch block
    expect(getForkTracking(FORKED_SESSION_ID)?.status).toBe("failed")

    // Error was logged
    expect(noopLogger.error).toHaveBeenCalledWith(
      "Fork: failed to inject result",
      expect.objectContaining({
        forkedSessionID: FORKED_SESSION_ID,
        mainSessionID: MAIN_SESSION_ID,
      }),
    )
  })
})

// ===========================================================================
// Fork tracking lifecycle (pure state operations)
// ===========================================================================

describe("fork tracking lifecycle", () => {
  // -----------------------------------------------------------------------
  // Test 8 – Status transitions
  // -----------------------------------------------------------------------
  it("transitions through all statuses: forking → running → completed → injecting → done", () => {
    // forking
    setForkTracking(createTrackingEntry({ status: "forking" }))
    expect(getForkTracking(FORKED_SESSION_ID)?.status).toBe("forking")

    // running
    updateForkStatus(FORKED_SESSION_ID, "running")
    expect(getForkTracking(FORKED_SESSION_ID)?.status).toBe("running")

    // completed
    updateForkStatus(FORKED_SESSION_ID, "completed")
    expect(getForkTracking(FORKED_SESSION_ID)?.status).toBe("completed")

    // injecting
    updateForkStatus(FORKED_SESSION_ID, "injecting")
    expect(getForkTracking(FORKED_SESSION_ID)?.status).toBe("injecting")

    // done
    updateForkStatus(FORKED_SESSION_ID, "done")
    expect(getForkTracking(FORKED_SESSION_ID)?.status).toBe("done")
  })

  // -----------------------------------------------------------------------
  // Test 9 – Cleanup
  // -----------------------------------------------------------------------
  it("deleteForkTracking removes the tracking entry", () => {
    setForkTracking(createTrackingEntry())
    expect(getForkTracking(FORKED_SESSION_ID)).toBeDefined()

    deleteForkTracking(FORKED_SESSION_ID)
    expect(getForkTracking(FORKED_SESSION_ID)).toBeUndefined()
  })
})

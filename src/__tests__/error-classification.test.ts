import { describe, expect, it } from "vitest";

import { classifyError } from "@/core/decision";

describe("classifyError (structured)", () => {
  describe("cooldown active → ignore", () => {
    it("ignores regardless of status code", () => {
      expect(classifyError(401, false, true)).toEqual({ action: "ignore" });
      expect(classifyError(429, true, true)).toEqual({ action: "ignore" });
      expect(classifyError(undefined, undefined, true)).toEqual({ action: "ignore" });
    });
  });

  describe("HTTP 401/402/403 → immediate", () => {
    it("401 → immediate", () => {
      expect(classifyError(401, false, false)).toEqual(
        expect.objectContaining({ action: "immediate", httpStatus: 401 }),
      );
    });
    it("402 → immediate", () => {
      expect(classifyError(402, false, false)).toEqual(
        expect.objectContaining({ action: "immediate", httpStatus: 402 }),
      );
    });
    it("403 → immediate", () => {
      expect(classifyError(403, true, false)).toEqual(
        expect.objectContaining({ action: "immediate", httpStatus: 403 }),
      );
    });
    it("immediate takes priority over isRetryable", () => {
      // Even if SDK says retryable, 401 is always immediate
      expect(classifyError(401, true, false)).toEqual(
        expect.objectContaining({ action: "immediate", httpStatus: 401 }),
      );
    });
  });

  describe("isRetryable === true → retry", () => {
    it("retryable with status code", () => {
      expect(classifyError(500, true, false)).toEqual(
        expect.objectContaining({ action: "retry", httpStatus: 500, isRetryable: true }),
      );
    });
    it("retryable without status code", () => {
      expect(classifyError(undefined, true, false)).toEqual(
        expect.objectContaining({ action: "retry", isRetryable: true }),
      );
    });
    it("retryable with non-standard status code", () => {
      expect(classifyError(418, true, false)).toEqual(
        expect.objectContaining({ action: "retry", isRetryable: true }),
      );
    });
  });

  describe("HTTP 429/5xx → retry", () => {
    it("429 → retry", () => {
      expect(classifyError(429, undefined, false)).toEqual(
        expect.objectContaining({ action: "retry", httpStatus: 429 }),
      );
    });
    it("500 → retry", () => {
      expect(classifyError(500, undefined, false)).toEqual(
        expect.objectContaining({ action: "retry", httpStatus: 500 }),
      );
    });
    it("503 → retry", () => {
      expect(classifyError(503, undefined, false)).toEqual(
        expect.objectContaining({ action: "retry", httpStatus: 503 }),
      );
    });
    it("529 → retry", () => {
      expect(classifyError(529, undefined, false)).toEqual(
        expect.objectContaining({ action: "retry", httpStatus: 529 }),
      );
    });
  });

  describe("isRetryable === false → immediate fallback", () => {
    it("non-retryable with unknown status code → immediate", () => {
      expect(classifyError(418, false, false)).toEqual(
        expect.objectContaining({ action: "immediate", httpStatus: 418, isRetryable: false }),
      );
    });
    it("non-retryable with no status code → immediate", () => {
      expect(classifyError(undefined, false, false)).toEqual(
        expect.objectContaining({ action: "immediate", isRetryable: false }),
      );
    });
    it("non-retryable with 500 → immediate (overrides status code heuristic)", () => {
      expect(classifyError(500, false, false)).toEqual(
        expect.objectContaining({ action: "immediate", httpStatus: 500, isRetryable: false }),
      );
    });
  });

  describe("default → retry (safety net)", () => {
    it("no status, no isRetryable → retry", () => {
      expect(classifyError(undefined, undefined, false)).toEqual({ action: "retry" });
    });
  });
});

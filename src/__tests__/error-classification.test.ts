import { describe, it, expect } from "vitest"
import { classifyError } from "../decision"
import { matchImmediatePattern, matchRetryablePattern, extractHttpStatus } from "../matcher"

describe("extractHttpStatus", () => {
  it("extracts 429", () => expect(extractHttpStatus("Error 429: rate limit")).toBe(429))
  it("extracts 503", () => expect(extractHttpStatus("503 Service Unavailable")).toBe(503))
  it("extracts 401", () => expect(extractHttpStatus("HTTP 401 Unauthorized")).toBe(401))
  it("ignores 200", () => expect(extractHttpStatus("200 OK")).toBeUndefined())
  it("undefined for no status", () => expect(extractHttpStatus("something broke")).toBeUndefined())
})

describe("matchImmediatePattern", () => {
  it("quota exceeded", () => expect(matchImmediatePattern("Error: quota exceeded")).toBeTruthy())
  it("exceeded your", () => expect(matchImmediatePattern("You exceeded your quota")).toBeTruthy())
  it("authentication", () => expect(matchImmediatePattern("Authentication failed")).toBeTruthy())
  it("invalid api key", () => expect(matchImmediatePattern("Invalid API key provided")).toBeTruthy())
  it("no match on rate limit", () => expect(matchImmediatePattern("rate limit reached")).toBeUndefined())
  it("no match on generic", () => expect(matchImmediatePattern("something went wrong")).toBeUndefined())
})

describe("matchRetryablePattern", () => {
  it("rate limit", () => expect(matchRetryablePattern("rate limit reached")).toBeTruthy())
  it("too many requests", () => expect(matchRetryablePattern("Too many requests")).toBeTruthy())
  it("service unavailable", () => expect(matchRetryablePattern("503 Service Unavailable")).toBeTruthy())
  it("no match on auth", () => expect(matchRetryablePattern("unauthorized")).toBeUndefined())
})

describe("classifyError", () => {
  it("HTTP 401 → immediate", () => {
    expect(classifyError("HTTP 401 Unauthorized", false)).toEqual(expect.objectContaining({ action: "immediate", httpStatus: 401 }))
  })
  it("HTTP 403 → immediate", () => {
    expect(classifyError("403 Forbidden", false)).toEqual(expect.objectContaining({ action: "immediate", httpStatus: 403 }))
  })
  it("HTTP 429 → retry", () => {
    expect(classifyError("429 Too Many Requests", false)).toEqual(expect.objectContaining({ action: "retry", httpStatus: 429 }))
  })
  it("HTTP 503 → retry", () => {
    expect(classifyError("503 Service Unavailable", false)).toEqual(expect.objectContaining({ action: "retry", httpStatus: 503 }))
  })
  it("quota exceeded → immediate", () => {
    expect(classifyError("Error: quota exceeded", false)).toEqual(expect.objectContaining({ action: "immediate" }))
  })
  it("rate limit → retry", () => {
    expect(classifyError("rate limit reached", false)).toEqual(expect.objectContaining({ action: "retry" }))
  })
  it("unknown → retry (default)", () => {
    expect(classifyError("something went wrong", false)).toEqual({ action: "retry" })
  })
  it("cooldown → ignore", () => {
    expect(classifyError("quota exceeded", true)).toEqual({ action: "ignore" })
    expect(classifyError("429 error", true)).toEqual({ action: "ignore" })
  })
  it("HTTP status takes priority over pattern", () => {
    expect(classifyError("401 rate limit issue", false)).toEqual(expect.objectContaining({ action: "immediate", httpStatus: 401 }))
  })
})

# PROJECT KNOWLEDGE BASE

**Generated:** 2026-04-30
**Branch:** main

## OVERVIEW

OpenCode plugin that intercepts LLM error responses and automatically switches to a fallback model chain. Pure TypeScript, ESM, no build step — ships raw `.ts` source.

## STRUCTURE

```
opencode-auto-fallback/
├── index.ts                  # Public API: exports createPlugin + types
├── src/
│   ├── plugin.ts             # Orchestration: hooks wiring, update checker (~770 lines)
│   ├── session-fork.ts       # Fork creation, fork result injection (~150 lines)
│   ├── types.ts              # All interfaces/types (FallbackConfig, FallbackModel, ToastOptions, ForkTrackingEntry, etc.)
│   ├── config.ts             # Config loading, auto-generation, chain resolution
│   ├── constants.ts          # HTTP status code sets + backoff base + error patterns

│   ├── decision.ts           # classifyError() — statusCode + isRetryable → immediate | retry | ignore
│   ├── session-state.ts      # Per-session cooldown + backoff level
│   ├── provider-state.ts     # Per-model timed cooldown (Map<provider/model, expiry>)
│   ├── message.ts            # Message extraction from session history
│   ├── log.ts                # File logging to ~/.local/share/opencode/log/
│   ├── update-checker.ts     # Auto-update via npm registry
│   ├── adapters/
│   │   └── sdk-adapter.ts    # SDK → domain type conversions (toMessageInfo, adaptMessages, etc.)
│   ├── state/
│   │   └── context-state.ts  # Centralized state: fallback params, model tracking, phase management
│   └── __tests__/
│       ├── mocks.ts          # createMockContext(), createMockMessages()
│       ├── plugin.test.ts    # Integration tests (handler functions)
│       ├── pure-functions.test.ts  # Unit tests for pure functions
│       ├── error-classification.test.ts  # Comprehensive classifyError tests
│       └── provider-state.test.ts  # Provider cooldown tests
├── docs/
│   └── fallback.schema.json  # JSON Schema for config validation
├── .github/workflows/publish.yml  # Auto-publish on version bump
├── package.json
├── tsconfig.json
└── bun.lock
```

## WHERE TO LOOK

| Task                          | Location                                                        | Notes                                                                              |
| ----------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Change classification logic   | `src/decision.ts`                                               | Priority: cooldown → HTTP 401/402/403 → isRetryable → HTTP 429/5xx → default=retry |
| Change retry/backoff behavior | `src/plugin.ts` handleRetry()                                   | Exponential: 2^n × 2000ms                                                          |
| Change fallback chain logic   | `src/plugin.ts` tryFallbackChain()                              | Iterates chain, skips cooldown models                                              |
| Change error detection        | `src/plugin.ts` event handler                                   | Processes session.error, session.status events                                     |
| Add config field              | `src/types.ts` → `src/config.ts` → `src/plugin.ts`              | Types first, then loading, then usage                                              |
| Add fallback model param      | `src/types.ts` FallbackModel + `src/plugin.ts` chat.params hook | Params go through chat.params, not prompt body                                     |
| Add unit test                 | `src/__tests__/pure-functions.test.ts`                          | Import from module directly                                                        |
| Add integration test          | `src/__tests__/plugin.test.ts`                                  | Use createMockContext() from mocks.ts                                              |
| Change large context fallback | `src/plugin.ts` compacting/idle handlers                        | Three-tier context window: SDK auto-detect → config → builtin                     |
| Change fork creation/logic    | `src/session-fork.ts`                                           | Fork session, inject fork result, tracking entry management                       |
| Change structured inject msg  | `src/session-fork.ts` injectForkResult()                        | Builds compaction notice + last request + result + continue instruction           |
| Change state management       | `src/state/context-state.ts`                                    | Centralized Maps: fallback params, model tracking, phase management, fork tracking |
| Change SDK adapters           | `src/adapters/sdk-adapter.ts`                                   | SDK → domain type conversions with zero `as any`                                  |

## CODE MAP

| Symbol             | Type      | Location      | Role                                                                      |
| ------------------ | --------- | ------------- | ------------------------------------------------------------------------- |
| `createPlugin`     | function  | plugin.ts     | Plugin entry — returns Hooks object                                       |
| `classifyError`    | function  | decision.ts   | statusCode + isRetryable → immediate/retry/ignore                         |
| `handleRetry`      | function  | plugin.ts     | Abort → backoff → same-model retry → fallback chain                       |
| `handleImmediate`  | function  | plugin.ts     | Abort → cooldown → fallback chain (no retry)                              |
| `tryFallbackChain` | function  | plugin.ts     | Iterates chain, skips cooldown models                                     |
| `adaptMessages`    | function  | adapters/sdk-adapter.ts | SDK Message/Part → domain MessageWithParts                                |
| `getFallbackChain` | function  | config.ts     | Resolves agent-specific or default chain                                  |
| `loadConfig`       | function  | config.ts     | Loads from disk, auto-creates if missing                                  |
| `FallbackConfig`   | interface | types.ts      | enabled, defaultFallback, agentFallbacks, cooldownMs, maxRetries, logging |
| `FallbackModel`    | interface | types.ts      | providerID, modelID, variant, temperature, topP, etc.                     |
| `ToastOptions`     | interface | types.ts      | title, message, variant, duration                                         |
| `SessionState`     | interface | types.ts      | fallbackActive, cooldownEndTime, backoffLevel                             |
| `ForkTrackingEntry`| interface | types.ts      | forkedSessionID, mainSessionID, status, agent, lastRequest, etc.         |
| `forkSessionForLargeContext` | function | session-fork.ts | Forks session with large model, sets up tracking                          |
| `injectForkResult` | function  | session-fork.ts | Reads fork result, injects structured message into main session            |

## ERROR CLASSIFICATION PRIORITY

```
1. Cooldown active → ignore
2. HTTP 401/402/403 → immediate
3. isRetryable === true → retry (our plugin handles backoff)
4. isRetryable === false → immediate (skip retry, go straight to fallback)
5. HTTP 429/500/502/503/504/529 → retry (status code heuristic)
6. Default → retry (unknown errors get backoff+retry)
```

## KEY ARCHITECTURE DECISIONS

- Plugin intercepts errors through `session.error` and `session.status` events
- `isRetryable` from SDK's `ApiError.data.isRetryable` is the primary classification signal
- Status code heuristics are used only when `isRetryable` is `undefined`
- SDK → domain type adapters bridge the gap between SDK types and our simplified domain types

## CONVENTIONS

- **Strict TS**: `"strict": true`, zero `as any` — SDK type gaps handled via typed adapters
- **No build**: `"noEmit": true` — plugin ships raw `.ts`
- **ESM only**: `"type": "module"`
- **Vitest**: zero-config, tests in `src/__tests__/*.test.ts`
- **Mock pattern**: `createMockContext(overrides?)` factory, `_forTesting` export for white-box access
- **Config auto-create**: `loadConfig()` writes default to `~/.config/opencode/fallback.json` if missing
- **Commit style**: Conventional Commits (`feat:`, `fix:`, `test:`, `ci:`) — **messages must be in English**
- **Versioning**: `npm version patch --no-git-tag-version` → GitHub Actions release → npm publish

## KNOWN LIMITATIONS

- Synchronous `readFileSync/writeFileSync` in config.ts mixed with async `appendFile/mkdir` in log.ts
- Await delays extracted to constants (ABORT_DELAY_MS, REVERT_DELAY_MS) — not configurable by end users
- No CI quality gates: tests and typecheck not run before publish

## COMMANDS

```bash
bun install            # Install deps (uses bun.lock)
tsc --noEmit           # TypeScript typecheck
bun vitest run         # Run all tests
npm version patch --no-git-tag-version  # Bump version (CI handles release)
```

## NOTES

- `index.ts` re-exports `createPlugin` as `AutoFallbackPlugin` — downstream imports name it
- `session-state.ts` and `provider-state.ts` use module-level Maps — state lost on restart
- Fallback model params (temperature, reasoningEffort, etc.) go through `chat.params` hook, not `session.prompt` body
- `_forTesting` namespace exposes internal handlers for test access
- SDK → domain type adapters in `src/adapters/sdk-adapter.ts`: `toMessageInfo()`, `toMessagePart()`, `adaptMessages()`, `getModelFromMessage()`
- Toast API uses `ClientWithTui` typed interface — `(context.client as ClientWithTui).tui?.showToast()` gracefully degrades if unavailable

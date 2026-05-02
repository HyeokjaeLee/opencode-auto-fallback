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
│   ├── plugin.ts             # Plugin entry: createPlugin orchestrator + hook factories
│   ├── fallback.ts           # Error fallback logic: retry, immediate, chain operations
│   ├── large-context.ts      # Large context management: switch, return, completion, threshold
│   ├── session-utils.ts      # Shared utilities: toast, abort, fetchSessionData, types
│   ├── hooks/
│   │   └── events.ts         # Event handlers: session.error, compacted, idle, status, deleted
│   ├── types.ts              # All interfaces/types
│   ├── config.ts             # Config loading, auto-generation, chain resolution
│   ├── constants.ts          # HTTP status code sets + backoff base + error patterns
│   ├── decision.ts           # classifyError() — statusCode + isRetryable → immediate | retry | ignore
│   ├── session-state.ts      # Per-session cooldown + backoff level
│   ├── provider-state.ts     # Per-model timed cooldown (Map<provider/model, expiry>)
│   ├── message.ts            # Message extraction from session history
│   ├── log.ts                # File logging to ~/.local/share/opencode/log/
│   ├── update-checker.ts     # Auto-update via npm registry
│   ├── adapters/
│   │   └── sdk-adapter.ts    # SDK → domain type conversions
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
| Change retry/backoff behavior | `src/fallback.ts` handleRetry()                                 | Exponential: 2^n × 2000ms                                                          |
| Change fallback chain logic   | `src/fallback.ts` tryFallbackChain()                            | Iterates chain, skips cooldown models                                              |
| Change error detection        | `src/hooks/events.ts` handleSessionError()                      | Processes session.error, session.status events                                     |
| Change event handling         | `src/hooks/events.ts`                                           | All event handlers: error, compacted, idle, status, deleted                        |
| Add config field              | `src/types.ts` → `src/config.ts` → `src/plugin.ts`              | Types first, then loading, then usage                                              |
| Add fallback model param      | `src/types.ts` FallbackModel + `src/plugin.ts` chat.params hook | Params go through chat.params, not prompt body                                     |
| Add unit test                 | `src/__tests__/pure-functions.test.ts`                          | Import from module directly                                                        |
| Add integration test          | `src/__tests__/plugin.test.ts`                                  | Use createMockContext() from mocks.ts                                              |
| Change large context fallback | `src/large-context.ts`                                          | Switch, return, completion, threshold checks                                       |
| Change hook handlers          | `src/plugin.ts` create\*Handler() factories                     | config, chat.params, compacting, autocontinue hooks                                |
| Change state management       | `src/state/context-state.ts`                                    | Centralized Maps: fallback params, model tracking, phase management                |
| Change SDK adapters           | `src/adapters/sdk-adapter.ts`                                   | SDK → domain type conversions with zero `as any`                                   |
| Change shared utilities       | `src/session-utils.ts`                                          | Toast, abort, fetchSessionData, type aliases                                       |

## CODE MAP

| Symbol                         | Type      | Location                | Role                                                                      |
| ------------------------------ | --------- | ----------------------- | ------------------------------------------------------------------------- |
| `createPlugin`                 | function  | plugin.ts               | Plugin entry — returns Hooks object                                       |
| `classifyError`                | function  | decision.ts             | statusCode + isRetryable → immediate/retry/ignore                         |
| `handleRetry`                  | function  | fallback.ts             | Abort → backoff → same-model retry → fallback chain                       |
| `handleImmediate`              | function  | fallback.ts             | Abort → cooldown → fallback chain (no retry)                              |
| `tryFallbackChain`             | function  | fallback.ts             | Iterates chain, skips cooldown models                                     |
| `revertAndPrompt`              | function  | fallback.ts             | Revert session + prompt with fallback model                               |
| `handleLargeContextSwitch`     | function  | large-context.ts        | In-place model switch for large context                                   |
| `handleLargeContextReturn`     | function  | large-context.ts        | Compaction + switch back to original model                                |
| `handleLargeContextCompletion` | function  | large-context.ts        | Finalize switch-back, send continuation                                   |
| `checkContextThreshold`        | function  | large-context.ts        | Check if session is at context limit                                      |
| `createEventHandler`           | function  | hooks/events.ts         | Factory for all event handlers                                            |
| `adaptMessages`                | function  | adapters/sdk-adapter.ts | SDK Message/Part → domain MessageWithParts                                |
| `getFallbackChain`             | function  | config.ts               | Resolves agent-specific or default chain                                  |
| `loadConfig`                   | function  | config.ts               | Loads from disk, auto-creates if missing                                  |
| `FallbackConfig`               | interface | types.ts                | enabled, defaultFallback, agentFallbacks, cooldownMs, maxRetries, logging |
| `FallbackModel`                | interface | types.ts                | providerID, modelID, variant, temperature, topP, etc.                     |
| `ToastOptions`                 | interface | types.ts                | title, message, variant, duration                                         |
| `SessionState`                 | interface | types.ts                | fallbackActive, cooldownEndTime, backoffLevel                             |
| `LargeContextPhase`            | type      | types.ts                | "pending" \| "active" \| "summarizing"                                    |

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
- Large context management uses in-place model switching
- `plugin.ts` is a thin orchestrator — business logic lives in `fallback.ts`, `large-context.ts`, and `hooks/events.ts`
- Hook handlers are factory functions that capture config/logger/context in closure

## CONVENTIONS

- **Strict TS**: `"strict": true`, zero `as any` — SDK type gaps handled via typed adapters
- **No build**: `"noEmit": true` — plugin ships raw `.ts`
- **ESM only**: `"type": "module"`
- **Vitest**: zero-config, tests in `src/__tests__/*.test.ts`
- **Mock pattern**: `createMockContext(overrides?)` factory, direct module imports for test access
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
bun vitest run         # Run all tests (71 tests)
npm version patch --no-git-tag-version  # Bump version (CI handles release)
```

## NOTES

- `index.ts` re-exports `createPlugin` as `AutoFallbackPlugin` — downstream imports name it
- `session-state.ts` and `provider-state.ts` use module-level Maps — state lost on restart
- Fallback model params (temperature, reasoningEffort, etc.) go through `chat.params` hook, not `session.prompt` body
- Tests import directly from modules (`fallback.ts`, `large-context.ts`, `session-utils.ts`) — not via `_forTesting`
- SDK → domain type adapters in `src/adapters/sdk-adapter.ts`: `adaptMessages()`, `getModelFromMessage()`
- Toast API uses `ClientWithTui` typed interface — `(context.client as ClientWithTui).tui?.showToast()` gracefully degrades if unavailable
- `session-utils.ts` exports shared types: `Logger`, `ChatMessageInput`, `ClientWithTui`
- Tests import directly from modules (`fallback.ts`, `large-context.ts`, `session-utils.ts`) — no `_forTesting` indirection

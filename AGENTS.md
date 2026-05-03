# PROJECT KNOWLEDGE BASE

**Generated:** 2026-04-30
**Branch:** main

## OVERVIEW

OpenCode plugin that intercepts LLM error responses and automatically switches to a fallback model chain. Pure TypeScript, ESM, no build step — ships raw `.ts` source.

## STRUCTURE

```
opencode-auto-fallback/
├── src/
│   ├── index.ts               # Public API: exports createPlugin + types
│   ├── core/
│   │   ├── plugin.ts          # Plugin entry: createPlugin orchestrator + hook factories
│   │   ├── fallback.ts        # Error fallback logic: retry, immediate, chain operations
│   │   ├── large-context.ts   # Large context management: switch, return, completion, threshold
│   │   ├── decision.ts        # classifyError() — statusCode + isRetryable → immediate | retry | ignore
│   │   └── message.ts         # Message extraction from session history
│   ├── state/
│   │   ├── context-state.ts   # Centralized state: fallback params, model tracking, phase management
│   │   ├── session-state.ts   # Per-session cooldown + backoff level
│   │   └── provider-state.ts  # Per-model timed cooldown (Map<provider/model, expiry>)
│   ├── config/
│   │   ├── config.ts          # Config loading, auto-generation, chain resolution
│   │   ├── constants.ts       # HTTP status code sets + backoff base + error patterns
│   │   └── types.ts           # All interfaces/types
│   ├── utils/
│   │   ├── session-utils.ts   # Shared utilities: toast, abort, fetchSessionData, types
│   │   ├── log.ts             # File logging to ~/.local/share/opencode/log/
│   │   ├── update-checker.ts  # Auto-update via npm registry
│   │   ├── model.ts           # Model comparison, limit checking utilities
│   │   └── error.ts           # Error parsing and formatting utilities
│   ├── adapters/
│   │   └── sdk-adapter.ts     # SDK → domain type conversions
│   ├── hooks/
│   │   └── events.ts          # Event handlers: session.error, compacted, idle, status, deleted
│   └── __tests__/
│       ├── mocks.ts           # createMockContext(), createMockMessages()
│       ├── plugin.test.ts     # Integration tests (handler functions)
│       ├── pure-functions.test.ts  # Unit tests for pure functions
│       ├── error-classification.test.ts  # Comprehensive classifyError tests
│       └── provider-state.test.ts  # Provider cooldown tests
├── docs/
│   └── fallback.schema.json   # JSON Schema for config validation
├── .github/workflows/publish.yml  # Auto-publish on version bump
├── package.json
├── tsconfig.json
└── bun.lock
```

## WHERE TO LOOK

| Task                          | Location                                                        | Notes                                                                              |
| ----------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Change classification logic   | `src/core/decision.ts`                                          | Priority: cooldown → HTTP 401/402/403 → isRetryable → HTTP 429/5xx → default=retry |
| Change retry/backoff behavior | `src/core/fallback.ts` handleRetry()                            | Exponential: 2^n × 2000ms                                                          |
| Change fallback chain logic   | `src/core/fallback.ts` tryFallbackChain()                       | Iterates chain, skips cooldown models                                              |
| Change error detection        | `src/hooks/events.ts` handleSessionError()                      | Processes session.error, session.status events                                     |
| Change event handling         | `src/hooks/events.ts`                                           | All event handlers: error, compacted, idle, status, deleted                        |
| Add config field              | `src/config/types.ts` → `src/config/config.ts` → `src/core/plugin.ts` | Types first, then loading, then usage                                              |
| Add fallback model param      | `src/config/types.ts` FallbackModel + `src/core/plugin.ts` chat.params hook | Params go through chat.params, not prompt body                                     |
| Add unit test                 | `src/__tests__/pure-functions.test.ts`                          | Import from module directly                                                        |
| Add integration test          | `src/__tests__/plugin.test.ts`                                  | Use createMockContext() from mocks.ts                                              |
| Change large context fallback | `src/core/large-context.ts`                                     | Switch, return, completion, threshold checks                                       |
| Change hook handlers          | `src/core/plugin.ts` create\*Handler() factories                | config, chat.params, compacting, autocontinue hooks                                |
| Change state management       | `src/state/context-state.ts`                                    | Centralized Maps: fallback params, model tracking, phase management                |
| Change SDK adapters           | `src/adapters/sdk-adapter.ts`                                   | SDK → domain type conversions with zero `as any`                                   |
| Change shared utilities       | `src/utils/session-utils.ts`                                    | Toast, abort, fetchSessionData, type aliases                                       |

## CODE MAP

| Symbol                         | Type      | Location                | Role                                                                      |
| ------------------------------ | --------- | ----------------------- | ------------------------------------------------------------------------- |
| `createPlugin`                 | function  | src/core/plugin.ts      | Plugin entry — returns Hooks object                                       |
| `classifyError`                | function  | src/core/decision.ts    | statusCode + isRetryable → immediate/retry/ignore                         |
| `handleRetry`                  | function  | src/core/fallback.ts    | Abort → backoff → same-model retry → fallback chain                       |
| `handleImmediate`              | function  | src/core/fallback.ts    | Abort → cooldown → fallback chain (no retry)                              |
| `tryFallbackChain`             | function  | src/core/fallback.ts    | Iterates chain, skips cooldown models                                     |
| `revertAndPrompt`              | function  | src/core/fallback.ts    | Revert session + prompt with fallback model                               |
| `handleLargeContextSwitch`     | function  | src/core/large-context.ts | In-place model switch for large context                                   |
| `handleLargeContextReturn`     | function  | src/core/large-context.ts | Compaction + switch back to original model                                |
| `handleLargeContextCompletion` | function  | src/core/large-context.ts | Finalize switch-back, send continuation                                   |
| `checkContextThreshold`        | function  | src/core/large-context.ts | Check if session is at context limit                                      |
| `createEventHandler`           | function  | src/hooks/events.ts     | Factory for all event handlers                                            |
| `adaptMessages`                | function  | src/adapters/sdk-adapter.ts | SDK Message/Part → domain MessageWithParts                                |
| `getFallbackChain`             | function  | src/config/config.ts    | Resolves agent-specific or default chain                                  |
| `loadConfig`                   | function  | src/config/config.ts    | Loads from disk, auto-creates if missing                                  |
| `FallbackConfig`               | interface | src/config/types.ts     | enabled, defaultFallback, agentFallbacks, cooldownMs, maxRetries, logging |
| `FallbackModel`                | interface | src/config/types.ts     | providerID, modelID, variant, temperature, topP, etc.                     |
| `ToastOptions`                 | interface | src/config/types.ts     | title, message, variant, duration                                         |
| `SessionState`                 | interface | src/config/types.ts     | fallbackActive, cooldownEndTime, backoffLevel                             |
| `LargeContextPhase`            | type      | src/config/types.ts     | "pending" \| "active" \| "summarizing"                                    |

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

- `src/index.ts` re-exports `createPlugin` as `AutoFallbackPlugin` — downstream imports name it
- `src/state/session-state.ts` and `src/state/provider-state.ts` use module-level Maps — state lost on restart
- Fallback model params (temperature, reasoningEffort, etc.) go through `chat.params` hook, not `session.prompt` body
- SDK → domain type adapters in `src/adapters/sdk-adapter.ts`: `adaptMessages()`, `getModelFromMessage()`
- Toast API uses `ClientWithTui` typed interface — `(context.client as ClientWithTui).tui?.showToast()` gracefully degrades if unavailable
- `src/utils/session-utils.ts` exports shared types: `Logger`, `ChatMessageInput`, `ClientWithTui`
- Tests import directly from modules (`src/core/fallback.ts`, `src/core/large-context.ts`, `src/utils/session-utils.ts`) — no `_forTesting` indirection

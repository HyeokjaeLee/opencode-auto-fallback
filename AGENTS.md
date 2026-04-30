# PROJECT KNOWLEDGE BASE

**Generated:** 2026-04-29
**Commit:** 565b315
**Branch:** main

## OVERVIEW
OpenCode plugin that intercepts LLM error responses and automatically switches to a fallback model chain. Pure TypeScript, ESM, no build step — ships raw `.ts` source.

## STRUCTURE
```
opencode-auto-fallback/
├── index.ts                  # Public API: exports createPlugin + types
├── src/
│   ├── plugin.ts             # Core: hooks, retry logic, fallback execution (~400 lines)
│   ├── types.ts              # All interfaces/types
│   ├── config.ts             # Config loading, auto-generation, chain resolution
│   ├── constants.ts          # HTTP status code sets + backoff base
│   ├── decision.ts           # classifyError() — statusCode + isRetryable → immediate | retry | ignore
│   ├── session-state.ts      # Per-session cooldown + backoff level
│   ├── provider-state.ts     # Per-model timed cooldown (Map<provider/model, expiry>)
│   ├── message.ts            # Message extraction from session history
│   ├── log.ts                # File logging to ~/.local/share/opencode/logs/
│   ├── update-checker.ts     # Auto-update via npm registry
│   ├── fallback.schema.json  # JSON Schema for config validation
│   └── __tests__/
│       ├── mocks.ts          # createMockContext(), createMockMessages(), createMockRetryPart()
│       ├── plugin.test.ts    # Integration tests (handler functions)
│       ├── pure-functions.test.ts
│       ├── error-classification.test.ts
│       └── provider-state.test.ts
├── .github/workflows/publish.yml  # Auto-publish on version bump
├── package.json
├── tsconfig.json
└── bun.lock
```

## WHERE TO LOOK
| Task | Location | Notes |
|------|----------|-------|
| Change classification logic | `src/decision.ts` | Priority: cooldown → HTTP 401/402/403 → isRetryable → HTTP 429/5xx → default=retry |
| Change retry/backoff behavior | `src/plugin.ts` handleRetry() | Exponential: 2^n × 2000ms |
| Change fallback chain logic | `src/plugin.ts` tryFallbackChain() | Iterates chain, skips cooldown models |
| Change error detection | `src/plugin.ts` findRetryPart() | Scans output.parts for RetryPart (type: "retry") |
| Add config field | `src/types.ts` → `src/config.ts` → `src/plugin.ts` | Types first, then loading, then usage |
| Add fallback model param | `src/types.ts` FallbackModel + `src/plugin.ts` chat.params hook | Params go through chat.params, not prompt body |
| Add unit test | `src/__tests__/pure-functions.test.ts` | Import from module directly |
| Add integration test | `src/__tests__/plugin.test.ts` | Use createMockContext() from mocks.ts |

## CODE MAP
| Symbol | Type | Location | Role |
|--------|------|----------|------|
| `createPlugin` | function | plugin.ts:207 | Plugin entry — returns Hooks object |
| `classifyError` | function | decision.ts:6 | statusCode + isRetryable → immediate/retry/ignore |
| `findRetryPart` | function | plugin.ts:203 | Scans output.parts for type: "retry" |
| `handleRetry` | function | plugin.ts:118 | Abort → backoff → same-model retry → fallback chain |
| `handleImmediate` | function | plugin.ts:163 | Abort → cooldown → fallback chain (no retry) |
| `tryFallbackChain` | function | plugin.ts:81 | Iterates chain, skips cooldown models |
| `getFallbackChain` | function | config.ts:177 | Resolves agent-specific or default chain |
| `loadConfig` | function | config.ts:134 | Loads from disk, auto-creates if missing |
| `FallbackConfig` | interface | types.ts:20 | enabled, defaultFallback, agentFallbacks, cooldownMs, maxRetries, logging |
| `FallbackModel` | interface | types.ts:6 | providerID, modelID, variant, temperature, topP, etc. |
| `SessionState` | interface | types.ts:33 | fallbackActive, cooldownEndTime, backoffLevel |

## ERROR CLASSIFICATION PRIORITY
```
1. Cooldown active → ignore
2. HTTP 401/402/403 → immediate
3. isRetryable === true → retry
4. HTTP 429/500/502/503/504/529 → retry
5. Default → retry (unknown errors get backoff+retry)
```

## CONVENTIONS
- **Strict TS**: `"strict": true`, no `any` (3 exceptions for SDK type gaps)
- **No build**: `"noEmit": true` — plugin ships raw `.ts`
- **ESM only**: `"type": "module"`
- **Vitest**: zero-config, tests in `src/__tests__/*.test.ts`
- **Mock pattern**: `createMockContext(overrides?)` factory, `_forTesting` export for white-box access
- **Config auto-create**: `loadConfig()` writes default to `~/.config/opencode/fallback.json` if missing
- **Commit style**: Conventional Commits (`feat:`, `fix:`, `test:`, `ci:`)
- **Versioning**: `npm version patch --no-git-tag-version` → GitHub Actions release → npm publish

## ANTI-PATTERNS
- `as any` in 3 places: `(context.client as any).tui` (SDK gap), `messages as any` (inline type mismatch), `(part as any).synthetic` (missing property on MessagePart)
- `findRetryPart` returns `any` — SDK RetryPart type not available at compile time
- Synchronous `readFileSync/writeFileSync` in config.ts mixed with async `appendFile/mkdir` in log.ts
- Hardcoded await delays: 300ms (abort), 500ms (revert) — not configurable
- No CI quality gates: tests and typecheck not run before publish
- **DO NOT** use `as any` for new code — extend types instead

## COMMANDS
```bash
bun install            # Install deps (uses bun.lock)
tsc --noEmit           # TypeScript typecheck
bun vitest run         # Run all tests (58 tests, 4 files)
npm version patch --no-git-tag-version  # Bump version (CI handles release)
```

## NOTES
- `index.ts` re-exports `createPlugin` as `AutoFallbackPlugin` — downstream imports name it
- `session-state.ts` and `provider-state.ts` use module-level Maps — state lost on restart
- Fallback model params (temperature, reasoningEffort, etc.) go through `chat.params` hook, not `session.prompt` body
- `_forTesting` namespace exposes internal handlers for test access
- Toast API uses `(context.client as any).tui?.showToast()` — gracefully degrades if unavailable

# PROJECT KNOWLEDGE BASE

**Generated:** 2026-04-30
**Branch:** main

## OVERVIEW

OpenCode plugin that intercepts LLM error responses and automatically switches to a fallback model chain. Pure TypeScript, ESM, bundled with tsup — ships compiled JS via `dist/`.

## DIRECTORY GUIDE

```
opencode-auto-fallback/
├── src/
│   ├── config/          Types, loading, defaults, per-agent resolution
│   ├── core/            Business logic: error classification, fallback chains, large context switching
│   ├── state/           Runtime state: cooldown timers, model tracking, phase management (module-level Maps, lost on restart)
│   ├── hooks/           Event handlers dispatched by events.ts — one file per event type
│   ├── utils/           Shared utilities: logging, toast, session fetch, model comparison, update checker
│   ├── adapters/        SDK → domain type conversions (bridges SDK types to our simplified types)
│   └── __tests__/       Vitest tests — mocks.ts for createMockContext(), pure-functions.test.ts for unit tests, plugin.test.ts for integration
├── docs/
│   └── fallback.schema.json   JSON Schema for user config validation
├── dist/                Build output (tsup bundles src/ → dist/index.js, resolves @/ aliases)
├── tsup.config.ts       Build config
├── package.json
├── tsconfig.json
└── bun.lock
```

### src/config/

Config types and loading. `types.ts` defines all interfaces (`FallbackConfig`, `AgentConfig`, `FallbackModel`, etc.). `config.ts` handles loading from `~/.config/opencode/fallback.json`, auto-creating defaults, and resolving per-agent values via inheritance (`getFallbackChain`, `getAgentLargeContextModel`, `getAgentMinContextRatio`). `constants.ts` holds HTTP status code sets, backoff timing, and `DEFAULT_MIN_CONTEXT_RATIO`.

### src/core/

Business logic. `plugin.ts` is the entry point — `createPlugin()` sets up hooks and delegates to factory functions. `fallback.ts` handles error fallback (retry with backoff, immediate fallback, chain traversal). `large-context.ts` manages in-place model switching for large context — takes `ResolvedModel` directly. `decision.ts` classifies errors. `message.ts` extracts user messages from session history.

### src/state/

Runtime state using module-level Maps. `context-state.ts` is the central hub: fallback params, current/original model tracking, large context phase, registered agents, compaction targets. `session-state.ts` manages per-session cooldown and backoff levels. `provider-state.ts` manages per-model timed cooldown with auto-expiry.

### src/hooks/

Event handlers. `events.ts` routes events by type to individual handlers: `handle-session-idle.ts` (large context switch/return at 100% context), `handle-session-error.ts` (context overflow, error classification, primary large context trigger), `handle-session-status.ts` (rate limit detection, cooldown cleanup), `handle-session-compacted.ts` (continuation prompts), `handle-session-deleted.ts` (session cleanup).

### src/utils/

Shared utilities. `session-utils.ts` exports toast, abort, session data fetching, and shared types (`Logger`, `ChatMessageInput`, `ClientWithTui`). `log.ts` writes to `~/.local/share/opencode/log/`. `update-checker.ts` checks npm registry (respects `autoUpdate` config). `model.ts` has model comparison and formatting. `context.ts` checks context thresholds. `error.ts` parses and formats errors.

## CONFIG SCHEMA

New unified schema (post-v0.4.x). Old `agentFallbacks` and `largeContextFallback` fields are no longer recognized — `loadConfig()` only parses the new format.

### Inheritance

```
agents.<name>.fallback          → agent fallback chain + defaultFallback (deduped) — if agent has no explicit fallback, defaultFallback only
agents.<name>.largeContextModel → defaultLargeContextModel (false = disabled)
agents.<name>.minContextRatio   → defaultMinContextRatio (default 0.1)
```

### Registered Agents

An agent is "registered" for large context behavior when listed in `agents` map AND:
- It has its own `largeContextModel` (string), OR
- `defaultLargeContextModel` is set (string)

Setting `largeContextModel: false` explicitly opts out even if a default exists.

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
- Large context management uses in-place model switching — `handleLargeContextSwitch` takes a `ResolvedModel`, not a config object
- Large context switch triggers at 100% context usage: error handler is primary trigger, idle handler is safety net
- Per-agent config resolved via `getAgent*` functions with inheritance fallback to defaults
- `plugin.ts` is a thin orchestrator — business logic lives in `fallback.ts`, `large-context.ts`, and individual hook handlers
- Hook handlers are factory functions that capture config/logger/context in closure
- `@/` path aliases resolved at build time via tsup — plugin ships compiled `dist/index.js`

## CONVENTIONS

- **Strict TS**: `"strict": true`, zero `as any` — SDK type gaps handled via typed adapters
- **Build**: tsup bundles `src/` → `dist/`, resolves `@/` aliases at build time
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
bun run build          # Build with tsup → dist/
bun vitest run         # Run all tests (83 tests)
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
- `FallbackEntry` is `string | FallbackModelEntry` — string `"provider/model"` or `{ "model": "provider/model", "variant": "high" }` object
- `autoUpdate` defaults to `false` — users must opt in

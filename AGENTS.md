# PROJECT KNOWLEDGE BASE

## OVERVIEW

OpenCode plugin that intercepts LLM error responses and automatically switches to a fallback model chain. Pure TypeScript, ESM, bundled with tsup — ships compiled JS via `dist/`.

## DIRECTORY GUIDE

```
src/
├── config/       Types (types.ts), loading (config.ts), constants (constants.ts)
├── core/         plugin.ts (entry), fallback.ts, large-context.ts, decision.ts, message.ts
├── state/        Module-level Maps — lost on process restart
├── hooks/        events.ts routes to one handler file per event type
├── utils/        Logging, toast, session fetch, model comparison, update checker
├── adapters/     sdk-adapter.ts — SDK types → domain types
└── __tests__/    mocks.ts, *.test.ts
docs/fallback.schema.json   JSON Schema for user config
```

## COMMANDS

```bash
bun install                     # deps (bun.lock)
tsc --noEmit                    # typecheck only
bun run build                   # tsup → dist/
bun vitest run                  # all tests
bun vitest run src/__tests__/pure-functions.test.ts  # single test file
bun run check                   # typecheck + lint + format check (runs all three)
npm version patch --no-git-tag-version  # bump (CI auto-publishes on push to main)
```

## CONVENTIONS

- **Strict TS**: `strict: true`, ESLint enforces `no-explicit-any`, `no-non-null-assertion`, `explicit-function-return-type`
- **ESM only**: `"type": "module"`, tsup outputs ESM
- **`@/` alias**: resolved by tsup at build time, not at runtime
- **Import order**: builtin → external → internal (`@/`, `~/`) → parent → sibling → index. Enforced by ESLint. Newline between each group, alphabetized.
- **Consistent type imports**: `import type { X } from ...` required (separate-type-imports)
- **Prettier**: double quotes, semicolons, trailing commas, 100 char width, 2-space indent
- **No `console.log`**: ESLint `no-console: error` — use the logger from `utils/log.ts`
- **Commit style**: Conventional Commits (`feat:`, `fix:`, `test:`, `ci:`) — English messages
- **Versioning**: `npm version patch --no-git-tag-version` → push to main → GitHub Actions publishes to npm
- **Config auto-create**: `loadConfig()` writes default `~/.config/opencode/fallback.json` if missing

## ARCHITECTURE

- **Entry**: `src/index.ts` re-exports `createPlugin` as `AutoFallbackPlugin` (named) and `default`
- **Plugin**: `core/plugin.ts` — `createPlugin()` registers hooks, delegates to factory functions
- **Hooks**: Factory functions that capture config/logger/context in closure. `events.ts` dispatches by event type.
- **State**: Module-level Maps in `state/` — no persistence, lost on restart
- **Adapters**: `sdk-adapter.ts` bridges SDK types to simplified domain types
- **Large context**: In-place model switching via `ResolvedModel` — triggers at 100% context usage
- **Fallback params**: Temperature, reasoningEffort etc. go through `chat.params` hook, not `session.prompt` body

## CONFIG SCHEMA (post-v0.4.x)

Old `agentFallbacks`/`largeContextFallback` fields ignored — `loadConfig()` only parses new format.

### Inheritance

```
agents.<name>.fallback          → agent chain + defaultFallback (deduped)
agents.<name>.largeContextModel → defaultLargeContextModel (false = disabled)
agents.<name>.minContextRatio   → defaultMinContextRatio (default 0.1)
```

### Agent Registration

Agent is "registered" for large context when listed in `agents` AND has `largeContextModel` (string) or `defaultLargeContextModel` is set. `largeContextModel: false` explicitly opts out.

### Agent Name Matching

Names normalized: whitespace/zero-width chars stripped, then lowercased.

## ERROR CLASSIFICATION PRIORITY

```
1. Cooldown active → ignore
2. HTTP 401/402/403 → immediate fallback
3. isRetryable === true → retry with backoff
4. isRetryable === false → immediate fallback (skip retry)
5. HTTP 429/500/502/503/504/529 → retry with backoff
6. Default → retry (safety net)
```

`isRetryable` from SDK `ApiError.data.isRetryable` is the primary signal. Status code heuristics used only when `isRetryable` is `undefined`.

## TESTING

- **Framework**: Vitest with `tsconfigPaths: true` — no additional config needed
- **Mock pattern**: `createMockContext(overrides?)` in `mocks.ts`
- **Direct imports**: Tests import from source modules — no `_forTesting` indirection
- **Test files**: `context.test.ts`, `error-classification.test.ts`, `plugin.test.ts`, `provider-state.test.ts`, `pure-functions.test.ts`
- **Test ESLint**: Relaxed rules for `src/__tests__/` — `no-unsafe-*`, `explicit-function-return-type`, `no-non-null-assertion` off

## CI

- **Publish**: GitHub Actions on push to main when `package.json` changes. Runs `bun install && bun run build && npm publish` with provenance.
- **No quality gates**: typecheck/lint/test not run in CI before publish

## KEY TYPES

- `FallbackEntry`: `string | FallbackModelEntry` — `"provider/model"` or `{ "model": "provider/model", "variant": "high" }`
- `ResolvedModel`: `{ providerID, modelID, variant? }` — used by large context switching
- `FallbackConfig`, `AgentConfig`, `FallbackModel`, `FallbackModelEntry`: defined in `config/types.ts`

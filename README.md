# opencode-auto-fallback

OpenCode plugin that automatically detects model errors and switches to a fallback model chain — with intelligent retry backoff for transient failures.

## Features

- **Two-tier classification**: immediate fallback for auth errors, exponential backoff retry for rate limits and transient failures — detected via structured SDK error types, not text matching
- **Unified agent config**: per-agent fallback chains, large context models, and thresholds in a single `agents` map with inheritance
- **Per-model timed cooldown**: failed models are skipped until cooldown expires
- **Default‑retry safety net**: any unrecognized error is treated as retryable
- **Zero config startup**: auto-generates `fallback.json` with sensible defaults on first run
- **Toast notifications**: terminal toasts when fallback is triggered
- **Large context fallback**: automatically switches to a larger context model in-place when context fills up, then switches back after compaction with structured context preservation
- **Auto-update toggle**: optional automatic update checks on startup (disabled by default)

## Installation

### 1. Register in opencode config

Add `"opencode-auto-fallback"` to the `plugin` array in `~/.config/opencode/opencode.json`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-auto-fallback"],
}
```

### 2. Configuration

On first run, a default config is auto-created at `~/.config/opencode/fallback.json`. All features are **disabled by default** — set `enabled: true` to activate the plugin.

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/HyeokjaeLee/opencode-auto-fallback/main/docs/fallback.schema.json",
  "enabled": true,
  "autoUpdate": false,
  "defaultFallback": ["anthropic/claude-opus-4-7"],
  "defaultLargeContextModel": false,
  "defaultMinContextRatio": 0.1,
  "agents": {
    "reviewer": {
      "fallback": ["zai-coding-plan/glm-5.1"]
    },
    "Sisyphus - Ultraworker": {
      "fallback": [
        "opencode-go/deepseek-v4-pro",
        { "model": "openai/gpt-5.5", "temperature": 0.5 }
      ],
      "largeContextModel": "google/gemini-2.5-pro",
      "minContextRatio": 0.15
    },
    "explore": {
      "fallback": ["anthropic/claude-sonnet-4"],
      "largeContextModel": false
    }
  },
  "cooldownMs": 60000,
  "maxRetries": 2,
  "logging": false
}
```

### Field Reference

#### Top-level fields

| Field                      | Type                | Default   | Description                                                                                                                                                  |
| -------------------------- | ------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `enabled`                  | `boolean`           | `false`   | Enable/disable the plugin. Must be `true` for any behavior to work.                                                                                          |
| `autoUpdate`               | `boolean`           | `false`   | Automatically check for plugin updates on startup and install them. When `false`, updates must be done manually.                                             |
| `defaultFallback`          | `FallbackEntry[]`   | `[]`      | Fallback model chain used by agents that don't define their own `fallback`. When empty, only agents with an explicit `fallback` field trigger fallback.      |
| `defaultLargeContextModel` | `string \| false`   | `false`   | Model to switch to when an agent's context window fills up. Inherited by agents without their own `largeContextModel`. Set `false` to disable by default.    |
| `defaultMinContextRatio`   | `number`            | `0.1`     | Minimum fractional increase in context window required to trigger large context fallback (default 10%). Inherited by agents without their own value.        |
| `agents`                   | `Record<string, AgentConfig>` | `{}` | Per-agent configuration. Key is agent name (matched case-insensitively, whitespace ignored). See [Agent Config](#agent-config) below.                        |
| `cooldownMs`               | `number`            | `60000`   | Cooldown duration in milliseconds after immediate fallback. Prevents rapid re-triggering on the same model.                                                  |
| `maxRetries`               | `number`            | `2`       | Maximum backoff retry attempts before switching to the fallback chain. Exponential: 2s → 4s → 8s….                                                           |
| `logging`                  | `boolean`           | `false`   | Enable file-based logging to `~/.local/share/opencode/log/fallback.log`.                                                                                     |

#### Agent Config

Each entry in the `agents` map configures behavior for a specific agent. All fields are optional — omitted fields inherit from the top-level defaults.

| Field               | Type                | Inherited From          | Description                                                                                                         |
| ------------------- | ------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `fallback`          | `FallbackEntry[]`   | `defaultFallback`       | Fallback model chain for this agent. Overrides `defaultFallback` when set.                                          |
| `largeContextModel` | `string \| false`   | `defaultLargeContextModel` | Model to switch to when this agent's context fills up. Set `false` to explicitly disable even if a default exists. |
| `minContextRatio`   | `number`            | `defaultMinContextRatio` | Minimum context window increase ratio for this agent. Overrides the default.                                        |

**Inheritance rule**: per-agent field → top-level default → `false`/empty.

#### Fallback Entry

Each entry in a fallback chain can be a simple string or an object with `model` key:

```jsonc
// Simple — provider/model format
"openai/gpt-5.5"

// With parameters — uses same "model" key
{
  "model": "openai/gpt-5.5",
  "variant": "high",
  "temperature": 0.5,
  "reasoningEffort": "medium",
  "maxTokens": 8192,
  "thinking": { "type": "enabled", "budgetTokens": 4096 }
}
```

| Field              | Type     | Description                                          |
| ------------------ | -------- | ---------------------------------------------------- |
| `model`            | `string` | Provider/model identifier (e.g. `openai/gpt-5.5`)   |
| `variant`          | `string` | Model variant (e.g. `high`, `medium`, `low`)         |
| `reasoningEffort`  | `string` | `none`, `minimal`, `low`, `medium`, `high`, `xhigh`  |
| `temperature`      | `number` | Generation temperature (0–2)                         |
| `topP`             | `number` | Top-p sampling (0–1)                                 |
| `maxTokens`        | `number` | Maximum output tokens                                |
| `thinking.type`    | `string` | `enabled` or `disabled`                              |
| `thinking.budgetTokens` | `number` | Token budget for thinking                       |

### Agent Name Matching

Agent names in the `agents` map are matched **after normalization**: whitespace and zero-width characters are stripped, then lowercased.

```jsonc
// These all match the same agent:
"Sisyphus - Ultraworker"  // original display name
"sisyphus-ultraworker"    // normalized

// This does NOT match — it's a different string:
"sisyphus"  // won't match "Sisyphus - Ultraworker"
```

When using agents from `oh-my-openagent`, use the name as it appears in OpenCode session logs.

### Auto Updates

When `autoUpdate: true`, the plugin checks for updates on every startup:

```
opencode starts → check npm registry → newer version? → bun/npm update → done
```

If the update fails, a toast notification appears with the manual update command: `bun update opencode-auto-fallback`.

### Large Context Fallback

When a registered agent's context window fills up mid-task, the plugin automatically switches to a larger context model in the same session, continues work, then switches back after compaction. The switch triggers at **100% context usage** — the error handler catches the context overflow and switches immediately. The idle handler also checks at 100% as a safety net.

**Setup**: Set `defaultLargeContextModel` or per-agent `largeContextModel` to a model with a larger context window than the agent's default model.

```jsonc
{
  "enabled": true,
  "defaultLargeContextModel": "openai/gpt-5.5",
  "agents": {
    // Inherits defaultLargeContextModel
    "Sisyphus - Ultraworker": {
      "fallback": ["opencode-go/deepseek-v4-pro"]
    },
    // Uses its own large context model
    "hephaestus - deepagent": {
      "largeContextModel": "google/gemini-2.5-pro"
    },
    // Explicitly disabled — no large context fallback
    "explore": {
      "largeContextModel": false
    }
  }
}
```

**Flow:**

```
original model working → context full → auto compact triggered
    → plugin switches model in-place to the large context model
    → session continues on large model (auto-continue enabled)
    → work completes → session compacts with context preservation
    → plugin switches back to original model
    → session continues with compacted context on original model
```

The `defaultMinContextRatio` (default `0.1` = 10%) prevents switching when the large model's context window is barely bigger than the current model's. For example, if the current model has 100K context and the large model has 105K, the 5% increase is below the 10% threshold — the overflow error is handled normally instead of switching models.

> **Note:** Manual `/compact` commands do **not** trigger large context fallback — only automatic compaction (when context fills up from an assistant response) activates it.

#### Behavior Details

- **In-Place Model Switch**: When compaction triggers, the plugin switches the model within the same session.
- **Auto-Continue Enabled**: Auto-continue is explicitly enabled during large context phases (`active`/`summarizing`) so the session keeps working.
- **Self-Compaction**: If the large model itself fills up, the plugin triggers self-compaction on the large model to preserve context.
- **Switch-Back via Compaction**: When work completes, the session compacts with the original model's context limit as guidance, then switches back.
- **Cooldown Safety**: If the large context model is in cooldown (e.g., from a previous error), the fallback is skipped and normal compaction proceeds.

## How It Works

### Error Classification

The plugin detects errors through `session.error` events (structured `statusCode` and `isRetryable` flags) and `session.status` events (message-based pattern matching for rate limits and transient errors).

| Error type                  | Detection                                            | Action                                            |
| --------------------------- | ---------------------------------------------------- | ------------------------------------------------- |
| **HTTP 401/402/403** (auth) | Status code in `IMMEDIATE_STATUS_CODES`              | Immediate fallback                                |
| **Retryable errors**        | `isRetryable === true` from SDK                      | Backoff retry (2s → 4s → 8s…) then fallback       |
| **HTTP 429/5xx**            | Status code in `RETRYABLE_STATUS_CODES`              | Backoff retry then fallback                       |
| **Permanent rate limit**    | Text patterns: "usage limit", "quota exceeded", etc. | Immediate fallback                                |
| **Transient errors**        | Text patterns: "rate limit", "overloaded", etc.      | Allow SDK retry up to `maxRetries`, then fallback |
| **Unknown errors**          | Default classification                               | Backoff retry then fallback _(safety net)_        |

### Retry Flow

With the default `maxRetries: 2`:

```
1st failure → abort → wait 2s   → re-prompt with SAME model
2nd failure → abort → wait 4s   → re-prompt with SAME model
3rd failure → FALLBACK CHAIN: try next model in ordered list
```

Immediate fallback errors (quota, auth) skip retries entirely and go straight to the fallback chain.

### Fallback Chain

The plugin tries each model in the chain sequentially. Models in cooldown are automatically skipped. If all models are exhausted, the error is logged and a critical toast is shown.

### Compatibility with Other Fallback Plugins

If another plugin with model fallback logic is installed alongside this one, place **`opencode-auto-fallback` first** in the plugin array. The first plugin in the list processes the model response first — by placing this plugin first, it intercepts the error before other fallback plugins see it.

```jsonc
// ✅ opencode-auto-fallback handles errors first
"plugin": ["opencode-auto-fallback", "other-fallback-plugin"]

// ❌ Other plugin may interfere
"plugin": ["other-fallback-plugin", "opencode-auto-fallback"]
```

## Development

```bash
# Install dependencies
bun install

# Type check
tsc --noEmit

# Build (tsup → dist/)
bun run build

# Run tests (73 tests)
bun vitest run

# Bump version (CI auto-publishes)
npm version patch --no-git-tag-version
git push
```

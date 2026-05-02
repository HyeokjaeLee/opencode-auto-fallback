# opencode-auto-fallback

OpenCode plugin that automatically detects model errors and switches to a fallback model chain — with intelligent retry backoff for transient failures.

## Features

- **Two-tier classification**: immediate fallback for auth errors, exponential backoff retry for rate limits and transient failures — detected via structured SDK error types, not text matching
- **Fallback chain**: ordered list of fallback models per agent, with variant/reasoning/temperature support
- **Per-model timed cooldown**: failed models are skipped until cooldown expires
- **Default‑retry safety net**: any unrecognized error is treated as retryable
- **Zero config startup**: auto-generates `fallback.json` with sensible defaults on first run
- **Toast notifications**: terminal toasts when fallback is triggered
- **Large context fallback**: automatically switches to a larger context model in-place when context fills up, then switches back after compaction with structured context preservation

## Installation

### 1. Register in opencode config

Add `"opencode-auto-fallback"` to the `plugin` array in `~/.config/opencode/opencode.json`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-auto-fallback"],
}
```

### 2. Configuration (optional)

On first run, a default config is auto-created at `~/.config/opencode/fallback.json`. You can customize it:

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/HyeokjaeLee/opencode-auto-fallback/main/docs/fallback.schema.json",
  "enabled": true,
  "defaultFallback": ["anthropic/claude-opus-4-7"],
  "agentFallbacks": {
    "reviewer": [
      "zai-coding-plan/glm-5.1",
      {
        "model": "openai/gpt-5.5",
        "temperature": 0.5,
        "reasoningEffort": "medium",
      },
    ],
  },
  "cooldownMs": 60000,
  "maxRetries": 2,
  "logging": false,
}
```

| Field             | Default  | Description                                                                                                                                         |
| ----------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`         | `true`   | Enable/disable the plugin                                                                                                                           |
| `defaultFallback` | _(none)_ | Fallback model chain when agent has no specific override. **Optional** — when omitted, only agents listed in `agentFallbacks` will trigger fallback |
| `agentFallbacks`  | `{}`     | Per-agent fallback chains (`"agentName": ["model", ...]`)                                                                                           |
| `cooldownMs`      | `60000`  | Cooldown after immediate fallback (prevents rapid re-triggering)                                                                                    |
| `maxRetries`      | `2`      | Backoff retry attempts before switching to fallback chain                                                                                           |
| `logging`         | `false`  | Enable file-based logging to `~/.local/share/opencode/log/fallback.log`                                                                             |

#### Using with oh-my-openagent

When an agent is provided by `oh-my-openagent`, the runtime agent name can differ from the key in `oh-my-openagent.json`. Configure fallback with the name that appears in OpenCode session logs, normalized by removing whitespace and ignoring case.

For example, if logs show `agent=Sisyphus - Ultraworker`, configure it as `Sisyphus - Ultraworker` (whitespace is stripped, case is ignored):

```jsonc
{
  "agentFallbacks": {
    "Sisyphus - Ultraworker": [
      {
        "model": "opencode-go/deepseek-v4-pro",
        "variant": "high",
      },
    ],
    "hephaestus - deepagent": ["zai-coding-plan/glm-5.1"],
  },
  "largeContextFallback": {
    "agents": ["Sisyphus - Ultraworker", "hephaestus - deepagent"],
    "model": "opencode-go/deepseek-v4-pro",
  },
}
```

Agent matching is exact after normalization: `Sisyphus - Ultraworker` and `sisyphus - ultraworker` match the same entry, but `sisyphus` does not automatically match `Sisyphus - Ultraworker`.

### Auto Updates

The plugin checks for updates on every startup and installs them automatically — no manual intervention needed.

```
opencode starts → check npm registry → newer version? → bun/npm update → done
```

If the auto-update fails for any reason, a toast notification appears with the manual update command.

### Large Context Fallback

When an agent's context window fills up mid-task, automatically switch to a larger context model in the same session to continue work without losing context. After the work completes, the session compacts and switches back to the original model.

```jsonc
{
  "largeContextFallback": {
    "agents": ["sisyphus", "explore"],
    "model": "openai/gpt-5.5",
    // Optional: minimum ratio difference required to trigger fallback
    "minContextRatio": 0.1,
  },
}
```

| Field             | Description                                                                             |
| ----------------- | --------------------------------------------------------------------------------------- |
| `agents`          | List of agent names to apply this behavior to                                           |
| `model`           | Model to switch to when context fills up                                                |
| `minContextRatio` | Minimum fractional increase in context window to trigger fallback (default `0.1` = 10%) |

The plugin reads context window sizes from the SDK's model metadata automatically (`input.model.limit.context`). When both the current model and the large fallback model have been used in the session, their limits are known and the 10% ratio check is applied. If the large model hasn't been used yet (first compact), its limit is unknown and the fallback proceeds without the ratio check.

**Flow:**

```
original model working → context full → auto compact triggered
    → plugin switches model in-place to the large context model
    → session continues on large model (auto-continue enabled)
    → work completes → session compacts with context preservation
    → plugin switches back to original model
    → session continues with compacted context on original model
```

> **Note:** Manual `/compact` commands do **not** trigger large context fallback — only automatic compaction (when context fills up from an assistant response) activates it.

#### Behavior Details

- **In-Place Model Switch**: When compaction triggers, the plugin switches the model within the same session.
- **Auto-Continue Enabled**: Auto-continue is explicitly enabled during large context phases (`active`/`summarizing`) so the session keeps working.
- **Self-Compaction**: If the large model itself fills up, the plugin triggers self-compaction on the large model to preserve context.
- **Switch-Back via Compaction**: When work completes, the session compacts with the original model's context limit as guidance, then switches back.
- **Cooldown Safety**: If the large context model is in cooldown (e.g., from a previous error), the fallback is skipped and normal compaction proceeds.

#### Fallback Model Entry

Each entry in a fallback chain can be a simple string or an object:

```jsonc
// Simple
"openai/gpt-5.5"

// With options
{
  "model": "openai/gpt-5.5",
  "variant": "high",
  "temperature": 0.5,
  "reasoningEffort": "medium",
  "maxTokens": 8192
}
```

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

# Run tests (71 tests)
bun vitest run

# Bump version (CI auto-publishes)
npm version patch --no-git-tag-version
git push
```

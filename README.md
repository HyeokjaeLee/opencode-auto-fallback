# opencode-auto-fallback

OpenCode plugin that automatically detects model errors and switches to a fallback model chain — with intelligent retry backoff for transient failures.

## Features

- **Two-tier classification**: immediate fallback for quota/auth errors, exponential backoff retry for rate limits and transient failures
- **Fallback chain**: ordered list of fallback models per agent, with variant/reasoning/temperature support
- **Per-model timed cooldown**: failed models are skipped until cooldown expires
- **Default‑retry safety net**: any unrecognized error is treated as retryable
- **Zero config startup**: auto-generates `fallback.json` with sensible defaults on first run
- **Toast notifications**: terminal toasts when fallback is triggered

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
  "$schema": "https://raw.githubusercontent.com/HyeokjaeLee/opencode-auto-fallback/main/src/fallback.schema.json",
  "enabled": true,
  "defaultFallback": ["anthropic/claude-opus-4-5"],
  "agentFallbacks": {
    "oracle": [
      "openai/gpt-5.5",
      { "model": "zai-coding-plan/glm-5.1", "variant": "high" }
    ]
  },
  "cooldownMs": 60000,
  "maxRetries": 3,
  "logging": false,
}
```

| Field             | Default              | Description                                                              |
| ----------------- | -------------------- | ------------------------------------------------------------------------ |
| `enabled`         | `true`               | Enable/disable the plugin                                                |
| `defaultFallback` | `["openai/gpt-5.4"]` | Fallback model chain when agent has no specific override                 |
| `agentFallbacks`  | `{}`                 | Per-agent fallback chains (`"agentName": ["model", ...]`)                |
| `cooldownMs`      | `60000`              | Cooldown after immediate fallback (prevents rapid re-triggering)         |
| `maxRetries`      | `3`                  | Backoff retry attempts before switching to fallback chain                |
| `logging`         | `false`              | Enable file-based logging to `~/.local/share/opencode/logs/fallback.log` |

#### Fallback Model Entry

Each entry in a fallback chain can be a simple string or an object:

```jsonc
// Simple
"openai/gpt-5.4"

// With options
{
  "model": "openai/gpt-5.4",
  "variant": "high",
  "temperature": 0.5,
  "reasoningEffort": "medium",
  "maxTokens": 8192
}
```

## How It Works

### Error Classification

| Error type                  | Action                                      |
| --------------------------- | ------------------------------------------- |
| **HTTP 401/403** (auth)     | Immediate fallback                          |
| **Quota exceeded, billing** | Immediate fallback                          |
| **Model not found**         | Immediate fallback                          |
| **HTTP 429** (rate limit)   | Backoff retry (2s → 4s → 8s…) then fallback |
| **HTTP 5xx**                | Backoff retry then fallback                 |
| **Overloaded, unavailable** | Backoff retry then fallback                 |
| **Unknown errors**          | Backoff retry then fallback _(safety net)_  |

### Retry Flow

```
1st failure → abort → wait 2s   → re-prompt with SAME model
2nd failure → abort → wait 4s   → re-prompt with SAME model
3rd failure → abort → wait 8s   → re-prompt with SAME model
4th failure → FALLBACK CHAIN: try next model in ordered list
```

Immediate fallback errors (quota, auth) skip retries entirely and go straight to the fallback chain.

### Fallback Chain

The plugin tries each model in the chain sequentially. Models in cooldown are automatically skipped. If all models are exhausted, the error is logged and a critical toast is shown.

## Development

```bash
# Install dependencies
bun install

# Type check
tsc --noEmit

# Run tests (64 tests)
bun vitest run

# Bump version (CI auto-publishes)
npm version patch --no-git-tag-version
git push
```

## License

MIT

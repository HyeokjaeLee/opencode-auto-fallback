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

| Field             | Default              | Description                                                              |
| ----------------- | -------------------- | ------------------------------------------------------------------------ |
| `enabled`         | `true`               | Enable/disable the plugin                                                |
| `defaultFallback` | _(none)_             | Fallback model chain when agent has no specific override. **Optional** — when omitted, only agents listed in `agentFallbacks` will trigger fallback |
| `agentFallbacks`  | `{}`                 | Per-agent fallback chains (`"agentName": ["model", ...]`)                |
| `cooldownMs`      | `60000`              | Cooldown after immediate fallback (prevents rapid re-triggering)         |
| `maxRetries`      | `2`                  | Backoff retry attempts before switching to fallback chain                |
| `logging`         | `false`              | Enable file-based logging to `~/.local/share/opencode/log/fallback.log` |

### Auto Updates

The plugin checks for updates on every startup and installs them automatically — no manual intervention needed.

```
opencode starts → check npm registry → newer version? → bun/npm update → done
```

If the auto-update fails for any reason, a toast notification appears with the manual update command.

### Large Context Fallback

When an agent's context window fills up mid-task, automatically switch to a larger model to finish the work without interruption. After the task completes and the large model compacts, switch back to the original model with the compacted context.

```jsonc
{
  "largeContextFallback": {
    "agents": ["sisyphus", "explore"],
    "model": "openai/gpt-5.5"
  }
}
```

| Field | Description |
|-------|-------------|
| `agents` | List of agent names to apply this behavior to |
| `model` | Model to switch to when context fills up |

**Flow:**
```
original model working → context full (auto compact) → switch to large model
    → large model finishes task → idle → large model compacts
    → switch back to original model (compacted context)
```

> **Note:** Manual `/compact` commands do **not** trigger large context fallback — only automatic compaction (when context fills up from an assistant response) activates it.

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

# Run tests (67 tests)
bun vitest run

# Bump version (CI auto-publishes)
npm version patch --no-git-tag-version
git push
```

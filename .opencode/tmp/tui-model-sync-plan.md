# TUI Model Sync Implementation Plan

## Problem
Fallback (large-context included) changes request model but TUI input field shows original model.

## Root Cause
No TUI sync mechanism in plugin. Request model changed via `session.summarize()` but `output.message.model` not mutated.

## Solution: oh-my-openagent Pattern

### Key Finding
oh-my-openagent mutates `output.message.model` in `chat.message` hook. SDK reads this before API call.

```typescript
// chat-message-fallback-handler.ts
output.message["model"] = { providerID: fallback.providerID, modelID: fallback.modelID }
```

### Implementation

1. **Add `chat.message` hook** to `src/core/plugin.ts`
   - Register hook after `chat.params` hook
   - Check for active fallback in session state
   - Mutate `output.message.model` if fallback active

2. **Update session title** with fallback suffix
   - Use `ctx.client.session.update({ body: { title: "..." } })`
   - Append `[fallback: provider/model]` to session title

3. **Track fallback state** in `context-state.ts`
   - Add `setActiveFallbackModel(sessionID, providerID, modelID)`
   - Add `getActiveFallbackModel(sessionID)`
   - Clear fallback on session completion

## Files to Modify

1. `src/core/plugin.ts` - Add `chat.message` hook registration
2. `src/core/fallback.ts` - Set active fallback state
3. `src/core/large-context.ts` - Set active fallback state
4. `src/state/context-state.ts` - Add fallback model tracking
5. `src/utils/session-utils.ts` - Add session title update helper

## Code Pattern

```typescript
// plugin.ts
"chat.message": async (input, output) => {
  const fallback = getActiveFallbackModel(input.sessionID)
  if (fallback) {
    output.message.model = {
      providerID: fallback.providerID,
      modelID: fallback.modelID,
      ...(fallback.variant && { variant: fallback.variant })
    }
  }
}
```

## OpenCode TUI Architecture Notes

- **No explicit model-sync mechanism**: Status bar reads `config.Get()` live on every frame
- **Model selection**: User changes model via `ctrl+o` → `agent.Update()` → `config.UpdateAgentModel()` → global config mutation
- **Plugin cannot mutate config directly**: Must use `output.message.model` to override per-message model
- **Session title**: Can be updated via `ctx.client.session.update({ body: { title } })`

## References

- oh-my-openagent: `src/hooks/model-fallback/chat-message-fallback-handler.ts`
- oh-my-openagent: `src/plugin/hooks/create-session-hooks.ts` (title update)
- OpenCode TUI: `internal/tui/components/core/status.go` (model display)
- OpenCode TUI: `internal/config/config.go` (global config)
# Agent Code

Agent Code is an Electron desktop client for the installed `codex` CLI. It does not implement its own agent runtime; it starts `codex app-server --listen stdio://` and renders the app-server protocol in a desktop UI.

## Architecture

- `electron/main.ts` owns the Codex app-server process and exposes a narrow IPC bridge.
- `electron/preload.ts` publishes the renderer-safe `window.codex` API.
- `src/store/useCodexStore.ts` normalizes app-server notifications and requests into UI state.
- `src/App.tsx` renders the workspace, project/thread navigation, transcript, approvals, and composer.
- `src/shared/protocol` contains generated TypeScript bindings from `codex app-server generate-ts`.

## Protocol Notes

- Tool activity is not only plain assistant text. The app-server emits first-class `ThreadItem`s such as `commandExecution`, `fileChange`, `mcpToolCall`, `dynamicToolCall`, `collabAgentToolCall`, `webSearch`, `imageView`, and `imageGeneration`.
- Dynamic tools are special: the server emits `item/started` with `item.type = "dynamicToolCall"`, then sends an `item/tool/call` server request, then later emits `item/completed` with final output.
- `rawResponseItem/completed` can also surface lower-level response items like `function_call`, `custom_tool_call`, `local_shell_call`, `web_search_call`, and `image_generation_call`.
- `item/fileChange/outputDelta`, `item/commandExecution/outputDelta`, `item/mcpToolCall/progress`, and reasoning delta notifications are incremental streams that should update existing transcript rows instead of creating unrelated message bubbles.

## History Loading

- `thread/resume` can be lossy for persisted tool activity.
- For authoritative history rendering, use `thread/read` with `includeTurns: true` and rebuild transcript state from `thread.turns`.
- `persistExtendedHistory: true` should be enabled on `thread/start` and `thread/resume` so richer history is available later.
- `thread/read` can fail with `includeTurns` before the first user message exists on a brand-new thread; callers should tolerate that case.

## UI Guidance

- The transcript should render typed items, not flatten everything into text.
- Agent messages should support Markdown.
- Tool rows should stay compact in the main timeline, with expandable detail for arguments, output, diffs, and metadata.
- Project/thread navigation is project-scoped in the sidebar.

## Working Rules

- Use `gh` CLI for GitHub operations.
- Use `apply_patch` for source edits.
- Regenerate protocol bindings with `npm run codegen:protocol` if the local Codex binary changes schema.

# Agent Code

Agent Code is an Electron desktop client for the installed `codex` CLI. It uses `codex app-server --listen stdio://` as the backend and renders Codex threads, tool activity, approvals, and Markdown-rich agent output in a native desktop shell.

## What It Supports

- project-grouped threads in the sidebar
- compact transcript rendering for messages, tool calls, diffs, file edits, and command execution
- Markdown rendering for agent and user text
- command, file, and permission approval flows
- model selection plus reasoning effort selection when supported by the active model
- persisted thread history reloaded from Codex app-server

## Requirements

- macOS or Linux desktop
- `codex` installed and available on `PATH`
- an authenticated Codex installation
- Node.js 22+

Install Codex CLI from the official docs: [developers.openai.com/codex/cli](https://developers.openai.com/codex/cli)

If you need a custom Codex binary path during development:

```bash
CODEX_BIN=/path/to/codex npm run dev
```

## Development

```bash
npm install
npm run codegen:protocol
npm run dev
```

Build the app:

```bash
npm run build
```

Lint:

```bash
npm run lint
```

## Architecture

- `electron/main.ts` starts and manages the Codex app-server process and exposes IPC methods to the renderer.
- `electron/preload.ts` publishes the `window.codex` bridge.
- `src/store/useCodexStore.ts` translates app-server notifications and requests into renderer state.
- `src/App.tsx` renders the desktop UI.
- `src/shared/protocol` contains generated TypeScript protocol bindings from the local Codex binary.

## Notes

- Tool activity is modeled as first-class items from Codex app-server, not as plain text messages.
- For richer persisted history, Agent Code reloads thread timelines with `thread/read` and `includeTurns: true`.
- The UI is intentionally opinionated around a single active project/thread workspace rather than a browser-style multi-pane client.

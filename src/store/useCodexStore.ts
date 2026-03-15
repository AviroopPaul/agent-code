import { create } from 'zustand';

import type { BackendStartResponse, CodexBridgeEvent } from '../shared/bridge';
import type { ReasoningEffort } from '../shared/protocol/ReasoningEffort';
import type { ResponseItem } from '../shared/protocol/ResponseItem';
import type { ServerNotification } from '../shared/protocol/ServerNotification';
import type { ServerRequest } from '../shared/protocol/ServerRequest';
import type { ThreadItem } from '../shared/protocol/v2/ThreadItem';
import type { AskForApproval } from '../shared/protocol/v2/AskForApproval';
import type { SandboxPolicy } from '../shared/protocol/v2/SandboxPolicy';
import type { ThreadReadResponse } from '../shared/protocol/v2/ThreadReadResponse';
import type { ThreadResumeResponse } from '../shared/protocol/v2/ThreadResumeResponse';
import type { ThreadStartResponse } from '../shared/protocol/v2/ThreadStartResponse';
import type { ThreadStatus } from '../shared/protocol/v2/ThreadStatus';
import type { TurnStartResponse } from '../shared/protocol/v2/TurnStartResponse';

export type TranscriptEntry = {
  id: string;
  kind: ThreadItem['type'] | 'rawResponseItem' | 'system';
  title: string;
  body: string;
  status?: string | null;
  caption?: string;
  rawItem?: ThreadItem | ResponseItem;
};

export type PendingApproval = {
  [Method in ServerRequest['method']]: Extract<ServerRequest, { method: Method }> & {
    createdAt: number;
  };
}[ServerRequest['method']];

// ---------------------------------------------------------------------------
// Per-thread state — everything that belongs to a single conversation
// ---------------------------------------------------------------------------
export type PerThreadState = {
  transcript: Record<string, TranscriptEntry>;
  transcriptOrder: string[];
  currentTurnId: string | null;
  turnStatus: string;
  latestDiff: string;
  approvals: PendingApproval[];
  threadName: string;
};

export const EMPTY_THREAD_STATE: PerThreadState = {
  transcript: {},
  transcriptOrder: [],
  currentTurnId: null,
  turnStatus: 'idle',
  latestDiff: '',
  approvals: [],
  threadName: 'New chat',
};

function freshThreadState(name = 'New chat'): PerThreadState {
  return { ...EMPTY_THREAD_STATE, threadName: name };
}

// ---------------------------------------------------------------------------
// Global store shape
// ---------------------------------------------------------------------------
type BackendState = {
  connected: boolean;
  userAgent?: string;
  codexBin?: string;
  error?: string;
};

type StoreState = {
  // Backend / model (global)
  backend: BackendState;
  models: BackendStartResponse['models'];
  selectedModel: string | null;
  selectedEffort: ReasoningEffort | null;
  logs: string[];

  // Session (global)
  workspacePath: string;
  threadId: string | null;          // active thread
  approvalPolicy: AskForApproval | null;
  sandboxPolicy: SandboxPolicy | null;

  // Per-thread state keyed by threadId
  threadStates: Record<string, PerThreadState>;

  // Actions
  setWorkspace: (path: string) => void;
  setSelectedModel: (model: string | null) => void;
  setSelectedEffort: (effort: ReasoningEffort | null) => void;
  startBackend: (payload: BackendStartResponse) => void;
  handleBridgeEvent: (event: CodexBridgeEvent) => void;
  createSession: (workspacePath: string, response: ThreadStartResponse) => void;
  resumeSession: (workspacePath: string, response: ThreadResumeResponse) => void;
  replaceTranscript: (threadId: string, response: ThreadReadResponse) => void;
  beginTurn: (threadId: string, response: TurnStartResponse) => void;
  clearApproval: (threadId: string, id: string | number) => void;
  resetThread: (threadId: string) => void;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function shouldIncludeThreadItem(item: ThreadItem): boolean {
  return item.type !== 'reasoning';
}

function shouldIncludeResponseItem(item: ResponseItem): boolean {
  return item.type !== 'reasoning';
}

function getThread(threadStates: Record<string, PerThreadState>, id: string): PerThreadState {
  return threadStates[id] ?? freshThreadState();
}

function patchThread(
  threadStates: Record<string, PerThreadState>,
  id: string,
  patch: Partial<PerThreadState>,
): Record<string, PerThreadState> {
  return {
    ...threadStates,
    [id]: { ...getThread(threadStates, id), ...patch },
  };
}

function ensureEntry(
  ts: { transcript: Record<string, TranscriptEntry>; transcriptOrder: string[] },
  id: string,
  fallback: TranscriptEntry,
): TranscriptEntry {
  if (!ts.transcript[id]) {
    ts.transcript[id] = fallback;
    ts.transcriptOrder.push(id);
  }
  return ts.transcript[id];
}

function summarizeItem(item: ThreadItem): TranscriptEntry {
  switch (item.type) {
    case 'userMessage':
      return {
        id: item.id,
        kind: item.type,
        title: 'Prompt',
        body: item.content
          .map((c) => (c.type === 'text' ? c.text : c.type))
          .join('\n'),
        rawItem: item,
      };
    case 'agentMessage':
      return { id: item.id, kind: item.type, title: 'Agent', body: item.text, caption: item.phase ?? undefined, rawItem: item };
    case 'reasoning':
      return { id: item.id, kind: item.type, title: 'Reasoning', body: [...item.summary, ...item.content].join('\n'), rawItem: item };
    case 'plan':
      return { id: item.id, kind: item.type, title: 'Plan', body: item.text, rawItem: item };
    case 'commandExecution':
      return { id: item.id, kind: item.type, title: item.command, body: item.aggregatedOutput ?? '', caption: item.cwd, status: item.status, rawItem: item };
    case 'fileChange':
      return { id: item.id, kind: item.type, title: 'File change', body: item.changes.map((c) => `${c.kind} ${c.path}\n${c.diff}`).join('\n\n'), status: item.status, rawItem: item };
    case 'mcpToolCall':
      return { id: item.id, kind: item.type, title: `${item.server} / ${item.tool}`, body: JSON.stringify(item.result ?? item.arguments, null, 2), status: item.status, rawItem: item };
    case 'dynamicToolCall':
      return { id: item.id, kind: item.type, title: item.tool, body: JSON.stringify(item.contentItems ?? item.arguments, null, 2), status: item.status, rawItem: item };
    case 'webSearch':
      return { id: item.id, kind: item.type, title: 'Web search', body: item.query, rawItem: item };
    case 'imageView':
      return { id: item.id, kind: item.type, title: 'Image view', body: item.path, rawItem: item };
    case 'imageGeneration':
      return { id: item.id, kind: item.type, title: 'Image generation', body: item.revisedPrompt ?? item.result, status: item.status, rawItem: item };
    case 'enteredReviewMode':
    case 'exitedReviewMode':
      return { id: item.id, kind: item.type, title: item.type === 'enteredReviewMode' ? 'Review started' : 'Review finished', body: item.review, rawItem: item };
    case 'contextCompaction':
      return { id: item.id, kind: item.type, title: 'Context compaction', body: 'Conversation history was compacted.', rawItem: item };
    case 'collabAgentToolCall':
      return { id: item.id, kind: item.type, title: `Agent tool: ${item.tool}`, body: item.prompt ?? '', status: item.status, rawItem: item };
  }
}

function summarizeResponseItem(item: ResponseItem, id: string): TranscriptEntry {
  switch (item.type) {
    case 'message':
      return {
        id, kind: 'rawResponseItem',
        title: item.role === 'assistant' ? 'Agent' : item.role,
        body: item.content.map((c) => (c.type === 'input_text' || c.type === 'output_text' ? c.text : c.type)).join('\n'),
        rawItem: item,
      };
    case 'reasoning':
      return {
        id, kind: 'rawResponseItem', title: 'Reasoning',
        body: [
          ...item.summary.map((s) => ('text' in s ? s.text : JSON.stringify(s))),
          ...(item.content ?? []).map((c) => ('text' in c ? c.text : JSON.stringify(c))),
        ].join('\n'),
        rawItem: item,
      };
    case 'local_shell_call':
      return { id, kind: 'rawResponseItem', title: 'Shell', body: item.action.command.join(' '), status: item.status, rawItem: item };
    case 'function_call':
    case 'custom_tool_call':
      return { id, kind: 'rawResponseItem', title: item.name, body: item.type === 'function_call' ? item.arguments : item.input, status: 'status' in item ? item.status ?? null : null, rawItem: item };
    case 'function_call_output':
    case 'custom_tool_call_output':
      return { id, kind: 'rawResponseItem', title: item.type === 'function_call_output' ? 'Tool output' : 'Custom tool output', body: JSON.stringify(item.output.body, null, 2), rawItem: item };
    case 'web_search_call':
      return { id, kind: 'rawResponseItem', title: 'Web search', body: JSON.stringify(item.action ?? {}, null, 2), status: item.status ?? null, rawItem: item };
    case 'image_generation_call':
      return { id, kind: 'rawResponseItem', title: 'Image generation', body: item.revised_prompt ?? item.result, status: item.status, rawItem: item };
    case 'ghost_snapshot':
      return { id, kind: 'rawResponseItem', title: 'Snapshot', body: JSON.stringify(item.ghost_commit, null, 2), rawItem: item };
    case 'compaction':
      return { id, kind: 'rawResponseItem', title: 'Context compaction', body: 'Conversation history was compacted.', rawItem: item };
    case 'other':
      return { id, kind: 'rawResponseItem', title: 'Event', body: item.type, rawItem: item };
  }
}

function transcriptFromItems(items: ThreadItem[]): Pick<PerThreadState, 'transcriptOrder' | 'transcript'> {
  const transcriptOrder: string[] = [];
  const transcript: Record<string, TranscriptEntry> = {};
  for (const item of items) {
    if (!shouldIncludeThreadItem(item)) continue;
    const entry = summarizeItem(item);
    if (!transcript[entry.id]) transcriptOrder.push(entry.id);
    transcript[entry.id] = entry;
  }
  return { transcriptOrder, transcript };
}

function normalizeThreadStatus(status: ThreadStatus): string {
  if (status.type === 'active') return 'inProgress';
  return status.type;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------
export const useCodexStore = create<StoreState>((set) => ({
  backend: { connected: false },
  models: [],
  selectedModel: null,
  selectedEffort: null,
  logs: [],
  workspacePath: '',
  threadId: null,
  approvalPolicy: null,
  sandboxPolicy: null,
  threadStates: {},

  setWorkspace: (workspacePath) => set({ workspacePath }),
  setSelectedModel: (selectedModel) => set({ selectedModel }),
  setSelectedEffort: (selectedEffort) => set({ selectedEffort }),

  startBackend: (payload) =>
    set((state) => {
      const defaultModel = payload.models.find((m) => m.isDefault) ?? payload.models[0] ?? null;
      return {
        backend: { ...state.backend, connected: true, userAgent: payload.userAgent, codexBin: payload.codexBin, error: undefined },
        models: payload.models,
        selectedModel: defaultModel?.model ?? null,
        selectedEffort: defaultModel?.defaultReasoningEffort ?? null,
      };
    }),

  createSession: (workspacePath, response) =>
    set((state) => {
      const tid = response.thread.id;
      const name = response.thread.name?.trim() || response.thread.preview?.trim() || 'New chat';
      return {
        workspacePath,
        threadId: tid,
        approvalPolicy: response.approvalPolicy,
        sandboxPolicy: response.sandbox,
        logs: [],
        threadStates: patchThread(state.threadStates, tid, freshThreadState(name)),
      };
    }),

  resumeSession: (workspacePath, response) =>
    set((state) => {
      const tid = response.thread.id;
      const existing = getThread(state.threadStates, tid);
      const name = response.thread.name?.trim() || response.thread.preview?.trim() || existing.threadName || 'New chat';

      // If this thread is already in-flight (e.g. user switched away and back),
      // preserve the live turn state so the loading indicator keeps showing.
      const isInFlight = existing.currentTurnId !== null && existing.turnStatus !== 'completed';

      return {
        workspacePath,
        threadId: tid,
        approvalPolicy: response.approvalPolicy,
        sandboxPolicy: response.sandbox,
        logs: [],
        threadStates: patchThread(state.threadStates, tid, {
          threadName: name,
          // Only overwrite transcript/turn state for idle threads
          ...(!isInFlight && {
            ...transcriptFromItems(response.thread.turns.flatMap((t) => t.items)),
            currentTurnId: null,
            turnStatus: normalizeThreadStatus(response.thread.status),
            latestDiff: '',
            approvals: [],
          }),
        }),
      };
    }),

  replaceTranscript: (threadId, response) =>
    set((state) => {
      const existing = getThread(state.threadStates, threadId);
      const name = response.thread.name?.trim() || response.thread.preview?.trim() || existing.threadName;
      return {
        threadStates: patchThread(state.threadStates, threadId, {
          ...transcriptFromItems(response.thread.turns.flatMap((t) => t.items)),
          threadName: name,
        }),
      };
    }),

  beginTurn: (threadId, response) =>
    set((state) => ({
      threadStates: patchThread(state.threadStates, threadId, {
        currentTurnId: response.turn.id,
        turnStatus: response.turn.status,
      }),
    })),

  clearApproval: (threadId, id) =>
    set((state) => {
      const ts = getThread(state.threadStates, threadId);
      return {
        threadStates: patchThread(state.threadStates, threadId, {
          approvals: ts.approvals.filter((a) => a.id !== id),
        }),
      };
    }),

  resetThread: (threadId) =>
    set((state) => ({
      threadStates: patchThread(state.threadStates, threadId, freshThreadState()),
    })),

  handleBridgeEvent: (event) =>
    set((state) => {
      // ── Global events ──────────────────────────────────────────────────
      if (event.type === 'backend-status') {
        return { backend: { ...state.backend, ...event.payload } };
      }

      if (event.type === 'backend-log') {
        return { logs: [...state.logs, event.payload.message].slice(-60) };
      }

      // ── Server requests — route to the active thread ───────────────────
      if (event.type === 'server-request') {
        const request = event.payload as ServerRequest;
        const tid = state.threadId;
        if (!tid) return {};

        const ts = getThread(state.threadStates, tid);
        const pendingApproval = { ...request, createdAt: Date.now() } as PendingApproval;

        if (request.method === 'item/tool/call') {
          const transcript = { ...ts.transcript };
          const transcriptOrder = [...ts.transcriptOrder];
          const entry: TranscriptEntry = {
            id: request.params.callId ?? String(request.id),
            kind: 'rawResponseItem',
            title: `Called ${request.params.tool}`,
            body: JSON.stringify(request.params.arguments, null, 2),
            status: 'pending',
          };
          if (!transcript[entry.id]) transcriptOrder.push(entry.id);
          transcript[entry.id] = entry;

          return {
            threadStates: patchThread(state.threadStates, tid, {
              transcript,
              transcriptOrder,
              approvals: [...ts.approvals.filter((a) => a.id !== request.id), pendingApproval],
            }),
          };
        }

        return {
          threadStates: patchThread(state.threadStates, tid, {
            approvals: [...ts.approvals.filter((a) => a.id !== request.id), pendingApproval],
          }),
        };
      }

      // ── Notifications — route by threadId in params ────────────────────
      const notification = event.payload as ServerNotification;

      switch (notification.method) {
        case 'thread/started': {
          const tid = notification.params.thread.id;
          const name = notification.params.thread.name?.trim() || notification.params.thread.preview?.trim() || 'New chat';
          return {
            threadStates: patchThread(state.threadStates, tid, { threadName: name }),
          };
        }

        case 'thread/name/updated': {
          const tid = notification.params.threadId;
          const existing = getThread(state.threadStates, tid);
          return {
            threadStates: patchThread(state.threadStates, tid, {
              threadName: notification.params.threadName?.trim() || existing.threadName,
            }),
          };
        }

        case 'turn/started': {
          const tid = notification.params.threadId;
          return {
            threadStates: patchThread(state.threadStates, tid, {
              currentTurnId: notification.params.turn.id,
              turnStatus: notification.params.turn.status,
            }),
          };
        }

        case 'turn/completed': {
          const tid = notification.params.threadId;
          return {
            threadStates: patchThread(state.threadStates, tid, {
              currentTurnId: null,
              turnStatus: notification.params.turn.status,
            }),
          };
        }

        case 'turn/diff/updated': {
          const tid = notification.params.threadId;
          return {
            threadStates: patchThread(state.threadStates, tid, { latestDiff: notification.params.diff }),
          };
        }

        case 'item/started':
        case 'item/completed': {
          const tid = notification.params.threadId;
          if (!shouldIncludeThreadItem(notification.params.item)) return {};
          const entry = summarizeItem(notification.params.item);
          const ts = getThread(state.threadStates, tid);
          const transcript = { ...ts.transcript };
          const transcriptOrder = [...ts.transcriptOrder];
          if (!transcript[entry.id]) transcriptOrder.push(entry.id);
          transcript[entry.id] = entry;
          return { threadStates: patchThread(state.threadStates, tid, { transcript, transcriptOrder }) };
        }

        case 'rawResponseItem/completed': {
          const tid = notification.params.threadId;
          if (!shouldIncludeResponseItem(notification.params.item)) return {};
          const ts = getThread(state.threadStates, tid);
          const entry = summarizeResponseItem(
            notification.params.item,
            `raw-${notification.params.turnId}-${ts.transcriptOrder.length}`,
          );
          const transcript = { ...ts.transcript };
          const transcriptOrder = [...ts.transcriptOrder];
          if (!transcript[entry.id]) transcriptOrder.push(entry.id);
          transcript[entry.id] = entry;
          return { threadStates: patchThread(state.threadStates, tid, { transcript, transcriptOrder }) };
        }

        case 'item/agentMessage/delta': {
          const tid = notification.params.threadId;
          const ts = getThread(state.threadStates, tid);
          const transcript = { ...ts.transcript };
          const transcriptOrder = [...ts.transcriptOrder];
          const entry = ensureEntry(
            { transcript, transcriptOrder },
            notification.params.itemId,
            { id: notification.params.itemId, kind: 'agentMessage', title: 'Agent', body: '' },
          );
          entry.body += notification.params.delta;
          return { threadStates: patchThread(state.threadStates, tid, { transcript, transcriptOrder }) };
        }

        case 'item/commandExecution/outputDelta': {
          const tid = notification.params.threadId;
          const ts = getThread(state.threadStates, tid);
          const transcript = { ...ts.transcript };
          const transcriptOrder = [...ts.transcriptOrder];
          const entry = ensureEntry(
            { transcript, transcriptOrder },
            notification.params.itemId,
            { id: notification.params.itemId, kind: 'commandExecution', title: 'Command output', body: '' },
          );
          entry.body += notification.params.delta;
          return { threadStates: patchThread(state.threadStates, tid, { transcript, transcriptOrder }) };
        }

        case 'item/fileChange/outputDelta': {
          const tid = notification.params.threadId;
          const ts = getThread(state.threadStates, tid);
          const transcript = { ...ts.transcript };
          const transcriptOrder = [...ts.transcriptOrder];
          const entry = ensureEntry(
            { transcript, transcriptOrder },
            notification.params.itemId,
            { id: notification.params.itemId, kind: 'fileChange', title: 'File change', body: '' },
          );
          entry.body += notification.params.delta;
          return { threadStates: patchThread(state.threadStates, tid, { transcript, transcriptOrder }) };
        }

        case 'item/mcpToolCall/progress': {
          const tid = notification.params.threadId;
          const ts = getThread(state.threadStates, tid);
          const transcript = { ...ts.transcript };
          const transcriptOrder = [...ts.transcriptOrder];
          const entry = ensureEntry(
            { transcript, transcriptOrder },
            notification.params.itemId,
            { id: notification.params.itemId, kind: 'mcpToolCall', title: 'MCP tool', body: '' },
          );
          entry.body = entry.body ? `${entry.body}\n${notification.params.message}` : notification.params.message;
          return { threadStates: patchThread(state.threadStates, tid, { transcript, transcriptOrder }) };
        }

        case 'item/reasoning/textDelta':
        case 'item/reasoning/summaryTextDelta':
        case 'item/reasoning/summaryPartAdded':
          return {};

        case 'serverRequest/resolved': {
          // No threadId in params — search all threads
          const requestId = notification.params.requestId;
          const updated = { ...state.threadStates };
          let changed = false;
          for (const [tid, ts] of Object.entries(updated)) {
            if (ts.approvals.some((a) => a.id === requestId)) {
              updated[tid] = { ...ts, approvals: ts.approvals.filter((a) => a.id !== requestId) };
              changed = true;
            }
          }
          return changed ? { threadStates: updated } : {};
        }

        default:
          return {};
      }
    }),
}));

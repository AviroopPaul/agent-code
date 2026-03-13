import { create } from 'zustand';

import type { BackendStartResponse, CodexBridgeEvent } from '../shared/bridge';
import type { ReasoningEffort } from '../shared/protocol/ReasoningEffort';
import type { ResponseItem } from '../shared/protocol/ResponseItem';
import type { ServerNotification } from '../shared/protocol/ServerNotification';
import type { ServerRequest } from '../shared/protocol/ServerRequest';
import type { ThreadItem } from '../shared/protocol/v2/ThreadItem';
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

type BackendState = {
  connected: boolean;
  userAgent?: string;
  codexBin?: string;
  error?: string;
};

type StoreState = {
  backend: BackendState;
  models: BackendStartResponse['models'];
  selectedModel: string | null;
  selectedEffort: ReasoningEffort | null;
  workspacePath: string;
  threadId: string | null;
  currentThreadName: string;
  currentTurnId: string | null;
  turnStatus: string;
  transcriptOrder: string[];
  transcript: Record<string, TranscriptEntry>;
  latestDiff: string;
  approvals: PendingApproval[];
  logs: string[];
  setWorkspace: (path: string) => void;
  setSelectedModel: (model: string | null) => void;
  setSelectedEffort: (effort: ReasoningEffort | null) => void;
  startBackend: (payload: BackendStartResponse) => void;
  handleBridgeEvent: (event: CodexBridgeEvent) => void;
  createSession: (workspacePath: string, response: ThreadStartResponse) => void;
  resumeSession: (workspacePath: string, response: ThreadResumeResponse) => void;
  replaceTranscript: (response: ThreadReadResponse) => void;
  beginTurn: (response: TurnStartResponse) => void;
  clearApproval: (id: string | number) => void;
  resetTranscript: () => void;
};

function ensureTranscriptEntry(
  state: StoreState,
  id: string,
  fallback: TranscriptEntry,
): TranscriptEntry {
  if (!state.transcript[id]) {
    state.transcript[id] = fallback;
    state.transcriptOrder.push(id);
  }

  return state.transcript[id];
}

function summarizeItem(item: ThreadItem): TranscriptEntry {
  switch (item.type) {
    case 'userMessage':
      return {
        id: item.id,
        kind: item.type,
        title: 'Prompt',
        body: item.content
          .map((contentItem) => {
            if (contentItem.type === 'text') {
              return contentItem.text;
            }

            return contentItem.type;
          })
          .join('\n'),
        rawItem: item,
      };
    case 'agentMessage':
      return {
        id: item.id,
        kind: item.type,
        title: 'Agent',
        body: item.text,
        caption: item.phase ?? undefined,
        rawItem: item,
      };
    case 'reasoning':
      return {
        id: item.id,
        kind: item.type,
        title: 'Reasoning',
        body: [...item.summary, ...item.content].join('\n'),
        rawItem: item,
      };
    case 'plan':
      return {
        id: item.id,
        kind: item.type,
        title: 'Plan',
        body: item.text,
        rawItem: item,
      };
    case 'commandExecution':
      return {
        id: item.id,
        kind: item.type,
        title: item.command,
        body: item.aggregatedOutput ?? '',
        caption: item.cwd,
        status: item.status,
        rawItem: item,
      };
    case 'fileChange':
      return {
        id: item.id,
        kind: item.type,
        title: 'File change',
        body: item.changes.map((change) => `${change.kind} ${change.path}\n${change.diff}`).join('\n\n'),
        status: item.status,
        rawItem: item,
      };
    case 'mcpToolCall':
      return {
        id: item.id,
        kind: item.type,
        title: `${item.server} / ${item.tool}`,
        body: JSON.stringify(item.result ?? item.arguments, null, 2),
        status: item.status,
        rawItem: item,
      };
    case 'dynamicToolCall':
      return {
        id: item.id,
        kind: item.type,
        title: item.tool,
        body: JSON.stringify(item.contentItems ?? item.arguments, null, 2),
        status: item.status,
        rawItem: item,
      };
    case 'webSearch':
      return {
        id: item.id,
        kind: item.type,
        title: 'Web search',
        body: item.query,
        rawItem: item,
      };
    case 'imageView':
      return {
        id: item.id,
        kind: item.type,
        title: 'Image view',
        body: item.path,
        rawItem: item,
      };
    case 'imageGeneration':
      return {
        id: item.id,
        kind: item.type,
        title: 'Image generation',
        body: item.revisedPrompt ?? item.result,
        status: item.status,
        rawItem: item,
      };
    case 'enteredReviewMode':
    case 'exitedReviewMode':
      return {
        id: item.id,
        kind: item.type,
        title: item.type === 'enteredReviewMode' ? 'Review started' : 'Review finished',
        body: item.review,
        rawItem: item,
      };
    case 'contextCompaction':
      return {
        id: item.id,
        kind: item.type,
        title: 'Context compaction',
        body: 'Conversation history was compacted.',
        rawItem: item,
      };
    case 'collabAgentToolCall':
      return {
        id: item.id,
        kind: item.type,
        title: `Agent tool: ${item.tool}`,
        body: item.prompt ?? '',
        status: item.status,
        rawItem: item,
      };
  }
}

function summarizeResponseItem(item: ResponseItem, id: string): TranscriptEntry {
  switch (item.type) {
    case 'message':
      return {
        id,
        kind: 'rawResponseItem',
        title: item.role === 'assistant' ? 'Agent' : item.role,
        body: item.content
          .map((contentItem) => {
            if (contentItem.type === 'input_text' || contentItem.type === 'output_text') {
              return contentItem.text;
            }

            return contentItem.type;
          })
          .join('\n'),
        rawItem: item,
      };
    case 'reasoning':
      return {
        id,
        kind: 'rawResponseItem',
        title: 'Reasoning',
        body: [
          ...item.summary.map((summary) => ('text' in summary ? summary.text : JSON.stringify(summary))),
          ...(item.content ?? []).map((content) => ('text' in content ? content.text : JSON.stringify(content))),
        ].join('\n'),
        rawItem: item,
      };
    case 'local_shell_call':
      return {
        id,
        kind: 'rawResponseItem',
        title: 'Shell',
        body: item.action.command.join(' '),
        status: item.status,
        rawItem: item,
      };
    case 'function_call':
    case 'custom_tool_call':
      return {
        id,
        kind: 'rawResponseItem',
        title: item.name,
        body: item.type === 'function_call' ? item.arguments : item.input,
        status: 'status' in item ? item.status ?? null : null,
        rawItem: item,
      };
    case 'function_call_output':
    case 'custom_tool_call_output':
      return {
        id,
        kind: 'rawResponseItem',
        title: item.type === 'function_call_output' ? 'Tool output' : 'Custom tool output',
        body: JSON.stringify(item.output.body, null, 2),
        rawItem: item,
      };
    case 'web_search_call':
      return {
        id,
        kind: 'rawResponseItem',
        title: 'Web search',
        body: JSON.stringify(item.action ?? {}, null, 2),
        status: item.status ?? null,
        rawItem: item,
      };
    case 'image_generation_call':
      return {
        id,
        kind: 'rawResponseItem',
        title: 'Image generation',
        body: item.revised_prompt ?? item.result,
        status: item.status,
        rawItem: item,
      };
    case 'ghost_snapshot':
      return {
        id,
        kind: 'rawResponseItem',
        title: 'Snapshot',
        body: JSON.stringify(item.ghost_commit, null, 2),
        rawItem: item,
      };
    case 'compaction':
      return {
        id,
        kind: 'rawResponseItem',
        title: 'Context compaction',
        body: 'Conversation history was compacted.',
        rawItem: item,
      };
    case 'other':
      return {
        id,
        kind: 'rawResponseItem',
        title: 'Event',
        body: item.type,
        rawItem: item,
      };
  }
}

function transcriptStateFromItems(items: ThreadItem[]): Pick<StoreState, 'transcriptOrder' | 'transcript'> {
  const transcriptOrder: string[] = [];
  const transcript: Record<string, TranscriptEntry> = {};

  for (const item of items) {
    const entry = summarizeItem(item);
    if (!transcript[entry.id]) {
      transcriptOrder.push(entry.id);
    }
    transcript[entry.id] = entry;
  }

  return { transcriptOrder, transcript };
}

function normalizeThreadStatus(status: ThreadStatus): string {
  if (status.type === 'active') return 'inProgress';
  return status.type;
}

export const useCodexStore = create<StoreState>((set) => ({
  backend: {
    connected: false,
  },
  models: [],
  selectedModel: null,
  selectedEffort: null,
  workspacePath: '',
  threadId: null,
  currentThreadName: 'New chat',
  currentTurnId: null,
  turnStatus: 'idle',
  transcriptOrder: [],
  transcript: {},
  latestDiff: '',
  approvals: [],
  logs: [],
  setWorkspace: (workspacePath) => set({ workspacePath }),
  setSelectedModel: (selectedModel) => set({ selectedModel }),
  setSelectedEffort: (selectedEffort) => set({ selectedEffort }),
  startBackend: (payload) =>
    set((state) => {
      const defaultModel = payload.models.find((model) => model.isDefault) ?? payload.models[0] ?? null;

      return {
        backend: {
          ...state.backend,
          connected: true,
          userAgent: payload.userAgent,
          codexBin: payload.codexBin,
          error: undefined,
        },
        models: payload.models,
        selectedModel: defaultModel?.model ?? null,
        selectedEffort: defaultModel?.defaultReasoningEffort ?? null,
      };
    }),
  createSession: (workspacePath, response) =>
    set({
      workspacePath,
      threadId: response.thread.id,
      currentThreadName: response.thread.name?.trim() || response.thread.preview?.trim() || 'New chat',
      currentTurnId: null,
      turnStatus: 'idle',
      transcriptOrder: [],
      transcript: {},
      latestDiff: '',
      approvals: [],
      logs: [],
    }),
  resumeSession: (workspacePath, response) =>
    set({
      workspacePath,
      threadId: response.thread.id,
      currentThreadName: response.thread.name?.trim() || response.thread.preview?.trim() || 'New chat',
      currentTurnId: null,
      turnStatus: normalizeThreadStatus(response.thread.status),
      ...transcriptStateFromItems(response.thread.turns.flatMap((turn) => turn.items)),
      latestDiff: '',
      approvals: [],
      logs: [],
    }),
  replaceTranscript: (response) =>
    set((state) => ({
      currentThreadName: response.thread.name?.trim() || response.thread.preview?.trim() || state.currentThreadName,
      ...transcriptStateFromItems(response.thread.turns.flatMap((turn) => turn.items)),
    })),
  beginTurn: (response) =>
    set({
      currentTurnId: response.turn.id,
      turnStatus: response.turn.status,
    }),
  clearApproval: (id) =>
    set((state) => ({
      approvals: state.approvals.filter((approval) => approval.id !== id),
    })),
  resetTranscript: () =>
    set({
      transcriptOrder: [],
      transcript: {},
      latestDiff: '',
      approvals: [],
      logs: [],
      currentTurnId: null,
      turnStatus: 'idle',
      currentThreadName: 'New chat',
    }),
  handleBridgeEvent: (event) =>
    set((state) => {
      if (event.type === 'backend-status') {
        return {
          backend: {
            ...state.backend,
            ...event.payload,
          },
        };
      }

      if (event.type === 'backend-log') {
        return {
          logs: [...state.logs, event.payload.message].slice(-60),
        };
      }

      if (event.type === 'server-request') {
        const request = event.payload as ServerRequest;
        const pendingApproval = {
          ...request,
          createdAt: Date.now(),
        } as PendingApproval;

        if (request.method === 'item/tool/call') {
          const transcript = { ...state.transcript };
          const transcriptOrder = [...state.transcriptOrder];
          const entry: TranscriptEntry = {
            id: request.params.callId ?? String(request.id),
            kind: 'rawResponseItem',
            title: `Called ${request.params.tool}`,
            body: JSON.stringify(request.params.arguments, null, 2),
            status: 'pending',
          };

          if (!transcript[entry.id]) {
            transcriptOrder.push(entry.id);
          }

          transcript[entry.id] = entry;

          return {
            approvals: [
              ...state.approvals.filter((approval) => approval.id !== request.id),
              pendingApproval,
            ],
            transcript,
            transcriptOrder,
          };
        }

        return {
          approvals: [
            ...state.approvals.filter((approval) => approval.id !== request.id),
            pendingApproval,
          ],
        };
      }

      const notification = event.payload as ServerNotification;

      switch (notification.method) {
        case 'thread/started':
          return {
            threadId: notification.params.thread.id,
            currentThreadName: notification.params.thread.name?.trim() || notification.params.thread.preview?.trim() || 'New chat',
          };
        case 'thread/name/updated':
          return {
            currentThreadName: notification.params.threadName?.trim() || state.currentThreadName,
          };
        case 'turn/started':
          return {
            currentTurnId: notification.params.turn.id,
            turnStatus: notification.params.turn.status,
          };
        case 'turn/completed':
          return {
            currentTurnId: null,
            turnStatus: notification.params.turn.status,
          };
        case 'turn/diff/updated':
          return {
            latestDiff: notification.params.diff,
          };
        case 'item/started':
        case 'item/completed': {
          const entry = summarizeItem(notification.params.item);
          const transcript = { ...state.transcript };
          const transcriptOrder = [...state.transcriptOrder];

          if (!transcript[entry.id]) {
            transcriptOrder.push(entry.id);
          }

          transcript[entry.id] = entry;

          return {
            transcript,
            transcriptOrder,
          };
        }
        case 'rawResponseItem/completed': {
          const entry = summarizeResponseItem(
            notification.params.item,
            `raw-${notification.params.turnId}-${state.transcriptOrder.length}`,
          );
          const transcript = { ...state.transcript };
          const transcriptOrder = [...state.transcriptOrder];

          if (!transcript[entry.id]) {
            transcriptOrder.push(entry.id);
          }

          transcript[entry.id] = entry;

          return {
            transcript,
            transcriptOrder,
          };
        }
        case 'item/agentMessage/delta': {
          const transcript = { ...state.transcript };
          const transcriptOrder = [...state.transcriptOrder];
          const entry = ensureTranscriptEntry(
            { ...state, transcript, transcriptOrder },
            notification.params.itemId,
            {
              id: notification.params.itemId,
              kind: 'agentMessage',
              title: 'Agent',
              body: '',
            },
          );
          entry.body += notification.params.delta;

          return {
            transcript,
            transcriptOrder,
          };
        }
        case 'item/commandExecution/outputDelta': {
          const transcript = { ...state.transcript };
          const transcriptOrder = [...state.transcriptOrder];
          const entry = ensureTranscriptEntry(
            { ...state, transcript, transcriptOrder },
            notification.params.itemId,
            {
              id: notification.params.itemId,
              kind: 'commandExecution',
              title: 'Command output',
              body: '',
            },
          );
          entry.body += notification.params.delta;

          return {
            transcript,
            transcriptOrder,
          };
        }
        case 'item/fileChange/outputDelta': {
          const transcript = { ...state.transcript };
          const transcriptOrder = [...state.transcriptOrder];
          const entry = ensureTranscriptEntry(
            { ...state, transcript, transcriptOrder },
            notification.params.itemId,
            {
              id: notification.params.itemId,
              kind: 'fileChange',
              title: 'File change',
              body: '',
            },
          );
          entry.body += notification.params.delta;

          return {
            transcript,
            transcriptOrder,
          };
        }
        case 'item/mcpToolCall/progress': {
          const transcript = { ...state.transcript };
          const transcriptOrder = [...state.transcriptOrder];
          const entry = ensureTranscriptEntry(
            { ...state, transcript, transcriptOrder },
            notification.params.itemId,
            {
              id: notification.params.itemId,
              kind: 'mcpToolCall',
              title: 'MCP tool',
              body: '',
            },
          );
          entry.body = entry.body ? `${entry.body}\n${notification.params.message}` : notification.params.message;

          return {
            transcript,
            transcriptOrder,
          };
        }
        case 'item/reasoning/textDelta': {
          const transcript = { ...state.transcript };
          const transcriptOrder = [...state.transcriptOrder];
          const entry = ensureTranscriptEntry(
            { ...state, transcript, transcriptOrder },
            notification.params.itemId,
            {
              id: notification.params.itemId,
              kind: 'reasoning',
              title: 'Reasoning',
              body: '',
            },
          );
          entry.body += notification.params.delta;

          return {
            transcript,
            transcriptOrder,
          };
        }
        case 'item/reasoning/summaryTextDelta': {
          const transcript = { ...state.transcript };
          const transcriptOrder = [...state.transcriptOrder];
          const entry = ensureTranscriptEntry(
            { ...state, transcript, transcriptOrder },
            notification.params.itemId,
            {
              id: notification.params.itemId,
              kind: 'reasoning',
              title: 'Reasoning',
              body: '',
            },
          );
          entry.body += notification.params.delta;

          return {
            transcript,
            transcriptOrder,
          };
        }
        case 'item/reasoning/summaryPartAdded': {
          const transcript = { ...state.transcript };
          const transcriptOrder = [...state.transcriptOrder];
          ensureTranscriptEntry(
            { ...state, transcript, transcriptOrder },
            notification.params.itemId,
            {
              id: notification.params.itemId,
              kind: 'reasoning',
              title: 'Reasoning',
              body: '',
            },
          );

          return {
            transcript,
            transcriptOrder,
          };
        }
        case 'serverRequest/resolved':
          return {
            approvals: state.approvals.filter((approval) => approval.id !== notification.params.requestId),
          };
        default:
          return {};
      }
    }),
}));

import type { Model } from './protocol/v2/Model';
import type { ReasoningEffort } from './protocol/ReasoningEffort';
import type { Thread } from './protocol/v2/Thread';
import type { ThreadListResponse } from './protocol/v2/ThreadListResponse';
import type { ThreadReadResponse } from './protocol/v2/ThreadReadResponse';
import type { ThreadResumeResponse } from './protocol/v2/ThreadResumeResponse';
import type { ThreadStartResponse } from './protocol/v2/ThreadStartResponse';
import type { TurnStartResponse } from './protocol/v2/TurnStartResponse';

export type BackendStartResponse = {
  userAgent: string;
  codexBin: string;
  models: Model[];
};

export type CodexBridgeEvent =
  | { type: 'backend-status'; payload: { connected: boolean; userAgent?: string; codexBin?: string; error?: string } }
  | { type: 'backend-log'; payload: { message: string } }
  | { type: 'notification'; payload: unknown }
  | { type: 'server-request'; payload: unknown };

export type CodexBridge = {
  getCwd: () => Promise<string>;
  startBackend: () => Promise<BackendStartResponse>;
  stopBackend: () => Promise<void>;
  selectWorkspace: () => Promise<string | null>;
  createSession: (cwd: string) => Promise<ThreadStartResponse>;
  listThreads: (cwd: string) => Promise<ThreadListResponse>;
  readThread: (threadId: string) => Promise<ThreadReadResponse>;
  resumeThread: (threadId: string, cwd?: string | null) => Promise<ThreadResumeResponse>;
  sendTurn: (payload: { threadId: string; cwd: string; text: string; images?: string[]; model?: string | null; effort?: ReasoningEffort | null }) => Promise<TurnStartResponse>;
  interruptTurn: (payload: { threadId: string; turnId: string }) => Promise<unknown>;
  resolveServerRequest: (payload: { id: string | number; result?: unknown; error?: { code: number; message: string; data?: unknown } }) => Promise<void>;
  openExternal: (url: string) => Promise<void>;
  openInCursor: (cwd: string) => Promise<void>;
  subscribe: (listener: (event: CodexBridgeEvent) => void) => () => void;
};

export type ProjectThread = Pick<Thread, 'id' | 'name' | 'preview' | 'createdAt' | 'updatedAt' | 'status' | 'cwd'>;

declare global {
  interface Window {
    codex: CodexBridge;
  }
}

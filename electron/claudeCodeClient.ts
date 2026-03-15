import { execFile, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { promisify } from 'node:util';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const execFileAsync = promisify(execFile);

export const CLAUDE_MODELS = [
  { model: 'claude-opus-4-5', displayName: 'Claude Opus 4.5', isDefault: false },
  { model: 'claude-sonnet-4-5', displayName: 'Claude Sonnet 4.5', isDefault: true },
  { model: 'claude-haiku-4-5', displayName: 'Claude Haiku 4.5', isDefault: false },
  { model: 'claude-opus-4-0', displayName: 'Claude Opus 4', isDefault: false },
  { model: 'claude-sonnet-4-0', displayName: 'Claude Sonnet 4', isDefault: false },
] as const;

function enrichedEnv(): NodeJS.ProcessEnv {
  const home = process.env.HOME ?? '';
  const extraPaths = [
    `${home}/.local/bin`,
    '/usr/local/bin',
    '/opt/homebrew/bin',
    `${home}/.npm-global/bin`,
  ].filter(Boolean);

  const existingPath = process.env.PATH ?? '';
  const pathParts = existingPath.split(':');

  for (const p of extraPaths) {
    if (!pathParts.includes(p)) {
      pathParts.unshift(p);
    }
  }

  return { ...process.env, PATH: pathParts.join(':') };
}

// ~/.claude/projects/<cwd-with-slashes-as-dashes>/<session-id>.jsonl
function encodeProjectPath(cwd: string): string {
  return cwd.replace(/\//g, '-');
}

function claudeProjectDir(cwd: string): string {
  return path.join(os.homedir(), '.claude', 'projects', encodeProjectPath(cwd));
}

// Shape of entries inside a Claude Code JSONL session file
type JSONLEntry = {
  type: string;
  uuid?: string;
  timestamp?: string;
  sessionId?: string;
  message?: {
    role?: string;
    content?: string | Array<{
      type: string;
      text?: string;
      id?: string;
      name?: string;
      input?: unknown;
      tool_use_id?: string;
      is_error?: boolean;
      content?: Array<{ type: string; text?: string }> | string;
    }>;
  };
};

type JSONLContent = NonNullable<NonNullable<JSONLEntry['message']>['content']>;

function extractTextFromContent(content: JSONLContent): string {
  if (!content) return '';
  if (typeof content === 'string') return content;
  return content
    .filter((c: { type: string; text?: string }) => c.type === 'text' && c.text)
    .map((c: { type: string; text?: string }) => c.text ?? '')
    .join('\n');
}

async function readSessionMeta(
  filePath: string,
  sessionId: string,
  cwd: string,
): Promise<{ id: string; preview: string; createdAt: number; updatedAt: number; cwd: string } | null> {
  try {
    const stat = await fs.stat(filePath);
    const text = await fs.readFile(filePath, 'utf8');
    const lines = text.split('\n').filter(Boolean);

    let preview = '';
    let createdAt = Math.floor(stat.birthtimeMs / 1000);

    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as JSONLEntry;
        if (entry.type === 'user' && entry.message) {
          const text = extractTextFromContent(entry.message.content ?? '');
          if (text.trim()) {
            preview = text.slice(0, 80);
            if (entry.timestamp) {
              createdAt = Math.floor(new Date(entry.timestamp).getTime() / 1000);
            }
            break;
          }
        }
      } catch {
        // skip malformed lines
      }
    }

    return {
      id: sessionId,
      preview,
      createdAt,
      updatedAt: Math.floor(stat.mtimeMs / 1000),
      cwd,
    };
  } catch {
    return null;
  }
}

function parseSessionToThreadItems(text: string): object[] {
  const lines = text.split('\n').filter(Boolean);
  const items: object[] = [];
  // track tool_use items to pair with tool_result
  const toolItems = new Map<string, object>();

  for (const line of lines) {
    let entry: JSONLEntry;
    try {
      entry = JSON.parse(line) as JSONLEntry;
    } catch {
      continue;
    }

    const uuid = entry.uuid ?? randomUUID();

    if (entry.type === 'user' && entry.message) {
      const content = entry.message.content;

      // Plain text user message
      if (typeof content === 'string' && content.trim()) {
        items.push({
          type: 'userMessage',
          id: uuid,
          content: [{ type: 'text', text: content, text_elements: [] }],
        });
        continue;
      }

      if (Array.isArray(content)) {
        const textBlocks = content.filter((c) => c.type === 'text' && c.text?.trim());
        const toolResults = content.filter((c) => c.type === 'tool_result');

        if (textBlocks.length > 0) {
          items.push({
            type: 'userMessage',
            id: uuid,
            content: textBlocks.map((c) => ({ type: 'text', text: c.text ?? '', text_elements: [] })),
          });
        }

        // Patch tool_use items with their results
        for (const tr of toolResults) {
          const existing = toolItems.get(tr.tool_use_id ?? '');
          if (existing) {
            const outputText = Array.isArray(tr.content)
              ? tr.content.map((c) => c.text ?? '').join('\n')
              : (typeof tr.content === 'string' ? tr.content : '');
            (existing as Record<string, unknown>).contentItems = [{ type: 'inputText', text: outputText }];
            (existing as Record<string, unknown>).status = tr.is_error ? 'failed' : 'completed';
            (existing as Record<string, unknown>).success = !tr.is_error;
          }
        }
      }
      continue;
    }

    if (entry.type === 'assistant' && entry.message) {
      const content = entry.message.content;
      if (!Array.isArray(content)) continue;

      const textBlocks = content.filter((c) => c.type === 'text' && c.text?.trim());
      const toolUseBlocks = content.filter((c) => c.type === 'tool_use');

      if (textBlocks.length > 0) {
        items.push({
          type: 'agentMessage',
          id: uuid,
          text: textBlocks.map((c) => c.text ?? '').join('\n'),
          phase: null,
        });
      }

      for (const tu of toolUseBlocks) {
        const toolItem = {
          type: 'dynamicToolCall',
          id: tu.id ?? randomUUID(),
          tool: tu.name ?? 'unknown',
          arguments: tu.input ?? {},
          status: 'running', // will be patched when tool_result arrives
          contentItems: null,
          success: null,
          durationMs: null,
        };
        toolItems.set(tu.id ?? '', toolItem);
        items.push(toolItem);
      }
    }
  }

  return items;
}

// Claude Code stream-json message shapes (for live streaming)
type ClaudeSystemInit = {
  type: 'system';
  subtype: 'init';
  session_id: string;
  cwd: string;
};

type ClaudeAssistantMessage = {
  type: 'assistant';
  message: {
    id: string;
    content: Array<
      | { type: 'text'; text: string }
      | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
    >;
    stop_reason: string | null;
  };
};

type ClaudeUserMessage = {
  type: 'user';
  message: {
    role: 'user';
    content: Array<{
      type: 'tool_result';
      tool_use_id: string;
      content: Array<{ type: 'text'; text: string }>;
      is_error: boolean;
    }>;
  };
};

type ClaudeResult = {
  type: 'result';
  subtype: 'success' | 'error_max_turns' | 'error_during_execution';
  session_id: string;
  result?: string;
};

type ClaudeStreamMessage = ClaudeSystemInit | ClaudeAssistantMessage | ClaudeUserMessage | ClaudeResult;

type ClientEvents = {
  bridgeEvent: [unknown];
  log: [string];
};

class TypedEmitter extends EventEmitter {
  emit<EventName extends keyof ClientEvents>(eventName: EventName, ...args: ClientEvents[EventName]): boolean {
    return super.emit(eventName, ...args);
  }

  on<EventName extends keyof ClientEvents>(eventName: EventName, listener: (...args: ClientEvents[EventName]) => void): this {
    return super.on(eventName, listener);
  }
}

function makeThread(threadId: string, cwd: string, overrides: Record<string, unknown> = {}): object {
  const now = Math.floor(Date.now() / 1000);
  return {
    id: threadId,
    preview: '',
    ephemeral: false,
    modelProvider: 'anthropic',
    createdAt: now,
    updatedAt: now,
    status: { type: 'idle' },
    path: null,
    cwd,
    cliVersion: '0.0.0',
    source: 'app_server',
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    turns: [],
    ...overrides,
  };
}

function makeTurn(turnId: string, status = 'inProgress'): object {
  return {
    id: turnId,
    items: [],
    status,
    error: null,
  };
}

export class ClaudeCodeClient extends TypedEmitter {
  private claudeBin = 'claude';
  // threadId → claude sessionId (for --resume)
  private sessionMap = new Map<string, string>();
  // threadId → cwd
  private cwdMap = new Map<string, string>();
  private currentProcess: ChildProcessWithoutNullStreams | null = null;

  async initialize(): Promise<{ userAgent: string; claudeBin: string }> {
    const bin = await this.findClaudeBin();
    this.claudeBin = bin;

    try {
      const { stdout } = await execFileAsync(bin, ['--version'], { env: enrichedEnv() });
      const version = stdout.trim();
      return { userAgent: `claude-code/${version}`, claudeBin: bin };
    } catch {
      throw new Error(
        'Claude Code CLI not found. Make sure `claude` is installed and in your PATH, or set the CLAUDE_BIN environment variable.',
      );
    }
  }

  private async findClaudeBin(): Promise<string> {
    if (process.env.CLAUDE_BIN) {
      return process.env.CLAUDE_BIN;
    }

    const candidates = [
      'claude',
      `${process.env.HOME ?? ''}/.local/bin/claude`,
      '/usr/local/bin/claude',
      '/opt/homebrew/bin/claude',
      `${process.env.HOME ?? ''}/.npm-global/bin/claude`,
      `${process.env.HOME ?? ''}/.nvm/current/bin/claude`,
    ];

    for (const candidate of candidates) {
      try {
        await execFileAsync(candidate, ['--version'], { env: enrichedEnv() });
        return candidate;
      } catch {
        // Try next
      }
    }

    throw new Error(
      'Claude Code CLI not found. Make sure `claude` is installed and in your PATH, or set the CLAUDE_BIN environment variable.',
    );
  }

  async createThread(cwd: string): Promise<object> {
    const threadId = randomUUID();
    this.cwdMap.set(threadId, cwd);

    return {
      thread: makeThread(threadId, cwd),
      model: 'claude',
      modelProvider: 'anthropic',
      serviceTier: null,
      cwd,
      approvalPolicy: 'untrusted',
      sandbox: 'workspace-write',
      reasoningEffort: null,
    };
  }

  async listThreads(cwd: string): Promise<{ data: object[]; nextCursor: null }> {
    const projectDir = claudeProjectDir(cwd);

    let files: string[];
    try {
      files = await fs.readdir(projectDir);
    } catch {
      return { data: [], nextCursor: null };
    }

    const jsonlFiles = files.filter((f) => f.endsWith('.jsonl'));

    const metas = await Promise.all(
      jsonlFiles.map(async (file) => {
        const sessionId = file.replace('.jsonl', '');
        const filePath = path.join(projectDir, file);
        return readSessionMeta(filePath, sessionId, cwd);
      }),
    );

    const threads = metas
      .filter((m): m is NonNullable<typeof m> => m !== null && m.preview.trim() !== '')
      .sort((a, b) => b.updatedAt - a.updatedAt);

    // Register sessions so clicking them can --resume correctly
    for (const t of threads) {
      this.cwdMap.set(t.id, cwd);
      this.sessionMap.set(t.id, t.id); // sessionId IS the resumable id
    }

    return {
      data: threads.map((t) => makeThread(t.id, cwd, {
        preview: t.preview,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
      })),
      nextCursor: null,
    };
  }

  async readThread(threadId: string): Promise<object> {
    const cwd = this.cwdMap.get(threadId) ?? '';
    const sessionId = this.sessionMap.get(threadId) ?? threadId;
    const filePath = path.join(claudeProjectDir(cwd), `${sessionId}.jsonl`);

    let items: object[] = [];
    try {
      const text = await fs.readFile(filePath, 'utf8');
      items = parseSessionToThreadItems(text);
    } catch {
      // File not yet on disk (new thread with no turns yet) — return empty
    }

    return {
      thread: makeThread(threadId, cwd, {
        turns: [{ id: randomUUID(), items, status: 'completed', error: null }],
      }),
    };
  }

  async resumeThread(threadId: string): Promise<object> {
    const cwd = this.cwdMap.get(threadId) ?? '';
    // Ensure sessionMap entry so sendTurn can --resume
    if (!this.sessionMap.has(threadId)) {
      this.sessionMap.set(threadId, threadId);
    }

    // Read preview from disk so the chat header shows the real name
    const sessionId = this.sessionMap.get(threadId) ?? threadId;
    const filePath = path.join(claudeProjectDir(cwd), `${sessionId}.jsonl`);
    const meta = await readSessionMeta(filePath, sessionId, cwd);

    return {
      thread: makeThread(threadId, cwd, {
        status: { type: 'idle' },
        preview: meta?.preview ?? '',
      }),
      model: 'claude',
      modelProvider: 'anthropic',
      serviceTier: null,
      cwd,
      approvalPolicy: 'untrusted',
      sandbox: 'workspace-write',
      reasoningEffort: null,
    };
  }

  async sendTurn(prompt: string, options: { cwd: string; threadId: string; model?: string | null }): Promise<{ turn: object }> {
    const { cwd, threadId, model } = options;
    const turnId = randomUUID();

    this.cwdMap.set(threadId, cwd);

    const existingSessionId = this.sessionMap.get(threadId);

    const args = [
      '-p', prompt,
      '--output-format', 'stream-json',
      '--verbose',
    ];

    if (model) {
      args.push('--model', model);
    }

    if (existingSessionId) {
      args.push('--resume', existingSessionId);
    }

    this.emit('bridgeEvent', {
      type: 'notification',
      payload: {
        method: 'turn/started',
        params: { threadId, turn: makeTurn(turnId, 'inProgress') },
      },
    });

    this.emit('bridgeEvent', {
      type: 'notification',
      payload: {
        method: 'item/started',
        params: {
          threadId,
          turnId,
          item: {
            type: 'userMessage',
            id: `${turnId}-user`,
            content: [{ type: 'text', text: prompt, text_elements: [] }],
          },
        },
      },
    });

    // Set chat name from the first few words of the prompt
    const threadName = prompt.trim().split(/\s+/).slice(0, 6).join(' ');
    this.emit('bridgeEvent', {
      type: 'notification',
      payload: {
        method: 'thread/name/updated',
        params: { threadId, threadName },
      },
    });

    const child = spawn(this.claudeBin, args, {
      cwd,
      env: enrichedEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    }) as unknown as ChildProcessWithoutNullStreams;

    this.currentProcess = child;

    let stdoutBuffer = '';
    let agentMessageItemId: string | null = null;
    let agentTextAccumulated = '';

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdoutBuffer += chunk;
      let newlineIndex = stdoutBuffer.indexOf('\n');

      while (newlineIndex !== -1) {
        const line = stdoutBuffer.slice(0, newlineIndex).trim();
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
        newlineIndex = stdoutBuffer.indexOf('\n');

        if (!line) continue;

        try {
          const msg = JSON.parse(line) as ClaudeStreamMessage;
          this.handleStreamMessage(msg, threadId, turnId, {
            agentMessageItemId: () => agentMessageItemId,
            setAgentMessageItemId: (id: string) => { agentMessageItemId = id; },
            appendAgentText: (delta: string) => { agentTextAccumulated += delta; },
          });
        } catch {
          // Non-JSON line, ignore
        }
      }
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      this.emit('log', chunk.trim());
    });

    child.on('exit', (code, signal) => {
      this.currentProcess = null;

      if (agentMessageItemId && agentTextAccumulated) {
        this.emit('bridgeEvent', {
          type: 'notification',
          payload: {
            method: 'item/completed',
            params: {
              threadId,
              turnId,
              item: { type: 'agentMessage', id: agentMessageItemId, text: agentTextAccumulated, phase: null },
            },
          },
        });
      }

      const turnFinalStatus = code === 0 ? 'completed' : 'failed';
      this.emit('bridgeEvent', {
        type: 'notification',
        payload: {
          method: 'turn/completed',
          params: { threadId, turn: makeTurn(turnId, turnFinalStatus) },
        },
      });

      if (code !== 0 && signal !== 'SIGTERM' && signal !== 'SIGKILL') {
        this.emit('log', `claude exited with code=${code}, signal=${signal}`);
      }
    });

    return { turn: makeTurn(turnId, 'inProgress') };
  }

  interrupt(): void {
    if (this.currentProcess) {
      this.currentProcess.kill('SIGTERM');
      this.currentProcess = null;
    }
  }

  private handleStreamMessage(
    msg: ClaudeStreamMessage,
    threadId: string,
    turnId: string,
    ctx: {
      agentMessageItemId: () => string | null;
      setAgentMessageItemId: (id: string) => void;
      appendAgentText: (delta: string) => void;
    },
  ): void {
    if (msg.type === 'system' && msg.subtype === 'init') {
      this.sessionMap.set(threadId, msg.session_id);
      return;
    }

    if (msg.type === 'result') {
      if (msg.session_id) {
        this.sessionMap.set(threadId, msg.session_id);
      }
      return;
    }

    if (msg.type === 'assistant') {
      for (const contentBlock of msg.message.content) {
        if (contentBlock.type === 'text') {
          if (!ctx.agentMessageItemId()) {
            const itemId = randomUUID();
            ctx.setAgentMessageItemId(itemId);

            this.emit('bridgeEvent', {
              type: 'notification',
              payload: {
                method: 'item/started',
                params: {
                  threadId,
                  turnId,
                  item: { type: 'agentMessage', id: itemId, text: '', phase: null },
                },
              },
            });
          }

          this.emit('bridgeEvent', {
            type: 'notification',
            payload: {
              method: 'item/agentMessage/delta',
              params: { threadId, turnId, itemId: ctx.agentMessageItemId()!, delta: contentBlock.text },
            },
          });

          ctx.appendAgentText(contentBlock.text);
        } else if (contentBlock.type === 'tool_use') {
          this.emit('bridgeEvent', {
            type: 'notification',
            payload: {
              method: 'item/started',
              params: {
                threadId,
                turnId,
                item: {
                  type: 'dynamicToolCall',
                  id: contentBlock.id,
                  tool: contentBlock.name,
                  arguments: contentBlock.input,
                  status: 'running',
                  contentItems: null,
                  success: null,
                  durationMs: null,
                },
              },
            },
          });
        }
      }
    }

    if (msg.type === 'user') {
      for (const contentBlock of msg.message.content) {
        if (contentBlock.type === 'tool_result') {
          const outputText = contentBlock.content.map((c) => c.text).join('\n');
          this.emit('bridgeEvent', {
            type: 'notification',
            payload: {
              method: 'item/completed',
              params: {
                threadId,
                turnId,
                item: {
                  type: 'dynamicToolCall',
                  id: contentBlock.tool_use_id,
                  tool: contentBlock.tool_use_id,
                  arguments: {},
                  status: contentBlock.is_error ? 'failed' : 'completed',
                  contentItems: [{ type: 'inputText', text: outputText }],
                  success: !contentBlock.is_error,
                  durationMs: null,
                },
              },
            },
          });
        }
      }
    }
  }
}

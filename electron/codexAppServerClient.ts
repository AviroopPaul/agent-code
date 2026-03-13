import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

type JsonRpcId = string | number;

type JsonRpcRequest = {
  id: JsonRpcId;
  method: string;
  params?: unknown;
};

type JsonRpcNotification = {
  method: string;
  params?: unknown;
};

type JsonRpcResponse = {
  id: JsonRpcId;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
};

type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

type ClientEvents = {
  notification: [JsonRpcNotification];
  serverRequest: [JsonRpcRequest];
  stderr: [string];
  exit: [{ code: number | null; signal: NodeJS.Signals | null }];
};

class TypedEmitter extends EventEmitter {
  emit<EventName extends keyof ClientEvents>(eventName: EventName, ...args: ClientEvents[EventName]): boolean {
    return super.emit(eventName, ...args);
  }

  on<EventName extends keyof ClientEvents>(eventName: EventName, listener: (...args: ClientEvents[EventName]) => void): this {
    return super.on(eventName, listener);
  }
}

function isResponse(message: JsonRpcMessage): message is JsonRpcResponse {
  return 'id' in message && ('result' in message || 'error' in message) && !('method' in message);
}

function isRequest(message: JsonRpcMessage): message is JsonRpcRequest {
  return 'id' in message && 'method' in message;
}

function isNotification(message: JsonRpcMessage): message is JsonRpcNotification {
  return !('id' in message) && 'method' in message;
}

export class CodexAppServerClient extends TypedEmitter {
  private process: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private stdoutBuffer = '';
  private stderrBuffer = '';
  private stopping = false;
  private readonly pending = new Map<JsonRpcId, { resolve: (value: unknown) => void; reject: (reason?: unknown) => void }>();

  async start(codexBin: string): Promise<void> {
    if (this.process) {
      return;
    }

    this.stopping = false;
    this.process = spawn(codexBin, ['app-server', '--listen', 'stdio://'], {
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.process.stdout.setEncoding('utf8');
    this.process.stdout.on('data', (chunk: string) => {
      this.stdoutBuffer += chunk;
      this.flushStdout();
    });

    this.process.stderr.setEncoding('utf8');
    this.process.stderr.on('data', (chunk: string) => {
      this.stderrBuffer += chunk;
      this.flushStderr();
    });

    this.process.on('exit', (code, signal) => {
      this.process = null;
      const error = new Error(`Codex app-server exited unexpectedly (code=${code}, signal=${signal})`);

      if (!this.stopping) {
        for (const pending of this.pending.values()) {
          pending.reject(error);
        }
      }

      this.pending.clear();
      this.stopping = false;
      this.emit('exit', { code, signal });
    });
  }

  async stop(): Promise<void> {
    if (!this.process) {
      return;
    }

    this.stopping = true;
    const current = this.process;
    this.process = null;
    current.kill();
  }

  async request<T>(method: string, params?: unknown): Promise<T> {
    const id = this.nextId++;
    const payload: JsonRpcRequest = { id, method, params };

    await this.send(payload);

    return await new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
    });
  }

  async notify(method: string, params?: unknown): Promise<void> {
    await this.send({ method, params });
  }

  async respond(id: JsonRpcId, result?: unknown, error?: JsonRpcResponse['error']): Promise<void> {
    if (error) {
      await this.send({ id, error });
      return;
    }

    await this.send({ id, result });
  }

  private async send(message: JsonRpcMessage): Promise<void> {
    if (!this.process) {
      throw new Error('Codex app-server is not running.');
    }

    const serialized = JSON.stringify(message);
    await new Promise<void>((resolve, reject) => {
      this.process?.stdin.write(`${serialized}\n`, (error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }

  private flushStdout(): void {
    let newlineIndex = this.stdoutBuffer.indexOf('\n');

    while (newlineIndex !== -1) {
      const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);

      if (line) {
        this.handleMessage(line);
      }

      newlineIndex = this.stdoutBuffer.indexOf('\n');
    }
  }

  private flushStderr(): void {
    let newlineIndex = this.stderrBuffer.indexOf('\n');

    while (newlineIndex !== -1) {
      const line = this.stderrBuffer.slice(0, newlineIndex).trim();
      this.stderrBuffer = this.stderrBuffer.slice(newlineIndex + 1);

      if (line) {
        this.emit('stderr', line);
      }

      newlineIndex = this.stderrBuffer.indexOf('\n');
    }
  }

  private handleMessage(serialized: string): void {
    const message = JSON.parse(serialized) as JsonRpcMessage;

    if (isResponse(message)) {
      const pending = this.pending.get(message.id);

      if (!pending) {
        return;
      }

      this.pending.delete(message.id);

      if (message.error) {
        pending.reject(new Error(message.error.message));
        return;
      }

      pending.resolve(message.result);
      return;
    }

    if (isRequest(message)) {
      this.emit('serverRequest', message);
      return;
    }

    if (isNotification(message)) {
      this.emit('notification', message);
    }
  }
}

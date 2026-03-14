import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron';
import { spawn } from 'node:child_process';
import path from 'node:path';

import { CodexAppServerClient } from './codexAppServerClient';

import type { InitializeParams } from '../src/shared/protocol/InitializeParams';
import type { InitializeResponse } from '../src/shared/protocol/InitializeResponse';
import type { ModelListResponse } from '../src/shared/protocol/v2/ModelListResponse';
import type { ThreadListResponse } from '../src/shared/protocol/v2/ThreadListResponse';
import type { ThreadReadResponse } from '../src/shared/protocol/v2/ThreadReadResponse';
import type { ThreadResumeResponse } from '../src/shared/protocol/v2/ThreadResumeResponse';
import type { ThreadStartResponse } from '../src/shared/protocol/v2/ThreadStartResponse';
import type { TurnInterruptResponse } from '../src/shared/protocol/v2/TurnInterruptResponse';
import type { TurnStartResponse } from '../src/shared/protocol/v2/TurnStartResponse';

const preloadPath = path.join(__dirname, 'preload.cjs');
const rendererIndexPath = path.join(app.getAppPath(), 'dist', 'index.html');

type ClientEnvelope =
  | { type: 'backend-status'; payload: { connected: boolean; userAgent?: string; codexBin?: string; error?: string } }
  | { type: 'backend-log'; payload: { message: string } }
  | { type: 'notification'; payload: unknown }
  | { type: 'server-request'; payload: unknown };

const codex = new CodexAppServerClient();
let mainWindow: BrowserWindow | null = null;
let backendStartPromise: Promise<{ userAgent: string; codexBin: string; models: ModelListResponse['data'] }> | null = null;
let backendSnapshot: { userAgent: string; codexBin: string; models: ModelListResponse['data'] } | null = null;

app.setName('Agent Code');
app.setAboutPanelOptions({
  applicationName: 'Agent Code',
  applicationVersion: app.getVersion(),
  version: app.getVersion(),
});

if (process.platform === 'win32') {
  app.setAppUserModelId('com.agentcode.desktop');
}

function emitToRenderer(event: ClientEnvelope): void {
  mainWindow?.webContents.send('codex:event', event);
}

function installApplicationMenu(): void {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' as const }] : [{ role: 'fileMenu' as const }]),
    { role: 'editMenu' as const },
    { role: 'viewMenu' as const },
    { role: 'windowMenu' as const },
    {
      role: 'help' as const,
      submenu: [
        {
          label: 'Agent Code',
          enabled: false,
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function getCodexBin(): string {
  return process.env.CODEX_BIN || 'codex';
}

function spawnDetached(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: 'ignore',
    });

    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

async function openInCursor(cwd: string): Promise<void> {
  try {
    await spawnDetached('cursor', [cwd]);
    return;
  } catch {
    if (process.platform === 'darwin') {
      await spawnDetached('open', ['-a', 'Cursor', cwd]);
      return;
    }

    throw new Error('Cursor is not installed or the `cursor` command is unavailable.');
  }
}

async function startBackend(): Promise<{ userAgent: string; codexBin: string; models: ModelListResponse['data'] }> {
  if (backendSnapshot) {
    emitToRenderer({
      type: 'backend-status',
      payload: {
        connected: true,
        userAgent: backendSnapshot.userAgent,
        codexBin: backendSnapshot.codexBin,
      },
    });

    return backendSnapshot;
  }

  if (backendStartPromise) {
    return await backendStartPromise;
  }

  backendStartPromise = (async () => {
  const codexBin = getCodexBin();
    await codex.start(codexBin);

    const initializeParams: InitializeParams = {
      clientInfo: {
        name: 'agent_code',
        title: 'Agent Code',
        version: '0.1.0',
      },
      capabilities: {
        experimentalApi: true,
        optOutNotificationMethods: null,
      },
    };

    const initializeResponse = await codex.request<InitializeResponse>('initialize', initializeParams);
    await codex.notify('initialized', {});
    const modelListResponse = await codex.request<ModelListResponse>('model/list', { includeHidden: false });

    backendSnapshot = {
      userAgent: initializeResponse.userAgent,
      codexBin,
      models: modelListResponse.data,
    };

    emitToRenderer({
      type: 'backend-status',
      payload: {
        connected: true,
        userAgent: initializeResponse.userAgent,
        codexBin,
      },
    });

    return backendSnapshot;
  })();

  try {
    return await backendStartPromise;
  } finally {
    backendStartPromise = null;
  }
}

async function createWindow(): Promise<void> {
  const isMac = process.platform === 'darwin';
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 980,
    minWidth: 1180,
    minHeight: 780,
    backgroundColor: isMac ? '#00000000' : '#0e1411',
    title: 'Agent Code',
    titleBarStyle: 'hiddenInset',
    transparent: isMac,
    vibrancy: isMac ? 'sidebar' : undefined,
    visualEffectState: isMac ? 'active' : undefined,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.on('page-title-updated', (event) => {
    event.preventDefault();
    mainWindow?.setTitle('Agent Code');
  });

  if (isMac) {
    mainWindow.setVibrancy('sidebar');
  }

  const devServerUrl = process.env.VITE_DEV_SERVER_URL;

  if (devServerUrl) {
    await mainWindow.loadURL(devServerUrl);
    mainWindow.setTitle('Agent Code');
    return;
  }

  await mainWindow.loadFile(rendererIndexPath);
  mainWindow.setTitle('Agent Code');
}

codex.on('notification', (notification) => {
  emitToRenderer({ type: 'notification', payload: notification });
});

codex.on('serverRequest', (request) => {
  emitToRenderer({ type: 'server-request', payload: request });
});

codex.on('stderr', (message) => {
  emitToRenderer({ type: 'backend-log', payload: { message } });
});

codex.on('exit', ({ code, signal }) => {
  backendSnapshot = null;
  backendStartPromise = null;
  emitToRenderer({
    type: 'backend-status',
    payload: {
      connected: false,
      error: `Codex backend stopped (code=${code}, signal=${signal}).`,
    },
  });
});

ipcMain.handle('codex:get-cwd', () => process.cwd());

ipcMain.handle('codex:start-backend', async () => await startBackend());

ipcMain.handle('codex:stop-backend', async () => {
  backendSnapshot = null;
  backendStartPromise = null;
  await codex.stop();
  emitToRenderer({
    type: 'backend-status',
    payload: {
      connected: false,
    },
  });
});

ipcMain.handle('codex:select-workspace', async () => {
  const result = await dialog.showOpenDialog(mainWindow!, {
    properties: ['openDirectory'],
  });

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  return result.filePaths[0];
});

ipcMain.handle('codex:create-session', async (_event, cwd: string) => {
  return await codex.request<ThreadStartResponse>('thread/start', {
    cwd,
    approvalPolicy: 'untrusted',
    sandbox: 'workspace-write',
    personality: 'pragmatic',
    experimentalRawEvents: false,
    persistExtendedHistory: true,
  });
});

ipcMain.handle('codex:list-threads', async (_event, cwd: string) => {
  return await codex.request<ThreadListResponse>('thread/list', {
    cwd,
    limit: 100,
    archived: false,
    sortKey: 'updated_at',
  });
});

ipcMain.handle('codex:read-thread', async (_event, threadId: string) => {
  return await codex.request<ThreadReadResponse>('thread/read', {
    threadId,
    includeTurns: true,
  });
});

ipcMain.handle('codex:resume-thread', async (_event, payload: { threadId: string; cwd?: string | null }) => {
  return await codex.request<ThreadResumeResponse>('thread/resume', {
    threadId: payload.threadId,
    cwd: payload.cwd ?? null,
    approvalPolicy: 'untrusted',
    sandbox: 'workspace-write',
    personality: 'pragmatic',
    persistExtendedHistory: true,
  });
});

ipcMain.handle('codex:send-turn', async (_event, payload: { threadId: string; cwd: string; text: string; images?: string[]; model?: string | null; effort?: string | null }) => {
  return await codex.request<TurnStartResponse>('turn/start', {
    threadId: payload.threadId,
    cwd: payload.cwd,
    model: payload.model ?? null,
    effort: payload.effort ?? null,
    input: [
      ...(payload.images ?? []).map((url) => ({
        type: 'image' as const,
        url,
      })),
      ...(payload.text.trim()
        ? [
            {
              type: 'text' as const,
              text: payload.text,
              text_elements: [],
            },
          ]
        : []),
    ],
  });
});

ipcMain.handle('codex:interrupt-turn', async (_event, payload: { threadId: string; turnId: string }) => {
  return await codex.request<TurnInterruptResponse>('turn/interrupt', payload);
});

ipcMain.handle('codex:resolve-server-request', async (_event, payload: { id: string | number; result?: unknown; error?: { code: number; message: string; data?: unknown } }) => {
  await codex.respond(payload.id, payload.result, payload.error);
});

ipcMain.handle('codex:open-external', async (_event, url: string) => {
  await shell.openExternal(url);
});

ipcMain.handle('codex:open-in-cursor', async (_event, cwd: string) => {
  await openInCursor(cwd);
});

app.whenReady().then(async () => {
  installApplicationMenu();
  await createWindow();

  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

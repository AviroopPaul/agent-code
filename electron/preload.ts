import { contextBridge, ipcRenderer } from 'electron';

const api = {
  setAgent: async (agent: string) => await ipcRenderer.invoke('codex:set-agent', agent),
  getCwd: async () => await ipcRenderer.invoke('codex:get-cwd') as string,
  startBackend: async () => await ipcRenderer.invoke('codex:start-backend'),
  stopBackend: async () => await ipcRenderer.invoke('codex:stop-backend'),
  selectWorkspace: async () => await ipcRenderer.invoke('codex:select-workspace'),
  createSession: async (cwd: string) => await ipcRenderer.invoke('codex:create-session', cwd),
  listThreads: async (cwd: string) => await ipcRenderer.invoke('codex:list-threads', cwd),
  readThread: async (threadId: string) => await ipcRenderer.invoke('codex:read-thread', threadId),
  resumeThread: async (threadId: string, cwd?: string | null) => await ipcRenderer.invoke('codex:resume-thread', { threadId, cwd }),
  sendTurn: async (payload: { threadId: string; cwd: string; text: string; images?: string[]; model?: string | null; effort?: string | null }) =>
    await ipcRenderer.invoke('codex:send-turn', payload),
  interruptTurn: async (payload: { threadId: string; turnId: string }) => await ipcRenderer.invoke('codex:interrupt-turn', payload),
  resolveServerRequest: async (payload: { id: string | number; result?: unknown; error?: { code: number; message: string; data?: unknown } }) =>
    await ipcRenderer.invoke('codex:resolve-server-request', payload),
  openExternal: async (url: string) => await ipcRenderer.invoke('codex:open-external', url),
  openInCursor: async (cwd: string) => await ipcRenderer.invoke('codex:open-in-cursor', cwd),
  subscribe: (listener: (event: unknown) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: unknown) => {
      listener(payload);
    };

    ipcRenderer.on('codex:event', wrapped);

    return () => {
      ipcRenderer.off('codex:event', wrapped);
    };
  },
};

contextBridge.exposeInMainWorld('codex', api);

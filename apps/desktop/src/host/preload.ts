import { contextBridge, ipcRenderer } from 'electron';
contextBridge.exposeInMainWorld('ocean', {
  request: (command: unknown): Promise<unknown> => ipcRenderer.invoke('ocean:request', command),
});

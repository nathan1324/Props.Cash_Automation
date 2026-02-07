import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('api', {
  getStatus: () => ipcRenderer.invoke('get-status'),
  getSchedule: () => ipcRenderer.invoke('get-schedule'),

  initAuth: () => ipcRenderer.invoke('init-auth'),
  runAutomation: () => ipcRenderer.invoke('run-automation'),

  scheduleEnable: (time: string) => ipcRenderer.invoke('schedule-enable', time),
  scheduleDisable: () => ipcRenderer.invoke('schedule-disable'),
  scheduleUpdateTime: (time: string) => ipcRenderer.invoke('schedule-update-time', time),

  onConsoleOutput: (callback: (line: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, line: string) => callback(line);
    ipcRenderer.on('console-output', handler);
    return () => ipcRenderer.removeListener('console-output', handler);
  },

  onProcessDone: (callback: (type: string, code: number | null) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, type: string, code: number | null) =>
      callback(type, code);
    ipcRenderer.on('process-done', handler);
    return () => ipcRenderer.removeListener('process-done', handler);
  },
});

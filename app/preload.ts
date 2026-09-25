/**
 * Мост окна настроек: страница видит только эти вызовы, без Node и файлов.
 */

import { contextBridge, ipcRenderer } from 'electron';

const CHANNEL = 'jarvis-settings';

contextBridge.exposeInMainWorld('jarvis', {
  state: () => ipcRenderer.invoke(`${CHANNEL}:state`),
  update: (patch: Record<string, unknown>) => ipcRenderer.invoke(`${CHANNEL}:update`, patch),
  finish: () => ipcRenderer.invoke(`${CHANNEL}:finish`),
  install: (kind: 'whisper' | 'voice', id: string) => ipcRenderer.invoke(`${CHANNEL}:install`, kind, id),
  preview: (voiceId: string, text: string) => ipcRenderer.invoke(`${CHANNEL}:preview`, voiceId, text),
  open: (target: 'home' | 'log' | 'output') => ipcRenderer.invoke(`${CHANNEL}:open`, target),
  chooseFolder: () => ipcRenderer.invoke(`${CHANNEL}:chooseFolder`),
  checkLocal: (url: string, model: string) => ipcRenderer.invoke(`${CHANNEL}:checkLocal`, url, model),
  signIn: (cli: 'claude' | 'codex') => ipcRenderer.invoke(`${CHANNEL}:signIn`, cli),
  openUrl: (url: string) => ipcRenderer.invoke(`${CHANNEL}:openUrl`, url),
  onProgress: (listener: (progress: unknown) => void) => {
    ipcRenderer.on(`${CHANNEL}:progress`, (_event, progress) => listener(progress));
  },
  onPage: (listener: (page: string) => void) => {
    ipcRenderer.on(`${CHANNEL}:page`, (_event, page) => listener(page));
  },
});

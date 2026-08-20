const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('studio', {
  loadState: () => ipcRenderer.invoke('state:load'),
  saveProfile: (profile) => ipcRenderer.invoke('state:save-profile', profile),
  saveExecution: (execution) => ipcRenderer.invoke('state:save-execution', execution),
  saveProvider: (provider) => ipcRenderer.invoke('provider:save', provider),
  saveYouTubeSecrets: (secrets) => ipcRenderer.invoke('youtube:save-secrets', secrets),
  fetchYouTubeContext: (input) => ipcRenderer.invoke('youtube:fetch-context', input),
  runAnalysis: (context) => ipcRenderer.invoke('analysis:run', context),
  chat: (input) => ipcRenderer.invoke('llm:chat', input),
  simulate: (input) => ipcRenderer.invoke('execution:simulate', input),
  executeYouTube: (input) => ipcRenderer.invoke('execution:youtube', input),
  runYouTubeCycle: (input) => ipcRenderer.invoke('execution:youtube-cycle', input),
  listLedger: () => ipcRenderer.invoke('ledger:list'),
  listCapabilities: () => ipcRenderer.invoke('capabilities:list'),
});

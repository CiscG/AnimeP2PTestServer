const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    listarJanelas: () => ipcRenderer.invoke('listar-janelas'),
    iniciarAudio: (sourceId) => ipcRenderer.invoke('iniciar-audio', sourceId),
    pararAudio: () => ipcRenderer.invoke('parar-audio'),
    onAudioChunk: (callback) => ipcRenderer.on('audio-chunk', (event, data, meta) => callback(data, meta))
});
// Cầu nối an toàn giữa giao diện và tiến trình chính: giao diện chỉ gọi được đúng các chức năng dưới đây.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tpanel', {
  desktop: true,
  info: () => ipcRenderer.invoke('app:info'),
  pickFolder: def => ipcRenderer.invoke('pick-folder', def),
  pickFile: opts => ipcRenderer.invoke('pick-file', opts),
  getAutostart: () => ipcRenderer.invoke('autostart:get'),
  setAutostart: on => ipcRenderer.invoke('autostart:set', on),
  update: {
    check: repo => ipcRenderer.invoke('update:check', repo),
    download: () => ipcRenderer.invoke('update:download'),
    install: () => ipcRenderer.invoke('update:install'),
    fromFile: () => ipcRenderer.invoke('update:from-file'),
    onProgress: cb => ipcRenderer.on('update:progress', (e, p) => cb(p)),
  },
});

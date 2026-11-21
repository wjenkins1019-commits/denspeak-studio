'use strict';

// Minimal bridge for the studio window. The only privileged thing the UI
// needs is writing an exported file where the user chooses: the path always
// comes from the native dialog in the main process, never from the page, so
// the renderer cannot write anywhere it was not invited to.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('denspeak', {
  isDesktop: true,
  saveFile: (input) => ipcRenderer.invoke('denspeak:save-file', input),
});

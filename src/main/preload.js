// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PEDREA, spol. s r. o.
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('satchel', {
  getSessions: invoke('sessions:get'),
  launch: invoke('sessions:launch'),
  resumeCandidates: invoke('sessions:resumeCandidates'),
  newSession: invoke('ui:newSession'),
  newSessionDone: invoke('ui:newSessionDone'),
  focus: invoke('sessions:focus'),
  rename: invoke('sessions:rename'),
  setGroup: invoke('sessions:setGroup'),
  close: invoke('sessions:close'),
  minimize: invoke('sessions:minimize'),
  restore: invoke('sessions:restore'),
  forget: invoke('sessions:forget'),
  tile: invoke('sessions:tile'),
  cascade: invoke('sessions:cascade'),
  minimizeGroup: invoke('sessions:minimizeGroup'),
  raiseGroup: invoke('sessions:raiseGroup'),
  contextMenu: invoke('sessions:contextMenu'),
  dockInteractive: invoke('ui:dockInteractive'),
  getConfig: invoke('config:get'),
  openConfig: invoke('config:open'),
  reloadConfig: invoke('config:reload'),
  getDisplays: invoke('displays:get'),
  setAlwaysOnTop: invoke('window:setAlwaysOnTop'),
  getAlwaysOnTop: invoke('window:getAlwaysOnTop'),
  setDock: invoke('window:setDock'),
  hideToTray: invoke('window:hideToTray'),
  pickDir: invoke('dialog:pickDir'),
  appInfo: invoke('app:info'),
  hookStatus: invoke('hooks:status'),
  installHooks: invoke('hooks:install'),
  onSessions(cb) {
    const handler = (_e, list) => cb(list);
    ipcRenderer.on('sessions:update', handler);
    return () => ipcRenderer.removeListener('sessions:update', handler);
  },
  onStartRename(cb) {
    ipcRenderer.on('sessions:startRename', (_e, id) => cb(id));
  },
});

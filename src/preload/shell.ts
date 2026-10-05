// Preload de la coque (fenêtre principale et paramètres) : API typée et minimale,
// aucun accès direct à ipcRenderer depuis l'UI.

import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { CHANNELS } from "../shared/channels";
import type { Command, SettingsState, ShellState } from "../shared/ipc";

function subscribe<T>(channel: string, callback: (value: T) => void): () => void {
  const listener = (_event: IpcRendererEvent, value: T) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api = {
  getShellState: (): Promise<ShellState | null> => ipcRenderer.invoke(CHANNELS.shellGetState),
  getSettingsState: (): Promise<SettingsState | null> => ipcRenderer.invoke(CHANNELS.settingsGetState),
  onShellState: (callback: (state: ShellState) => void) => subscribe(CHANNELS.shellState, callback),
  onSettingsState: (callback: (state: SettingsState) => void) => subscribe(CHANNELS.settingsState, callback),
  onRequestAddAccount: (callback: () => void) => subscribe(CHANNELS.shellRequestAddAccount, callback),
  onRequestSnoozeDate: (callback: (accountId: string) => void) => subscribe(CHANNELS.shellRequestSnoozeDate, callback),
  onRequestFocusAccounts: (callback: () => void) => subscribe(CHANNELS.shellRequestFocusAccounts, callback),
  onRequestShortcuts: (callback: () => void) => subscribe(CHANNELS.shellRequestShortcuts, callback),
  command: (command: Command): void => ipcRenderer.send(CHANNELS.command, command)
};

export type WhatHushApi = typeof api;

contextBridge.exposeInMainWorld("whathush", api);

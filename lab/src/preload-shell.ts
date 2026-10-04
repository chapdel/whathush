// Preload de la coque : API typée, aucun accès direct à ipcRenderer depuis l'UI.

import { contextBridge, ipcRenderer } from "electron";
import type { LogEntry, ShellState } from "./shared";

contextBridge.exposeInMainWorld("lab", {
  getState: (): Promise<ShellState> => ipcRenderer.invoke("shell:get-state"),
  getLogs: (): Promise<LogEntry[]> => ipcRenderer.invoke("shell:get-logs"),
  command: (command: { type: string; id?: string; label?: string }) => ipcRenderer.send("shell:command", command),
  onState: (callback: (state: ShellState) => void) => {
    ipcRenderer.on("lab:state", (_event, state: ShellState) => callback(state));
  },
  onLog: (callback: (entry: LogEntry) => void) => {
    ipcRenderer.on("lab:log", (_event, entry: LogEntry) => callback(entry));
  }
});

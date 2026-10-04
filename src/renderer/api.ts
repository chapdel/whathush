import { useEffect, useState } from "react";
import type { WhatHushApi } from "../preload/shell";
import type { SettingsState, ShellState } from "../shared/ipc";

declare global {
  interface Window {
    whathush: WhatHushApi;
  }
}

export const api = window.whathush;

export function useWindowWidth(): number {
  const [width, setWidth] = useState(window.innerWidth);
  useEffect(() => {
    const resize = () => setWidth(window.innerWidth);
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  return width;
}

export function useShellState(): ShellState | null {
  const [state, setState] = useState<ShellState | null>(null);
  useEffect(() => {
    const unsubscribe = api.onShellState(setState);
    void api.getShellState().then((initial) => initial && setState(initial));
    return unsubscribe;
  }, []);
  return state;
}

export function useSettingsState(): SettingsState | null {
  const [state, setState] = useState<SettingsState | null>(null);
  useEffect(() => {
    const unsubscribe = api.onSettingsState(setState);
    void api.getSettingsState().then((initial) => initial && setState(initial));
    return unsubscribe;
  }, []);
  return state;
}

/** Heure courante rafraîchie régulièrement, pour les durées restantes. */
export function useNow(intervalMs = 30_000): Date {
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((tick) => tick + 1), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  // Lire aussi l'heure lors d'un changement IPC : un nouveau Snooze de 30 min
  // ne doit pas afficher 31 min en utilisant l'heure du tick précédent.
  return new Date();
}

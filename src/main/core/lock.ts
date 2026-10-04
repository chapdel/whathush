// Verrouillage par code (F6) : décisions pures. Le hachage (scrypt) et l'écoute du
// verrouillage de session vivent dans security/lock-service.ts.
// Ce verrou protège la lecture à l'écran ; il ne chiffre pas les sessions (§27).

import type { LockSettings } from "../../shared/schemas";

export const MIN_CODE_LENGTH = 4;
export const MAX_CODE_LENGTH = 128;
export const MAX_DELAY_MS = 60_000;

/** Délai imposé après n échecs consécutifs : 0, puis 1 s, 2 s, 4 s… plafonné à 60 s. */
export function failureDelayMs(failures: number): number {
  if (failures <= 0) return 0;
  return Math.min(MAX_DELAY_MS, 1000 * 2 ** (failures - 1));
}

/** Instant à partir duquel un nouvel essai est permis ; null si tout de suite. */
export function retryAt(failures: { count: number; lastAt: string | null }, now: Date): Date | null {
  if (failures.count <= 0 || !failures.lastAt) return null;
  const at = new Date(new Date(failures.lastAt).getTime() + failureDelayMs(failures.count));
  return at.getTime() > now.getTime() ? at : null;
}

export type LockTrigger = "start" | "hide" | "idle" | "screen-lock" | "manual";

/** Faut-il verrouiller pour ce déclencheur ? */
export function shouldLock(settings: Pick<LockSettings, "enabled" | "onStart" | "onHide" | "idleMinutes" | "onScreenLock">, trigger: LockTrigger, idleSeconds = 0): boolean {
  if (!settings.enabled) return false;
  switch (trigger) {
    case "manual":
      return true;
    case "start":
      return settings.onStart;
    case "hide":
      return settings.onHide;
    case "screen-lock":
      return settings.onScreenLock;
    case "idle":
      return settings.idleMinutes > 0 && idleSeconds >= settings.idleMinutes * 60;
  }
}

export function validCode(code: string): boolean {
  return code.length >= MIN_CODE_LENGTH && code.length <= MAX_CODE_LENGTH;
}

/**
 * Verrouillage de la session du bureau, lu sur la sortie de `gdbus monitor` (l'événement
 * lock-screen d'Electron n'existe pas sous Linux). true = verrouillée, false = déverrouillée,
 * null = ligne sans rapport.
 *   logind      : Session.Lock (), Session.Unlock (), PropertiesChanged … 'LockedHint': <true>
 *   ScreenSaver : org.freedesktop.ScreenSaver.ActiveChanged (true,) (KDE, autres)
 *   GNOME       : org.gnome.ScreenSaver.ActiveChanged (true,)
 */
export function parseLockSignal(line: string): boolean | null {
  if (/\.login1\.Session\.Lock \(\)/.test(line)) return true;
  if (/\.login1\.Session\.Unlock \(\)/.test(line)) return false;
  const hint = /'LockedHint': <(true|false)>/.exec(line);
  if (hint && line.includes("org.freedesktop.login1.Session")) return hint[1] === "true";
  const screensaver = /(?:org\.freedesktop|org\.gnome)\.ScreenSaver\.ActiveChanged \((true|false),?\)/.exec(line);
  if (screensaver) return screensaver[1] === "true";
  return null;
}

/** Chemin d'objet logind de la session, depuis la réponse de GetSession / GetSessionByPID. */
export function parseSessionPath(output: string): string | null {
  const match = /'(\/org\/freedesktop\/login1\/session\/[A-Za-z0-9_]+)'/.exec(output);
  return match?.[1] ?? null;
}

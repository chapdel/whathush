// AccountStateMachine (§2.1) et décision de reprise après crash (§32).

import type { Lifecycle } from "../../shared/ipc";

export type { Lifecycle };

export type LifecycleEvent =
  | "wake"
  | "session-valid"
  | "link-required"
  | "linked"
  | "network-lost"
  | "network-restored"
  | "remote-logout"
  | "renderer-gone"
  | "recreate"
  | "sleep";

const TRANSITIONS: Record<Lifecycle, Partial<Record<LifecycleEvent, Lifecycle>>> = {
  sleeping: { wake: "loading" },
  loading: {
    "session-valid": "ready",
    "link-required": "needs_qr",
    "network-lost": "offline",
    "renderer-gone": "crashed",
    sleep: "sleeping"
  },
  needs_qr: { linked: "ready", "renderer-gone": "crashed", sleep: "sleeping" },
  ready: { "network-lost": "offline", "remote-logout": "needs_qr", "renderer-gone": "crashed", sleep: "sleeping" },
  offline: {
    "network-restored": "ready",
    "remote-logout": "needs_qr",
    // Compte jamais relié dont le chargement avait échoué : le QR s'affiche enfin.
    "link-required": "needs_qr",
    "renderer-gone": "crashed",
    sleep: "sleeping"
  },
  crashed: { recreate: "loading", sleep: "sleeping" }
};

/** État suivant, ou null si l'événement n'a pas de sens dans cet état. */
export function transition(state: Lifecycle, event: LifecycleEvent): Lifecycle | null {
  return TRANSITIONS[state][event] ?? null;
}

/** Un compte dans cet état possède une WebContents. */
export function hasWebContents(state: Lifecycle): boolean {
  return state !== "sleeping" && state !== "crashed";
}

// --- Reprise après crash (§32) --------------------------------------------------

export const CRASH_BACKOFF_MS = [1_000, 5_000, 30_000] as const;
export const CRASH_WINDOW_MS = 5 * 60_000;

export type CrashDecision = { action: "recreate"; delayMs: number } | { action: "give-up" };

/**
 * À appeler à chaque `render-process-gone`. Recrée avec un délai croissant ;
 * abandonne au 4e crash en moins de 5 minutes.
 */
export function onRendererGone(
  previousCrashes: readonly number[],
  now: number
): { crashTimes: number[]; decision: CrashDecision } {
  const crashTimes = [...previousCrashes.filter((time) => now - time < CRASH_WINDOW_MS), now];
  const delayMs = CRASH_BACKOFF_MS[crashTimes.length - 1];
  return {
    crashTimes,
    decision: delayMs === undefined ? { action: "give-up" } : { action: "recreate", delayMs }
  };
}

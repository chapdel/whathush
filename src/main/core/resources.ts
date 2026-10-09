// Décisions du ResourceMonitor : veille automatique, suggestion du mode économie,
// recyclage des pages WhatsApp qui gonflent au fil des jours.

import type { Lifecycle } from "../../shared/ipc";
import type { Delivery } from "../../shared/schemas";

export interface AutoSleepInput {
  id: string;
  autoSleepAfterMinutes?: number;
  /** Mode économie : le compte dort déjà entre deux relèves, la veille automatique les arrêterait. */
  delivery: Delivery;
  sleeping: boolean;
  active: boolean;
  inCall: boolean;
  /** Instant (ms) depuis lequel le compte n'est plus affiché ; null s'il l'est. */
  hiddenSince: number | null;
}

/** Comptes à mettre en veille maintenant : option activée, caché assez longtemps, jamais pendant un appel ni en mode économie. */
export function accountsToAutoSleep(inputs: readonly AutoSleepInput[], now: number): string[] {
  return inputs
    .filter(
      (input) =>
        input.autoSleepAfterMinutes !== undefined &&
        input.delivery !== "periodic" &&
        !input.sleeping &&
        !input.active &&
        !input.inCall &&
        input.hiddenSince !== null &&
        now - input.hiddenSince >= input.autoSleepAfterMinutes * 60_000
    )
    .map((input) => input.id);
}

export const RAM_SUGGESTION_MB = 1536;
export const RAM_SUGGESTION_HIDDEN_MS = 30 * 60_000;

export interface SleepSuggestionInput {
  id: string;
  label: string;
  /** Un compte déjà en mode économie n'est plus proposé. */
  delivery: Delivery;
  sleeping: boolean;
  active: boolean;
  inCall: boolean;
  hiddenSince: number | null;
  memoryMB: number | null;
}

/**
 * Quand l'application dépasse le seuil de mémoire, propose le mode économie pour le
 * compte caché depuis le plus longtemps (au moins 30 min), hors appel.
 */
export function sleepSuggestion(totalMB: number | null, inputs: readonly SleepSuggestionInput[], now: number): SleepSuggestionInput | null {
  if (totalMB === null || totalMB < RAM_SUGGESTION_MB) return null;
  const candidates = inputs.filter(
    (input) =>
      input.delivery === "realtime" && !input.sleeping && !input.active && !input.inCall && input.hiddenSince !== null && now - input.hiddenSince >= RAM_SUGGESTION_HIDDEN_MS
  );
  candidates.sort((a, b) => (a.hiddenSince ?? 0) - (b.hiddenSince ?? 0));
  return candidates[0] ?? null;
}

// --- Recyclage ------------------------------------------------------------------------

export interface RecycleThresholds {
  /** Mémoire (RSS) minimale d'une page pour la recycler. */
  minMB: number;
  /** … et au moins ce multiple de sa mémoire mesurée après installation. */
  growthFactor: number;
  /** Caché depuis au moins ce délai. */
  hiddenMs: number;
  /** Sans absence ni fenêtre masquée, seulement après ce délai caché. */
  longHiddenMs: number;
  /** Au plus une fois par compte sur cette durée. */
  everyMs: number;
  /** Mémoire de référence d'une page : mesurée ce délai après son chargement. */
  baselineAfterMs: number;
}

export const RECYCLE: RecycleThresholds = {
  minMB: 700,
  growthFactor: 2,
  hiddenMs: 60 * 60_000,
  longHiddenMs: 4 * 60 * 60_000,
  everyMs: 12 * 60 * 60_000,
  baselineAfterMs: 3 * 60_000
};

export interface RecycleInput {
  id: string;
  lifecycle: Lifecycle;
  rssMB: number | null;
  baselineMB: number | null;
  /** Compte affiché (sélectionné). */
  active: boolean;
  inCall: boolean;
  playing: boolean;
  hiddenSince: number | null;
  lastRecycledAt: number | null;
}

/**
 * Compte à recharger maintenant (au plus un à la fois) : caché, connecté, hors appel et
 * lecture, dont la page a doublé depuis son chargement. De préférence pendant une absence
 * ou fenêtre masquée : un rechargement coûte quelques secondes de processeur.
 */
export function recycleCandidate(
  inputs: readonly RecycleInput[],
  context: { now: number; userAway: boolean; windowHidden: boolean; thresholds?: RecycleThresholds }
): string | null {
  const limits = context.thresholds ?? RECYCLE;
  const due = inputs.filter((input) => {
    if (input.lifecycle !== "ready" || input.active || input.inCall || input.playing) return false;
    if (input.rssMB === null || input.baselineMB === null || input.hiddenSince === null) return false;
    if (input.lastRecycledAt !== null && context.now - input.lastRecycledAt < limits.everyMs) return false;
    const hidden = context.now - input.hiddenSince;
    if (hidden < limits.hiddenMs) return false;
    if (!context.userAway && !context.windowHidden && hidden < limits.longHiddenMs) return false;
    return input.rssMB >= Math.max(limits.minMB, limits.growthFactor * input.baselineMB);
  });
  due.sort((a, b) => (b.rssMB ?? 0) - (a.rssMB ?? 0));
  return due[0]?.id ?? null;
}

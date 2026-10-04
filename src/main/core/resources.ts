// Décisions du ResourceMonitor (§17) : veille automatique.

export interface AutoSleepInput {
  id: string;
  autoSleepAfterMinutes?: number;
  sleeping: boolean;
  active: boolean;
  inCall: boolean;
  /** Instant (ms) depuis lequel le compte n'est plus affiché ; null s'il l'est. */
  hiddenSince: number | null;
}

/** Comptes à mettre en veille maintenant : option activée, caché assez longtemps, jamais pendant un appel. */
export function accountsToAutoSleep(inputs: readonly AutoSleepInput[], now: number): string[] {
  return inputs
    .filter(
      (input) =>
        input.autoSleepAfterMinutes !== undefined &&
        !input.sleeping &&
        !input.active &&
        !input.inCall &&
        input.hiddenSince !== null &&
        now - input.hiddenSince >= input.autoSleepAfterMinutes * 60_000
    )
    .map((input) => input.id);
}

export const RAM_SUGGESTION_MB = 2048;
export const RAM_SUGGESTION_HIDDEN_MS = 30 * 60_000;

export interface SleepSuggestionInput {
  id: string;
  label: string;
  sleeping: boolean;
  active: boolean;
  inCall: boolean;
  hiddenSince: number | null;
  memoryMB: number | null;
}

/**
 * §17 : quand l'application dépasse le seuil de mémoire, propose d'endormir le compte
 * caché depuis le plus longtemps (au moins 30 min), hors appel.
 */
export function sleepSuggestion(totalMB: number | null, inputs: readonly SleepSuggestionInput[], now: number): SleepSuggestionInput | null {
  if (totalMB === null || totalMB < RAM_SUGGESTION_MB) return null;
  const candidates = inputs.filter(
    (input) => !input.sleeping && !input.active && !input.inCall && input.hiddenSince !== null && now - input.hiddenSince >= RAM_SUGGESTION_HIDDEN_MS
  );
  candidates.sort((a, b) => (a.hiddenSince ?? 0) - (b.hiddenSince ?? 0));
  return candidates[0] ?? null;
}

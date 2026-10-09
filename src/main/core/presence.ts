// Présence de l'utilisateur : WhatsApp n'est affiché que si quelqu'un peut le voir.
// Une page affichée coûte dix à quinze fois plus qu'une page masquée (minuteries non
// bridées, rendu) ; masquée, elle reste connectée et notifie, mais ne marque rien comme lu.

/** Retour détecté : une action de l'utilisateur dans les dernières secondes. */
export const BACK_IDLE_SECONDS = 5;

/** Relevé de l'inactivité : espacé en présence, rapproché pendant l'absence (retour rapide). */
export const IDLE_POLL_MS = { present: 30_000, away: 2_000 } as const;

/**
 * Fenêtre non présentée (réduite par le bureau, autre bureau virtuel) : délai de
 * confirmation avant de déclencher le verrou « fenêtre masquée ». Le masquage des vues,
 * lui, est immédiat (et sans conséquence s'il s'agissait d'un simple ralentissement).
 */
export const NOT_PRESENTED_LOCK_DELAY_MS = 10_000;

/** Absence : au-delà du seuil d'inactivité ; on n'en sort qu'à la première action. */
export function nextAway(input: { awayHideMinutes: number; idleSeconds: number; wasAway: boolean }): boolean {
  if (input.awayHideMinutes <= 0) return false;
  if (input.wasAway) return input.idleSeconds >= BACK_IDLE_SECONDS;
  return input.idleSeconds >= input.awayHideMinutes * 60;
}

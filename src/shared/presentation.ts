// Sonde de présentation de la fenêtre, partagée par la coque (qui la fait tourner)
// et les tests. Sous Wayland, une fenêtre réduite par le bureau n'est signalée à
// Electron que par « blur » : la page affichée se croit visible. Le compositeur cesse
// en revanche d'envoyer des images ; une image demandée qui ne vient pas le révèle.

/** Sonde d'images de la coque : une image demandée qui ne vient pas compte comme un raté. */
export const PRESENTATION_PROBE = {
  /** Intervalle entre deux demandes d'image. */
  intervalMs: 3_000,
  /** Ratés consécutifs avant de déclarer la fenêtre non présentée. */
  misses: 2
} as const;

/**
 * Machine à états de la sonde, sans DOM : la coque l'alimente avec ses demandes
 * d'image et les images reçues. Renvoie le nouvel état « présentée » s'il change. Une
 * sonde qui (re)démarre part de l'état connu du processus principal : une sonde arrêtée
 * fenêtre réduite a pu le laisser à « non présentée ».
 */
export class PresentationProbe {
  private pending = false;
  private misses = 0;

  constructor(
    private readonly maxMisses: number = PRESENTATION_PROBE.misses,
    private presented = true
  ) {}

  /** Tic de la sonde : true = il faut demander une image. */
  tick(documentVisible: boolean): { request: boolean; presented: boolean | null } {
    if (!documentVisible) {
      // Fenêtre masquée : Electron le sait déjà, la sonde ne conclut rien.
      this.pending = false;
      this.misses = 0;
      return { request: false, presented: null };
    }
    if (this.pending) {
      this.misses += 1;
      if (this.misses >= this.maxMisses && this.presented) {
        this.presented = false;
        return { request: false, presented: false };
      }
      return { request: false, presented: null };
    }
    this.pending = true;
    return { request: true, presented: null };
  }

  /** Image reçue : la fenêtre est affichée. */
  frame(): boolean | null {
    this.pending = false;
    this.misses = 0;
    if (this.presented) return null;
    this.presented = true;
    return true;
  }

  /** Retour au premier plan du document : on repart d'un état « présentée ». */
  reset(): boolean | null {
    this.pending = false;
    this.misses = 0;
    if (this.presented) return null;
    this.presented = true;
    return true;
  }
}

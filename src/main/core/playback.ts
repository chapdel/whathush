// Suivi des médias lus par les pages WhatsApp. Le preload observe les éléments
// audio et vidéo par l'API standard (niveau 1, aucun sélecteur WhatsApp) ; ce module
// garde l'état par page et en déduit l'état par compte. Pur : l'heure est passée.

export type PlaybackState = "playing" | "paused" | "ended";

export interface PlaybackReport {
  state: PlaybackState;
  kind: "audio" | "video";
  /** navigator.mediaSession.metadata.title, si la page en fournit. */
  title: string | null;
  /** Lecture démarrée alors que la page était affichée (donc par l'utilisateur). */
  startedVisible: boolean;
}

interface PageEntry extends PlaybackReport {
  accountId: string;
  webContentsId: number;
  /** Début de la lecture en cours, ou de la dernière lecture. */
  startedAt: number;
  updatedAt: number;
}

export interface AccountPlayback {
  playing: boolean;
  kind: "audio" | "video";
  title: string | null;
  /** Lecture lancée par l'utilisateur : jamais coupée par le Snooze. */
  userStarted: boolean;
  webContentsId: number;
  updatedAt: number;
}

/** Une lecture en pause reste proposée (« Reprendre ») pendant 5 minutes. */
export const PAUSED_VISIBLE_MS = 5 * 60_000;
/** Le message vocal suivant, enchaîné par WhatsApp, garde l'origine du précédent. */
export const CHAIN_MS = 3000;

export class PlaybackTracker {
  private readonly pages = new Map<number, PageEntry>();
  /** Fin récente d'une lecture lancée par l'utilisateur, par page. */
  private readonly userEnded = new Map<number, number>();
  /** « Reprendre » commandé depuis l'application : la prochaine lecture vient de l'utilisateur. */
  private readonly userResumed = new Set<number>();

  /** Renvoie true si une nouvelle lecture démarre (pour « une seule lecture à la fois »). */
  report(accountId: string, webContentsId: number, report: PlaybackReport, now: number): boolean {
    const previous = this.pages.get(webContentsId);
    if (report.state === "ended") {
      if (previous?.startedVisible) this.userEnded.set(webContentsId, now);
      this.pages.delete(webContentsId);
      return false;
    }
    const started = report.state === "playing" && previous?.state !== "playing";
    const chained = (this.userEnded.get(webContentsId) ?? -Infinity) >= now - CHAIN_MS;
    const resumed = started && this.userResumed.delete(webContentsId);
    this.userEnded.delete(webContentsId);
    // L'origine d'une lecture se garde tant qu'elle existe (pause, reprise, mise en
    // mémoire tampon) : une page cachée ne la perd pas en rapportant « hidden ».
    const userStarted = Boolean(previous?.startedVisible) || resumed || chained || (started && report.startedVisible) || (!previous && report.startedVisible);
    this.pages.set(webContentsId, {
      ...report,
      accountId,
      webContentsId,
      startedAt: started ? now : (previous?.startedAt ?? now),
      startedVisible: userStarted,
      updatedAt: now
    });
    return started;
  }

  /** L'utilisateur a demandé « Reprendre » pour cette page (barre latérale ou tray). */
  markUserResume(webContentsId: number): void {
    this.userResumed.add(webContentsId);
  }

  pageGone(webContentsId: number): boolean {
    this.userEnded.delete(webContentsId);
    this.userResumed.delete(webContentsId);
    return this.pages.delete(webContentsId);
  }

  accountGone(accountId: string): boolean {
    let changed = false;
    for (const [id, entry] of this.pages) {
      if (entry.accountId === accountId) {
        this.pages.delete(id);
        changed = true;
      }
    }
    return changed;
  }

  /** État du compte : la lecture en cours la plus récente, sinon la pause récente. */
  forAccount(accountId: string, now: number): AccountPlayback | null {
    let best: PageEntry | null = null;
    for (const entry of this.pages.values()) {
      if (entry.accountId !== accountId) continue;
      if (entry.state === "paused" && now - entry.updatedAt > PAUSED_VISIBLE_MS) continue;
      if (!best || rank(entry) > rank(best) || (rank(entry) === rank(best) && entry.updatedAt > best.updatedAt)) best = entry;
    }
    if (!best) return null;
    return { playing: best.state === "playing", kind: best.kind, title: best.title, userStarted: best.startedVisible, webContentsId: best.webContentsId, updatedAt: best.updatedAt };
  }

  /** Pages qui lisent en ce moment, hors celles d'un compte donné. */
  playingPagesExcept(accountId: string): number[] {
    return [...this.pages.values()].filter((entry) => entry.state === "playing" && entry.accountId !== accountId).map((entry) => entry.webContentsId);
  }

  accountsWithMedia(now: number): string[] {
    return [...new Set([...this.pages.values()].map((entry) => entry.accountId))].filter((id) => this.forAccount(id, now) !== null);
  }
}

function rank(entry: PageEntry): number {
  return entry.state === "playing" ? 1 : 0;
}

/**
 * En Snooze, un compte caché a le son coupé, sauf pendant un appel ou
 * une lecture que l'utilisateur a lancée lui-même (un message vocal ne s'interrompt pas
 * parce qu'on change de compte).
 */
export function shouldMute(input: { muteWhenHidden: boolean; shown: boolean; inCall: boolean; userPlayback: boolean }): boolean {
  return input.muteWhenHidden && !input.shown && !input.inCall && !input.userPlayback;
}

// CallCoordinator (§19) : sait quel compte utilise le micro, la caméra ou le
// partage d'écran, à partir du wrapper getUserMedia/getDisplayMedia du preload.
// Le décompte se fait par page (vue principale ou popup d'un compte) : une page
// qui navigue ou se ferme perd ses pistes sans événement « ended », d'où resetPage.
// Un enregistrement de message vocal compte aussi : il ne faut pas l'interrompre.

import { EventEmitter } from "node:events";
import type { MediaPayload } from "../../shared/ipc";

interface PageTracks {
  accountId: string;
  counts: Map<string, number>;
}

export class CallCoordinator extends EventEmitter<{ changed: [] }> {
  private readonly pages = new Map<number, PageTracks>();

  onMedia(accountId: string, webContentsId: number, payload: MediaPayload): void {
    const page = this.pages.get(webContentsId) ?? { accountId, counts: new Map<string, number>() };
    const key = `${payload.source}:${payload.trackKind}`;
    page.counts.set(key, Math.max(0, (page.counts.get(key) ?? 0) + (payload.event === "start" ? 1 : -1)));
    this.pages.set(webContentsId, page);
    this.emit("changed");
  }

  /** Micro, caméra ou partage d'écran actifs dans une page du compte. */
  inCall(accountId: string): boolean {
    for (const page of this.pages.values()) {
      if (page.accountId !== accountId) continue;
      for (const count of page.counts.values()) if (count > 0) return true;
    }
    return false;
  }

  /** F7 : un partage d'écran est en cours (dans n'importe quel compte). */
  sharingScreen(): boolean {
    for (const page of this.pages.values()) if ((page.counts.get("getDisplayMedia:video") ?? 0) > 0) return true;
    return false;
  }

  /** Comptes en appel, pour la règle « 1 appel actif à la fois ». */
  accountsInCall(): string[] {
    return [...new Set([...this.pages.values()].map((page) => page.accountId))].filter((id) => this.inCall(id));
  }

  /** La page a navigué ou a été fermée : ses pistes n'existent plus. */
  resetPage(webContentsId: number): void {
    if (this.pages.delete(webContentsId)) this.emit("changed");
  }

  /** Toutes les pages du compte ont disparu (veille, suppression, crash). */
  resetAccount(accountId: string): void {
    let changed = false;
    for (const [id, page] of this.pages) {
      if (page.accountId === accountId) {
        this.pages.delete(id);
        changed = true;
      }
    }
    if (changed) this.emit("changed");
  }
}

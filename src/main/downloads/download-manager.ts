// DownloadManager (§22). Les médias WhatsApp sont des URL blob: déchiffrées par la
// page ; will-download les reçoit comme n'importe quel fichier.
// Pas d'ouverture automatique d'un fichier reçu : vecteur classique de malware.

import { app, Notification, shell, type DownloadItem } from "electron";
import fs from "node:fs";
import path from "node:path";
import { uniqueFileName } from "../core/downloads";
import type { Logger } from "../log";

export interface DownloadDeps {
  log: Logger;
  askLocation(): boolean;
  accountLabel(accountId: string): string;
  /** Mode test : enregistre au lieu de notifier. */
  sink?: (event: { accountId: string; file: string; state: string }) => void;
}

export class DownloadManager {
  /**
   * Chemins promis à des téléchargements en cours : le fichier n'existe pas encore
   * sur le disque, deux téléchargements du même nom ne doivent pas le recevoir.
   */
  private readonly reserved = new Set<string>();

  constructor(private readonly deps: DownloadDeps) {}

  handle(accountId: string, item: DownloadItem): void {
    const directory = app.getPath("downloads");
    const name = uniqueFileName(item.getFilename(), (candidate) => {
      const candidatePath = path.join(directory, candidate);
      return this.reserved.has(candidatePath) || fs.existsSync(candidatePath);
    });
    const target = path.join(directory, name);
    this.reserved.add(target);
    if (this.deps.askLocation()) {
      item.setSaveDialogOptions({ defaultPath: target });
    } else {
      item.setSavePath(target);
    }

    item.once("done", (_event, state) => {
      this.reserved.delete(target);
      const savePath = item.getSavePath();
      this.deps.log.info("download-done", { accountId, state });
      if (this.deps.sink) {
        this.deps.sink({ accountId, file: savePath, state });
        return;
      }
      if (state !== "completed" || !Notification.isSupported()) return;
      const notification = new Notification({
        title: `Téléchargement terminé — ${this.deps.accountLabel(accountId)}`,
        body: `${path.basename(savePath)}\nCliquez pour l’afficher dans le dossier.`,
        silent: true
      });
      notification.on("click", () => shell.showItemInFolder(savePath));
      notification.show();
    });
  }
}

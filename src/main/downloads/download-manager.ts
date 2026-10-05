// DownloadManager (§22, F2). Les médias WhatsApp sont des URL blob: déchiffrées par la
// page ; will-download les reçoit comme n'importe quel fichier.
// Pas d'ouverture automatique d'un fichier reçu : vecteur classique de malware. Un
// fichier ne s'ouvre que sur un clic explicite dans l'historique.
// Historique dans downloads.json (0600), avec rétention ; progression vers l'UI au
// plus deux fois par seconde.

import { app, Notification, shell, type DownloadItem } from "electron";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { t } from "../../shared/i18n";
import type { DownloadRecord } from "../../shared/schemas";
import { pruneHistory, uniqueFileName, withPresence, type DownloadView } from "../core/downloads";
import type { Logger } from "../log";
import type { AppStore } from "../storage/app-store";

const PROGRESS_INTERVAL_MS = 500;

export interface DownloadDeps {
  log: Logger;
  store: AppStore;
  askLocation(): boolean;
  retentionDays(): number;
  accountLabel(accountId: string): string;
  /** F6 : verrouillé, la notification ne nomme ni le compte ni le fichier. */
  locked(): boolean;
  /** Mode test : enregistre au lieu de notifier et d'ouvrir. */
  sink?: (event: { accountId: string; file: string; state: string; title: string; body: string }) => void;
  opened?: (action: "open" | "show", file: string) => void;
}

interface Active {
  item: DownloadItem;
  record: DownloadRecord;
  received: number;
  total: number;
}

export class DownloadManager extends EventEmitter<{ changed: [] }> {
  /**
   * Chemins promis à des téléchargements en cours : le fichier n'existe pas encore
   * sur le disque, deux téléchargements du même nom ne doivent pas le recevoir.
   */
  private readonly reserved = new Set<string>();
  private readonly active = new Map<string, Active>();
  private progressTimer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: DownloadDeps) {
    super();
  }

  /** Au démarrage : rétention appliquée, téléchargements interrompus par une fermeture marqués. */
  start(): void {
    this.save((records) =>
      records.map((record) => (record.state === "progressing" ? { ...record, state: "interrupted" as const, finishedAt: record.startedAt } : record))
    );
  }

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

    const record: DownloadRecord = {
      id: globalThis.crypto.randomUUID(),
      accountId,
      fileName: name,
      path: target,
      bytes: Math.max(0, item.getTotalBytes()),
      state: "progressing",
      startedAt: new Date().toISOString()
    };
    const entry: Active = { item, record, received: 0, total: Math.max(0, item.getTotalBytes()) };
    this.active.set(record.id, entry);
    this.save((records) => [record, ...records]);

    item.on("updated", () => {
      entry.received = item.getReceivedBytes();
      entry.total = Math.max(entry.total, item.getTotalBytes());
      this.scheduleProgress();
    });

    item.once("done", (_event, state) => {
      this.reserved.delete(target);
      this.active.delete(record.id);
      const savePath = item.getSavePath() || target;
      const finished: DownloadRecord = {
        ...record,
        fileName: path.basename(savePath).slice(0, 260) || record.fileName,
        path: savePath,
        bytes: Math.max(0, item.getReceivedBytes()),
        state: state === "completed" ? "completed" : state === "cancelled" ? "cancelled" : "interrupted",
        finishedAt: new Date().toISOString()
      };
      this.save((records) => records.map((candidate) => (candidate.id === record.id ? finished : candidate)));
      this.deps.log.info("download-done", { accountId, state });
      // Verrouillé (F6) : ni le compte ni le nom du fichier.
      const locked = this.deps.locked();
      const title = locked ? t("download.doneTitleLocked") : t("download.doneTitle", { label: this.deps.accountLabel(accountId) });
      const body = locked ? t("download.doneBodyLocked") : t("download.doneBody", { file: path.basename(savePath) });
      if (this.deps.sink) {
        this.deps.sink({ accountId, file: savePath, state, title, body });
        return;
      }
      if (state !== "completed" || !Notification.isSupported()) return;
      const notification = new Notification({ title, body, silent: true });
      notification.on("click", () => {
        if (!this.deps.locked()) shell.showItemInFolder(savePath);
      });
      notification.show();
    });
  }

  private scheduleProgress(): void {
    if (this.progressTimer) return;
    this.progressTimer = setTimeout(() => {
      this.progressTimer = null;
      this.emit("changed");
    }, PROGRESS_INTERVAL_MS);
  }

  /**
   * Écrit l'historique, rétention appliquée. Sans historique, rien n'est écrit : les
   * téléchargements en cours restent en mémoire (un nom de fichier peut être sensible).
   */
  private save(update: (records: DownloadRecord[]) => DownloadRecord[]): void {
    const days = this.deps.retentionDays();
    this.deps.store.update("downloads", (file) => {
      const records = days === 0 ? [] : pruneHistory(update(file.records), new Date(), days);
      return records.length === 0 && file.records.length === 0 ? file : { ...file, records };
    });
    this.emit("changed");
  }

  /** Rétention modifiée dans les paramètres. */
  applyRetention(): void {
    this.save((records) => records);
  }

  list(): Array<DownloadView & { progress: number | null }> {
    const stored = this.deps.store.get("downloads").records;
    const pending = [...this.active.values()].map((entry) => entry.record).filter((record) => !stored.some((candidate) => candidate.id === record.id));
    return withPresence([...pending, ...stored], (file) => fs.existsSync(file)).map((view) => {
      const entry = this.active.get(view.id);
      return { ...view, progress: entry && entry.total > 0 ? Math.min(1, entry.received / entry.total) : null };
    });
  }

  /** Résumé pour la barre latérale. */
  summary(): { active: number; progress: number | null } {
    let received = 0;
    let total = 0;
    for (const entry of this.active.values()) {
      received += entry.received;
      total += entry.total;
    }
    return { active: this.active.size, progress: this.active.size > 0 && total > 0 ? Math.min(1, received / total) : null };
  }

  private record(id: string): DownloadRecord | undefined {
    return this.deps.store.get("downloads").records.find((record) => record.id === id);
  }

  /** Ouverture explicite (clic dans l'historique), jamais automatique. */
  async open(id: string): Promise<void> {
    const record = this.record(id);
    if (!record || record.state !== "completed" || !fs.existsSync(record.path)) return;
    if (this.deps.opened) return this.deps.opened("open", record.path);
    const error = await shell.openPath(record.path);
    if (error) this.deps.log.warn("download-open-failed", { error });
  }

  show(id: string): void {
    const record = this.record(id);
    if (!record) return;
    const target = fs.existsSync(record.path) ? record.path : path.dirname(record.path);
    if (this.deps.opened) return this.deps.opened("show", target);
    shell.showItemInFolder(target);
  }

  remove(id: string): void {
    this.active.get(id)?.item.cancel();
    this.save((records) => records.filter((record) => record.id !== id));
  }

  clear(): void {
    this.save((records) => records.filter((record) => record.state === "progressing"));
  }

  /** F6, « Code oublié » : tout l'historique disparaît avec les sessions. */
  clearAll(): void {
    this.save(() => []);
  }

  /** Compte supprimé : son historique aussi. */
  forgetAccount(accountId: string): void {
    this.save((records) => records.filter((record) => record.accountId !== accountId || record.state === "progressing"));
  }
}

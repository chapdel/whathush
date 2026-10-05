// Store de l'application : les fichiers de configuration en mémoire, écrits à
// chaque modification (tous en 0600). Un fichier d'une version plus récente passe en
// lecture seule pour ne pas être écrasé.

import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import type { MessageKey, Params } from "../../shared/i18n";
import type { Notice } from "../../shared/ipc";
import type { AccountsFile, DownloadsFile, FocusFile, Preferences, SchedulesFile, SecurityFile } from "../../shared/schemas";
import { partitionDirName } from "../../shared/constants";
import type { Logger } from "../log";
import { accountsDocument, downloadsDocument, FILE_NAMES, focusDocument, preferencesDocument, schedulesDocument, securityDocument } from "./documents";
import { readJsonDocument, writeJsonDocument, type JsonDocument } from "./json-store";

interface Documents {
  accounts: AccountsFile;
  preferences: Preferences;
  schedules: SchedulesFile;
  focus: FocusFile;
  security: SecurityFile;
  downloads: DownloadsFile;
}
export type DocumentKey = keyof Documents;

const DOCUMENTS: { [K in DocumentKey]: JsonDocument<Documents[K]> } = {
  accounts: accountsDocument,
  preferences: preferencesDocument,
  schedules: schedulesDocument,
  focus: focusDocument,
  security: securityDocument,
  downloads: downloadsDocument
};

export class AppStore extends EventEmitter<{ change: [DocumentKey] }> {
  private readonly data: Documents;
  private readonly readOnly = new Set<DocumentKey>();
  /** Traduites par l'application une fois la langue connue (le store est lu avant). */
  readonly notices: Array<Omit<Notice, "message"> & { key: MessageKey; params: Params }> = [];

  constructor(
    private readonly dir: string,
    private readonly log: Logger
  ) {
    super();
    this.data = {
      accounts: this.load("accounts"),
      preferences: this.load("preferences"),
      schedules: this.load("schedules"),
      focus: this.load("focus"),
      security: this.load("security"),
      downloads: this.load("downloads")
    };
  }

  private load<K extends DocumentKey>(key: K): Documents[K] {
    const file = path.join(this.dir, FILE_NAMES[key]);
    const result = readJsonDocument(file, DOCUMENTS[key]);
    switch (result.status) {
      case "corrupt":
        this.log.error("store-corrupt", { key, backup: result.backupPath, error: result.error });
        this.notices.push({ id: `corrupt-${key}`, level: "error", key: "notice.storeCorrupt", params: { file: FILE_NAMES[key], backup: path.basename(result.backupPath) } });
        break;
      case "too-new":
        this.readOnly.add(key);
        this.log.error("store-too-new", { key, version: result.version });
        this.notices.push({ id: `too-new-${key}`, level: "error", key: "notice.storeTooNew", params: { file: FILE_NAMES[key] } });
        break;
      case "migrated":
        this.log.info("store-migrated", { key });
        break;
      default:
        break;
    }
    return result.data;
  }

  get<K extends DocumentKey>(key: K): Documents[K] {
    return this.data[key];
  }

  /** Renvoie false si rien n'a été enregistré (fichier en lecture seule). */
  update<K extends DocumentKey>(key: K, updater: (current: Documents[K]) => Documents[K]): boolean {
    if (this.readOnly.has(key)) {
      this.log.warn("store-read-only", { key });
      return false;
    }
    const next = updater(this.data[key]);
    if (next === this.data[key]) return true;
    writeJsonDocument(path.join(this.dir, FILE_NAMES[key]), DOCUMENTS[key], next);
    this.data[key] = next;
    this.emit("change", key);
    return true;
  }

  /** Supprime les partitions des comptes supprimés, avant toute création de session. */
  purgePendingPartitions(partitionsDir: string): void {
    const pending = this.data.accounts.pendingPartitionDeletion;
    if (pending.length === 0) return;
    for (const id of pending) {
      const dir = path.join(partitionsDir, partitionDirName(id));
      fs.rmSync(dir, { recursive: true, force: true });
      this.log.info("partition-purged", { id });
    }
    this.update("accounts", (file) => ({ ...file, pendingPartitionDeletion: [] }));
  }
}

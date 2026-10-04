// Store de l'application (§6) : les quatre fichiers de configuration en mémoire,
// écrits à chaque modification. Un fichier d'une version plus récente passe en
// lecture seule pour ne pas être écrasé.

import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import type { Notice } from "../../shared/ipc";
import type { AccountsFile, FocusFile, Preferences, SchedulesFile } from "../../shared/schemas";
import { partitionDirName } from "../../shared/constants";
import type { Logger } from "../log";
import { accountsDocument, FILE_NAMES, focusDocument, preferencesDocument, schedulesDocument } from "./documents";
import { readJsonDocument, writeJsonDocument, type JsonDocument } from "./json-store";

interface Documents {
  accounts: AccountsFile;
  preferences: Preferences;
  schedules: SchedulesFile;
  focus: FocusFile;
}
export type DocumentKey = keyof Documents;

const DOCUMENTS: { [K in DocumentKey]: JsonDocument<Documents[K]> } = {
  accounts: accountsDocument,
  preferences: preferencesDocument,
  schedules: schedulesDocument,
  focus: focusDocument
};

export class AppStore extends EventEmitter<{ change: [DocumentKey] }> {
  private readonly data: Documents;
  private readonly readOnly = new Set<DocumentKey>();
  readonly notices: Notice[] = [];

  constructor(
    private readonly dir: string,
    private readonly log: Logger
  ) {
    super();
    this.data = {
      accounts: this.load("accounts"),
      preferences: this.load("preferences"),
      schedules: this.load("schedules"),
      focus: this.load("focus")
    };
  }

  private load<K extends DocumentKey>(key: K): Documents[K] {
    const file = path.join(this.dir, FILE_NAMES[key]);
    const result = readJsonDocument(file, DOCUMENTS[key]);
    switch (result.status) {
      case "corrupt":
        this.log.error("store-corrupt", { key, backup: result.backupPath, error: result.error });
        this.notices.push({
          id: `corrupt-${key}`,
          level: "error",
          message: `Le fichier ${FILE_NAMES[key]} était illisible. Il a été mis de côté (${path.basename(result.backupPath)}) et remplacé par une configuration vide.`
        });
        break;
      case "too-new":
        this.readOnly.add(key);
        this.log.error("store-too-new", { key, version: result.version });
        this.notices.push({
          id: `too-new-${key}`,
          level: "error",
          message: `${FILE_NAMES[key]} vient d’une version plus récente de l’application. Il ne sera pas modifié : mettez l’application à jour.`
        });
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

  /** §8 : supprime les partitions des comptes supprimés, avant toute création de session. */
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

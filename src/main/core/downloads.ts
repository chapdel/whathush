// Noms de fichiers des téléchargements (§22) : jamais de chemin, jamais d'écrasement.
// Historique des téléchargements (F2) : rétention et état « introuvable ».

import type { DownloadRecord } from "../../shared/schemas";

const FORBIDDEN = /[/\\\u0000-\u001f\u007f]/g;

export function safeFileName(name: string): string {
  const cleaned = name.replace(FORBIDDEN, "_").replace(/^\.+/, "").trim().slice(0, 200);
  return cleaned || "fichier";
}

/** « rapport.pdf » → « rapport (1).pdf » si le nom est déjà pris. */
export function uniqueFileName(name: string, exists: (candidate: string) => boolean): string {
  const safe = safeFileName(name);
  if (!exists(safe)) return safe;
  const dot = safe.lastIndexOf(".");
  const base = dot > 0 ? safe.slice(0, dot) : safe;
  const extension = dot > 0 ? safe.slice(dot) : "";
  for (let index = 1; index < 10_000; index++) {
    const candidate = `${base} (${index})${extension}`;
    if (!exists(candidate)) return candidate;
  }
  return `${base} (${Date.now()})${extension}`;
}

export const MAX_DOWNLOAD_RECORDS = 500;

/**
 * Retire les entrées plus vieilles que la rétention (0 = aucun historique) ; les
 * téléchargements en cours restent tant qu'ils durent. Les plus récents d'abord.
 */
export function pruneHistory(records: readonly DownloadRecord[], now: Date, retentionDays: number): DownloadRecord[] {
  const limit = now.getTime() - retentionDays * 24 * 60 * 60_000;
  return records
    .filter((record) => record.state === "progressing" || (retentionDays > 0 && new Date(record.finishedAt ?? record.startedAt).getTime() >= limit))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .slice(0, MAX_DOWNLOAD_RECORDS);
}

export interface DownloadView extends DownloadRecord {
  /** Le fichier a été déplacé ou supprimé depuis. */
  missing: boolean;
}

/** État affiché : un fichier terminé mais absent du disque est « introuvable ». */
export function withPresence(records: readonly DownloadRecord[], exists: (filePath: string) => boolean): DownloadView[] {
  return records.map((record) => ({ ...record, missing: record.state === "completed" && !exists(record.path) }));
}

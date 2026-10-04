// Lecture et écriture des fichiers de configuration (§6).
// - écriture atomique (fichier temporaire + fsync + rename) ;
// - validation zod et migrations selon schemaVersion ;
// - fichier illisible : copie horodatée en .corrupt, jamais d'écrasement silencieux ;
// - fichier d'une version plus récente : signalé, l'appelant ne doit pas l'écraser.

import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

export type Migration = (data: Record<string, unknown>) => Record<string, unknown>;

export interface JsonDocument<T> {
  schema: z.ZodType<T>;
  currentVersion: number;
  /** migrations[n] fait passer un document de la version n à n + 1. */
  migrations: Record<number, Migration>;
  defaults: () => T;
}

export type ReadResult<T> =
  | { status: "ok" | "missing" | "migrated"; data: T }
  | { status: "corrupt"; data: T; backupPath: string; error: string }
  | { status: "too-new"; data: T; version: number };

function migrate<T>(value: unknown, doc: JsonDocument<T>): { value: unknown; migrated: boolean; tooNew?: number } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("objet JSON attendu");
  let current = value as Record<string, unknown>;
  const initialVersion = current.schemaVersion;
  if (typeof initialVersion !== "number" || !Number.isInteger(initialVersion)) {
    throw new Error("schemaVersion absent ou invalide");
  }
  if (initialVersion > doc.currentVersion) return { value: current, migrated: false, tooNew: initialVersion };

  let version = initialVersion;
  let migrated = false;
  while (version < doc.currentVersion) {
    const step = doc.migrations[version];
    if (!step) throw new Error(`aucune migration depuis la version ${version}`);
    current = step(current);
    if (current.schemaVersion !== version + 1) {
      throw new Error(`la migration ${version} → ${version + 1} n'a pas mis à jour schemaVersion`);
    }
    version += 1;
    migrated = true;
  }
  return { value: current, migrated };
}

export function readJsonDocument<T>(filePath: string, doc: JsonDocument<T>, now: Date = new Date()): ReadResult<T> {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "missing", data: doc.defaults() };
    throw error;
  }

  try {
    const { value, migrated, tooNew } = migrate(JSON.parse(raw), doc);
    if (tooNew !== undefined) return { status: "too-new", data: doc.defaults(), version: tooNew };
    const parsed = doc.schema.safeParse(value);
    if (!parsed.success) throw new Error(z.prettifyError(parsed.error));
    return { status: migrated ? "migrated" : "ok", data: parsed.data };
  } catch (error) {
    const backupPath = `${filePath}.corrupt-${now.toISOString().replace(/[:.]/g, "-")}`;
    fs.copyFileSync(filePath, backupPath);
    return { status: "corrupt", data: doc.defaults(), backupPath, error: (error as Error).message };
  }
}

/** Écriture atomique : un lecteur voit l'ancien ou le nouveau contenu, jamais un mélange. */
export function writeJsonDocument<T>(filePath: string, doc: JsonDocument<T>, data: T): void {
  const parsed = doc.schema.parse(data);
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const fd = fs.openSync(tmpPath, "w", 0o600);
  try {
    fs.writeSync(fd, `${JSON.stringify(parsed, null, 2)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmpPath, filePath);
  } catch (error) {
    fs.rmSync(tmpPath, { force: true });
    throw error;
  }

  // Rendre le rename durable en cas de coupure de courant.
  const dirFd = fs.openSync(dir, "r");
  try {
    fs.fsyncSync(dirFd);
  } finally {
    fs.closeSync(dirFd);
  }
}

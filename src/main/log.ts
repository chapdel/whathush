// Journal local de diagnostic : jamais de contenu de message, jamais envoyé ailleurs.
// Écriture par flux (non bloquante) ; la taille est suivie en mémoire pour la rotation.

import fs from "node:fs";
import path from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(event: string, data?: unknown): void;
  info(event: string, data?: unknown): void;
  warn(event: string, data?: unknown): void;
  error(event: string, data?: unknown): void;
  readonly dir: string;
}

const MAX_BYTES = 5 * 1024 * 1024;

function serialize(data: unknown): unknown {
  if (data instanceof Error) return { name: data.name, message: data.message };
  return data;
}

export function createLogger(dir: string, options: { console: boolean }): Logger {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, "app.log");
  let bytes = 0;
  try {
    bytes = fs.statSync(file).size;
  } catch {
    bytes = 0;
  }

  const open = (): fs.WriteStream => {
    const stream = fs.createWriteStream(file, { flags: "a", mode: 0o600 });
    // Le journal ne doit jamais faire tomber l'application.
    stream.on("error", () => undefined);
    return stream;
  };
  let stream = open();

  const write = (level: LogLevel, event: string, data?: unknown): void => {
    const line = `${JSON.stringify({ ts: new Date().toISOString(), level, event, ...(data === undefined ? {} : { data: serialize(data) }) })}\n`;
    if (bytes > MAX_BYTES) {
      // Renommer d'abord : l'ancien flux garde son descripteur et termine ses
      // écritures en attente dans l'archive ; le nouveau repart sur un fichier neuf.
      try {
        fs.renameSync(file, path.join(dir, "app.1.log"));
      } catch {
        // fichier absent : rien à archiver
      }
      stream.end();
      bytes = 0;
      stream = open();
    }
    bytes += Buffer.byteLength(line);
    stream.write(line);
    if (options.console && level !== "debug") process.stdout.write(line);
  };

  return {
    dir,
    debug: (event, data) => write("debug", event, data),
    info: (event, data) => write("info", event, data),
    warn: (event, data) => write("warn", event, data),
    error: (event, data) => write("error", event, data)
  };
}

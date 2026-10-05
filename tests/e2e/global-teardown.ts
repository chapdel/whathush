// Supprime les dossiers de données jetables créés par le harnais e2e.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export default function globalTeardown(): void {
  // Seulement les dossiers de ce lancement : un autre lancement en cours garde les siens.
  const prefix = `whathush-e2e-${process.env.WHATHUSH_E2E_RUN ?? "manuel"}-`;
  for (const entry of fs.readdirSync(os.tmpdir())) {
    if (entry.startsWith(prefix)) fs.rmSync(path.join(os.tmpdir(), entry), { recursive: true, force: true });
  }
}

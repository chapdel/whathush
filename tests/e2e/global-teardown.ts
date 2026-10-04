// Supprime les dossiers de données jetables créés par le harnais e2e.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export default function globalTeardown(): void {
  for (const entry of fs.readdirSync(os.tmpdir())) {
    if (entry.startsWith("whathush-e2e-")) fs.rmSync(path.join(os.tmpdir(), entry), { recursive: true, force: true });
  }
}

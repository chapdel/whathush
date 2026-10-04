// Noms de fichiers des téléchargements (§22) : jamais de chemin, jamais d'écrasement.

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

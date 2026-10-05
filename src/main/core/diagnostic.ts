// Rapport de diagnostic : texte à joindre soi-même à un signalement. Rien n'est
// envoyé. Les journaux ne contiennent déjà aucun message ; le rapport caviarde
// en plus les noms de comptes, le dossier personnel et les adresses de proxy.

export interface RedactionInput {
  /** Noms des comptes, dans l'ordre d'affichage : le n-ième devient « Compte n ». */
  labels: readonly string[];
  home: string;
  proxyHosts: readonly string[];
  /** « Compte {n} » dans la langue du rapport. */
  accountName(index: number): string;
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function redact(text: string, input: RedactionInput): string {
  let result = text;
  // Noms de comptes en une seule passe (un remplacement n'est jamais relu), les plus longs
  // d'abord (« Équipe produit » avant « Équipe »), et en mots entiers : un compte nommé
  // « A » ne remplace pas chaque « a ».
  const labels = input.labels.map((label, index) => ({ label: label.trim(), index })).filter((entry) => entry.label.length > 0);
  labels.sort((a, b) => b.label.length - a.label.length);
  if (labels.length > 0) {
    const byName = new Map(labels.map(({ label, index }) => [label.toLocaleLowerCase(), index]));
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}])(?:${labels.map(({ label }) => escape(label)).join("|")})(?![\\p{L}\\p{N}])`, "giu");
    result = result.replace(pattern, (match) => input.accountName((byName.get(match.toLocaleLowerCase()) ?? 0) + 1));
  }
  if (input.home.length > 1) result = result.replace(new RegExp(escape(input.home), "g"), "~");
  for (const host of input.proxyHosts) if (host.trim()) result = result.replace(new RegExp(escape(host.trim()), "gi"), "[proxy]");
  // Filets de sécurité : paramètres d'adresse (numéro et texte d'un lien de conversation),
  // adresses électroniques, numéros de téléphone avec ou sans indicatif.
  result = result.replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^\s"'?#]*)[?#][^\s"']*/gi, "$1?[…]");
  result = result.replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "[e-mail]");
  result = result.replace(/\+\d[\d\s]{7,16}\d/g, "[phone]");
  result = result.replace(/(?<![\w.:-])\d{8,15}(?![\w.:-])/g, "[phone]");
  return result;
}

export interface ReportSection {
  title: string;
  lines: Array<[string, string | number | boolean | null]> | string[];
}

export function formatReport(title: string, sections: readonly ReportSection[]): string {
  const out = [title, "=".repeat(title.length), ""];
  for (const section of sections) {
    out.push(`## ${section.title}`, "");
    for (const line of section.lines) out.push(Array.isArray(line) ? `${line[0]} : ${line[1] === null ? "—" : String(line[1])}` : line);
    out.push("");
  }
  return out.join("\n");
}

/** Les n dernières lignes d'un journal. */
export function tail(text: string, lines: number): string[] {
  const all = text.split("\n").filter((line) => line.length > 0);
  return all.slice(Math.max(0, all.length - lines));
}

/** Nom du fichier : whathush-diagnostic-20261005-143012.txt (heure locale). */
export function reportFileName(product: string, now: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${product.toLowerCase()}-diagnostic-${stamp}.txt`;
}

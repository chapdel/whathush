// Rapport de diagnostic en un clic (F3). Fichier texte dans Téléchargements, puis
// dossier affiché. Aucun envoi automatique ; caviardé (noms de comptes, dossier
// personnel, proxy). En anglais : il est destiné à un ticket.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { formatReport, redact, reportFileName, tail, type ReportSection } from "../core/diagnostic";
import { uniqueFileName } from "../core/downloads";

export interface ReportInput {
  product: string;
  versions: Record<string, string>;
  build: unknown;
  system: Record<string, string | number | boolean | null>;
  accounts: Array<{ label: string; lifecycle: string; mode: string; sleeping: boolean; adapterDegraded: boolean; inCall: boolean; memoryMB: number | null; proxy: string }>;
  preferences: Record<string, unknown>;
  logFile: string;
  proxyHosts: string[];
  directory: string;
  now: Date;
}

function readOsRelease(): string | null {
  for (const file of ["/etc/os-release", "/usr/lib/os-release", "/run/host/os-release"]) {
    try {
      const match = /^PRETTY_NAME="?([^"\n]+)"?/m.exec(fs.readFileSync(file, "utf8"));
      if (match?.[1]) return match[1];
    } catch {
      // fichier suivant
    }
  }
  return null;
}

export function systemInfo(extra: Record<string, string | number | boolean | null>): Record<string, string | number | boolean | null> {
  return {
    distribution: readOsRelease(),
    kernel: os.release(),
    arch: process.arch,
    desktop: process.env.XDG_CURRENT_DESKTOP ?? null,
    session: process.env.XDG_SESSION_TYPE ?? null,
    flatpak: Boolean(process.env.FLATPAK_ID),
    appimage: Boolean(process.env.APPIMAGE),
    ...extra
  };
}

export function buildReport(input: ReportInput): string {
  const sections: ReportSection[] = [
    { title: "Versions", lines: [...Object.entries(input.versions), ["build", JSON.stringify(input.build)]] },
    { title: "System", lines: Object.entries(input.system) },
    {
      title: `Accounts (${input.accounts.length})`,
      lines: input.accounts.map(
        (account, index) =>
          `Account ${index + 1} : ${account.lifecycle}, mode ${account.mode}${account.sleeping ? ", sleeping" : ""}${account.inCall ? ", in call" : ""}${account.adapterDegraded ? ", adapter degraded" : ""}, memory ${account.memoryMB ?? "?"} MB, proxy ${account.proxy}`
      )
    },
    { title: "Preferences (proxy and security omitted)", lines: Object.entries(input.preferences).map(([key, value]) => [key, JSON.stringify(value)] as [string, string]) }
  ];
  let log = "";
  try {
    log = fs.readFileSync(input.logFile, "utf8");
  } catch {
    log = "";
  }
  sections.push({ title: "Log (last 500 lines)", lines: tail(log, 500) });
  const text = formatReport(`${input.product} diagnostic report — ${input.now.toISOString()}`, sections);
  return redact(text, { labels: input.accounts.map((account) => account.label), home: os.homedir(), proxyHosts: input.proxyHosts, accountName: (n) => `Account ${n}` });
}

/** Écrit le rapport sans jamais écraser un fichier ; renvoie son chemin. */
export function writeReport(input: ReportInput): string {
  fs.mkdirSync(input.directory, { recursive: true });
  const name = uniqueFileName(reportFileName(input.product, input.now), (candidate) => fs.existsSync(path.join(input.directory, candidate)));
  const file = path.join(input.directory, name);
  fs.writeFileSync(file, buildReport(input), { mode: 0o600, flag: "wx" });
  return file;
}

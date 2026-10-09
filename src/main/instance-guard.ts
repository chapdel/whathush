// Garde-fous de démarrage, hors Flatpak (espace de PID propre à chaque instance) :
// - instance unique renforcée : le verrou de Chromium repose sur une socket dans /tmp ;
//   si son dossier disparaît (nettoyage de /tmp), une seconde instance démarre sur le même
//   profil (constaté : deux instances en parallèle pendant 15 h). Un fichier d'instance
//   (PID + date de démarrage du processus) la détecte ;
// - processus orphelins : une instance tuée (SIGKILL) laisse parfois ses processus
//   Chromium (service réseau…) tourner, qui gardent les fichiers du profil ouverts.

import fs from "node:fs";
import path from "node:path";

const INSTANCE_FILE = "instance.json";
/** Ligne de commande d'une seconde instance (liens à ouvrir), remise à l'instance en place. */
const HANDOVER_FILE = "second-instance.json";
const HANDOVER_MAX_AGE_MS = 10_000;

function read(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** Identité stable d'un processus : démarrage de la machine + instant de démarrage du processus. */
export function processIdentity(pid: number, procRoot = "/proc"): string | null {
  const stat = read(path.join(procRoot, String(pid), "stat"));
  const boot = read(path.join(procRoot, "sys", "kernel", "random", "boot_id"))?.trim();
  if (!stat || !boot) return null;
  // Champ 22 (starttime), après le nom du programme entre parenthèses.
  const start = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  return start ? `${boot}:${start}` : null;
}

/** PID d'une autre instance encore vivante sur ce profil, ou null. */
export function otherInstance(userData: string, selfPid = process.pid, procRoot = "/proc"): number | null {
  const raw = read(path.join(userData, INSTANCE_FILE));
  if (!raw) return null;
  try {
    const record = JSON.parse(raw) as { pid?: unknown; identity?: unknown };
    if (typeof record.pid !== "number" || typeof record.identity !== "string" || record.pid === selfPid) return null;
    return processIdentity(record.pid, procRoot) === record.identity ? record.pid : null;
  } catch {
    return null;
  }
}

export function claimInstance(userData: string, selfPid = process.pid, procRoot = "/proc"): void {
  const identity = processIdentity(selfPid, procRoot);
  if (!identity) return;
  try {
    fs.writeFileSync(path.join(userData, INSTANCE_FILE), `${JSON.stringify({ pid: selfPid, identity })}\n`, { mode: 0o600 });
  } catch {
    // garde-fou secondaire : ne bloque jamais le démarrage
  }
}

export function releaseInstance(userData: string, selfPid = process.pid): void {
  const file = path.join(userData, INSTANCE_FILE);
  try {
    const record = JSON.parse(fs.readFileSync(file, "utf8")) as { pid?: unknown };
    if (record.pid === selfPid) fs.rmSync(file, { force: true });
  } catch {
    // absent ou illisible : rien à libérer
  }
}

/** Seconde instance (verrou de Chromium contourné) : sa ligne de commande pour l'instance en place. */
export function handOver(userData: string, argv: readonly string[], now = Date.now()): void {
  try {
    fs.writeFileSync(path.join(userData, HANDOVER_FILE), `${JSON.stringify({ argv, at: now })}\n`, { mode: 0o600 });
  } catch {
    // les liens seraient perdus ; la fenêtre s'affiche quand même
  }
}

/** Instance en place : ligne de commande remise par une seconde instance (récente, lue une fois). */
export function takeHandOver(userData: string, now = Date.now()): string[] {
  const file = path.join(userData, HANDOVER_FILE);
  const raw = read(file);
  if (raw === null) return [];
  fs.rmSync(file, { force: true });
  try {
    const record = JSON.parse(raw) as { argv?: unknown; at?: unknown };
    if (!Array.isArray(record.argv) || typeof record.at !== "number" || Math.abs(now - record.at) > HANDOVER_MAX_AGE_MS) return [];
    return record.argv.filter((arg): arg is string => typeof arg === "string");
  } catch {
    return [];
  }
}

/**
 * Processus Chromium d'une instance morte sur ce profil : ils portent son dossier de
 * données dans leur ligne de commande et ont été rattachés à init ou au gestionnaire de
 * services de l'utilisateur. Jamais un descendant de l'instance courante.
 */
export function orphanedProcesses(userData: string, selfPid = process.pid, procRoot = "/proc"): number[] {
  const marker = `--user-data-dir=${userData}`;
  const orphans: number[] = [];
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(procRoot).filter((name) => /^\d+$/.test(name));
  } catch {
    return [];
  }
  for (const entry of entries) {
    const pid = Number(entry);
    if (pid === selfPid) continue;
    const command = read(path.join(procRoot, entry, "cmdline"))?.split("\0").join(" ") ?? "";
    // La ligne de commande peut être réécrite d'un seul tenant (setproctitle) : recherche par
    // sous-chaîne, argument entier (« …/WhatHush » ne désigne pas « …/WhatHush-test »).
    if (!`${command} `.includes(`${marker} `) || !/--type=/.test(command)) continue;
    const stat = read(path.join(procRoot, entry, "stat"));
    if (!stat) continue;
    const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
    if (ppid === selfPid) continue;
    const parent = read(path.join(procRoot, String(ppid), "comm"))?.trim();
    if (ppid === 1 || parent === "systemd") orphans.push(pid);
  }
  return orphans;
}

/** Termine les orphelins (SIGTERM, puis SIGKILL pour ceux qui sont toujours là, revérifiés). */
export function killOrphans(userData: string, pids: readonly number[], selfPid = process.pid, procRoot = "/proc"): void {
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // déjà terminé
    }
  }
  if (pids.length === 0) return;
  setTimeout(() => {
    // Revérifiés avant SIGKILL : un PID libéré entre-temps n'est jamais visé.
    for (const pid of orphanedProcesses(userData, selfPid, procRoot)) {
      if (!pids.includes(pid)) continue;
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // terminé entre-temps
      }
    }
  }, 2000).unref();
}

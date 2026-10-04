// Fuseau horaire du système, relu à chaque calcul de politique (§13) : le moteur
// JavaScript garde le fuseau du lancement, un voyage ou un changement de réglage
// ne serait sinon pris en compte qu'au redémarrage.

import fs from "node:fs";

/** « /usr/share/zoneinfo/Europe/Paris » → « Europe/Paris ». */
export function timeZoneFromZoneinfoPath(target: string): string | null {
  const match = /zoneinfo\/(?:posix\/|right\/)?([A-Za-z0-9_+-]+(?:\/[A-Za-z0-9_+-]+)*)$/.exec(target);
  return match?.[1] ?? null;
}

function isValidTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

export function systemTimeZone(): string | undefined {
  const fromEnv = process.env.TZ?.replace(/^:/, "");
  if (fromEnv && isValidTimeZone(fromEnv)) return fromEnv;
  try {
    const zone = timeZoneFromZoneinfoPath(fs.readlinkSync("/etc/localtime"));
    if (zone && isValidTimeZone(zone)) return zone;
  } catch {
    // pas de lien symbolique : on garde le fuseau par défaut du moteur
  }
  return undefined;
}

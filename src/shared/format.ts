// Formats d'affichage partagés par la barre latérale et le tray.

import type { AccountItem } from "./ipc";

/** Temps restant compact : « 12 min », « 1h42 », « 3 j », puis la date au-delà d'une semaine. */
export function formatRemaining(until: Date, now: Date, timeZone?: string): string {
  const minutes = Math.max(1, Math.ceil((until.getTime() - now.getTime()) / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 24) return rest === 0 ? `${hours} h` : `${hours}h${String(rest).padStart(2, "0")}`;
  if (hours < 7 * 24) return `${Math.round(hours / 24)} j`;
  const sameYear = until.getFullYear() === now.getFullYear();
  return `jusqu’au ${new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short", ...(sameYear ? {} : { year: "numeric" }), ...(timeZone ? { timeZone } : {}) }).format(until)}`;
}

/** Symbole d'état d'un compte (§2.4). */
export function statusSymbol(account: Pick<AccountItem, "lifecycle" | "policy">): string {
  if (account.lifecycle === "sleeping") return "○";
  if (account.lifecycle === "needs_qr" || account.lifecycle === "crashed") return "!";
  if (account.policy.mode === "snoozed") return "◐";
  if (account.policy.mode === "calls-only") return "◑";
  return "●";
}

/** Indication courte à droite du nom : appel, non-lus, Snooze restant, veille… */
export function statusHint(account: Pick<AccountItem, "lifecycle" | "policy" | "unread" | "inCall">, now: Date): string {
  // §19 : l'appel en cours se voit partout, y compris dans le tray.
  if (account.inCall) return "En appel";
  if (account.lifecycle === "sleeping") return "En veille";
  if (account.lifecycle === "offline") return "Hors ligne";
  if (account.lifecycle === "needs_qr") return "QR à scanner";
  if (account.lifecycle === "crashed") return "erreur";
  if (account.policy.mode !== "normal") {
    const label = account.policy.mode === "snoozed" ? "Snooze" : "Appels seuls";
    return account.policy.until ? `${label} · ${formatRemaining(new Date(account.policy.until), now)}` : label;
  }
  return account.unread ? String(account.unread) : "";
}

export function lifecycleLabel(lifecycle: AccountItem["lifecycle"]): string {
  switch (lifecycle) {
    case "sleeping":
      return "En veille";
    case "loading":
      return "Chargement…";
    case "needs_qr":
      return "Liaison requise";
    case "ready":
      return "Connecté";
    case "offline":
      return "Hors ligne";
    case "crashed":
      return "Erreur";
  }
}

/** « Personnel » → « P », « Équipe produit » → « ÉP ». */
export function initials(label: string): string {
  const words = label.trim().split(/\s+/).filter(Boolean);
  const letters = words.slice(0, 2).map((word) => [...word][0] ?? "");
  return letters.join("").toUpperCase() || "?";
}

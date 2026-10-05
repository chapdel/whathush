// Formats d'affichage partagés par la barre latérale et le tray.

import { formatDateTime, t } from "./i18n";
import type { AccountItem } from "./ipc";

/** Temps restant compact : « 12 min », « 1h42 », « 3 j », puis la date au-delà d'une semaine. */
export function formatRemaining(until: Date, now: Date, timeZone?: string): string {
  const minutes = Math.max(1, Math.ceil((until.getTime() - now.getTime()) / 60_000));
  if (minutes < 60) return t("time.minutes", { count: minutes });
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 24) return rest === 0 ? t("time.hours", { count: hours }) : t("time.hoursMinutes", { hours, minutes: String(rest).padStart(2, "0") });
  if (hours < 7 * 24) return t("time.days", { count: Math.round(hours / 24) });
  const sameYear = until.getFullYear() === now.getFullYear();
  const date = formatDateTime(until, { day: "numeric", month: "short", ...(sameYear ? {} : { year: "numeric" }), ...(timeZone ? { timeZone } : {}) });
  return t("time.until", { date });
}

/** Symbole d'état d'un compte. */
export function statusSymbol(account: Pick<AccountItem, "lifecycle" | "policy">): string {
  if (account.lifecycle === "sleeping") return "○";
  if (account.lifecycle === "needs_qr" || account.lifecycle === "crashed") return "!";
  if (account.policy.mode === "snoozed") return "◐";
  if (account.policy.mode === "calls-only") return "◑";
  return "●";
}

/** Indication courte à droite du nom : appel, non-lus, Snooze restant, veille… */
export function statusHint(account: Pick<AccountItem, "lifecycle" | "policy" | "unread" | "inCall">, now: Date): string {
  // L'appel en cours se voit partout, y compris dans le tray.
  if (account.inCall) return t("status.inCall");
  if (account.lifecycle === "sleeping") return t("status.sleeping");
  if (account.lifecycle === "offline") return t("status.offline");
  if (account.lifecycle === "needs_qr") return t("status.qrToScan");
  if (account.lifecycle === "crashed") return t("status.error");
  if (account.policy.mode !== "normal") {
    const label = account.policy.mode === "snoozed" ? t("status.snooze") : t("status.callsOnlyShort");
    return account.policy.until ? t("common.separator", { a: label, b: formatRemaining(new Date(account.policy.until), now) }) : label;
  }
  return account.unread ? String(account.unread) : "";
}

export function lifecycleLabel(lifecycle: AccountItem["lifecycle"]): string {
  return t(`lifecycle.${lifecycle}`);
}

/** « Personnel » → « P », « Équipe produit » → « ÉP ». */
export function initials(label: string): string {
  const words = label.trim().split(/\s+/).filter(Boolean);
  const letters = words.slice(0, 2).map((word) => [...word][0] ?? "");
  return letters.join("").toUpperCase() || "?";
}

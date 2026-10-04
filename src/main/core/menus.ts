// Modèles des menus natifs (§21, §29) : tray, menu d'un compte, menu Focus.
// Fonctions pures ; le TrayManager les convertit en Menu Electron.

import { statusHint, statusSymbol } from "../../shared/format";
import type { AccountItem, ShellState, SnoozePresetInput } from "../../shared/ipc";

export type MenuAction =
  | { type: "show" }
  | { type: "quit" }
  | { type: "add-account" }
  | { type: "settings"; accountId?: string; section?: "focus" }
  | { type: "switch"; id: string }
  | { type: "snooze"; id: string; preset: SnoozePresetInput }
  | { type: "snooze-date"; id: string }
  | { type: "resume"; id: string }
  | { type: "sleep"; id: string }
  | { type: "wake"; id: string }
  | { type: "reload"; id: string }
  | { type: "remove"; id: string }
  | { type: "focus"; profileId: string | null; minutes: number | null };

export type MenuItemModel =
  | { kind: "separator" }
  | { kind: "label"; label: string }
  | { kind: "action"; label: string; action: MenuAction; checked?: boolean; enabled?: boolean }
  | { kind: "submenu"; label: string; items: MenuItemModel[] };

const SEPARATOR: MenuItemModel = { kind: "separator" };

export const SNOOZE_CHOICES: Array<{ label: string; preset: SnoozePresetInput }> = [
  { label: "30 minutes", preset: { kind: "minutes", minutes: 30 } },
  { label: "1 heure", preset: { kind: "minutes", minutes: 60 } },
  { label: "4 heures", preset: { kind: "minutes", minutes: 240 } },
  { label: "Jusqu’à demain matin", preset: { kind: "tomorrow-morning" } },
  { label: "Jusqu’à lundi", preset: { kind: "next-monday" } },
  { label: "Jusqu’à réactivation", preset: { kind: "indefinitely" } }
];

/** Accès direct : bouton Snooze → durée, sans sous-menu supplémentaire. */
export function snoozeMenu(id: string): MenuItemModel[] {
  return [
    ...SNOOZE_CHOICES.map((choice): MenuItemModel => ({ kind: "action", label: choice.label, action: { type: "snooze", id, preset: choice.preset } })),
    { kind: "action", label: "Jusqu’à une date…", action: { type: "snooze-date", id } }
  ];
}

export function accountLine(account: AccountItem, now: Date): string {
  const hint = statusHint(account, now);
  return `${account.active ? "✓" : statusSymbol(account)}  ${account.label}${hint ? `   ${hint}` : ""}`;
}

/** Actions d'un compte : sous-menu du tray et clic droit dans la barre latérale. */
export function accountMenu(account: AccountItem, options: { includeRemove: boolean }): MenuItemModel[] {
  const id = account.id;
  const items: MenuItemModel[] = [{ kind: "action", label: "Afficher", action: { type: "switch", id } }, SEPARATOR];

  if (account.policy.source === "manual" && account.policy.mode !== "normal") {
    items.push({ kind: "action", label: "Réactiver les notifications", action: { type: "resume", id } });
  } else if (account.policy.mode !== "normal") {
    items.push({ kind: "action", label: "Réactiver jusqu’au prochain changement", action: { type: "resume", id } });
  }
  items.push({
    kind: "submenu",
    label: "Snooze",
    items: snoozeMenu(id)
  });
  items.push(SEPARATOR);

  if (account.lifecycle === "sleeping") {
    items.push({ kind: "action", label: "Réveiller", action: { type: "wake", id } });
  } else {
    items.push({ kind: "action", label: "Mettre en veille", action: { type: "sleep", id }, enabled: !account.inCall });
    items.push({ kind: "action", label: "Recharger WhatsApp", action: { type: "reload", id } });
  }
  items.push({ kind: "action", label: "Paramètres…", action: { type: "settings", accountId: id } });

  if (options.includeRemove) {
    items.push(SEPARATOR, { kind: "action", label: "Supprimer le compte…", action: { type: "remove", id } });
  }
  return items;
}

export function focusMenu(state: Pick<ShellState, "focus">): MenuItemModel[] {
  const { profiles, activeProfileId } = state.focus;
  const items: MenuItemModel[] = [
    { kind: "action", label: "Aucun", action: { type: "focus", profileId: null, minutes: null }, checked: activeProfileId === null }
  ];
  for (const profile of profiles) {
    items.push({
      kind: "submenu",
      label: `${activeProfileId === profile.id ? "✓ " : ""}${profile.name}`,
      items: [
        { kind: "action", label: "Jusqu’à désactivation", action: { type: "focus", profileId: profile.id, minutes: null } },
        { kind: "action", label: "1 heure", action: { type: "focus", profileId: profile.id, minutes: 60 } },
        { kind: "action", label: "2 heures", action: { type: "focus", profileId: profile.id, minutes: 120 } },
        { kind: "action", label: "4 heures", action: { type: "focus", profileId: profile.id, minutes: 240 } }
      ]
    });
  }
  if (profiles.length === 0) items.push({ kind: "label", label: "Créez des profils dans les paramètres" });
  items.push(SEPARATOR, { kind: "action", label: "Configurer les Focus…", action: { type: "settings", section: "focus" } });
  return items;
}

export function trayMenu(state: ShellState, now: Date): MenuItemModel[] {
  const items: MenuItemModel[] = [{ kind: "label", label: state.productName }, SEPARATOR];
  for (const account of state.accounts) {
    items.push({ kind: "submenu", label: accountLine(account, now), items: accountMenu(account, { includeRemove: false }) });
  }
  if (state.accounts.length > 0) items.push(SEPARATOR);
  items.push({ kind: "submenu", label: "Focus", items: focusMenu(state) }, SEPARATOR);
  items.push({ kind: "action", label: "Ajouter un compte", action: { type: "add-account" } });
  items.push({ kind: "action", label: "Paramètres…", action: { type: "settings" } }, SEPARATOR);
  items.push({ kind: "action", label: "Afficher", action: { type: "show" } });
  items.push({ kind: "action", label: "Quitter", action: { type: "quit" } });
  return items;
}

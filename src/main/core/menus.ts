// Modèles des menus natifs : tray, menu d'un compte, menu Focus.
// Fonctions pures (de l'état et de la langue courante) ; le TrayManager les
// convertit en Menu Electron.

import { statusHint, statusSymbol } from "../../shared/format";
import { t } from "../../shared/i18n";
import type { AccountItem, SettingsSection, ShellState, SnoozePresetInput } from "../../shared/ipc";

export type MenuAction =
  | { type: "show" }
  | { type: "quit" }
  | { type: "add-account" }
  | { type: "settings"; accountId?: string; section?: SettingsSection }
  | { type: "switch"; id: string }
  | { type: "snooze"; id: string; preset: SnoozePresetInput }
  | { type: "snooze-date"; id: string }
  | { type: "resume"; id: string }
  | { type: "sleep"; id: string }
  | { type: "wake"; id: string }
  | { type: "reload"; id: string }
  | { type: "remove"; id: string }
  | { type: "focus"; profileId: string | null; minutes: number | null }
  | { type: "lock" }
  | { type: "media"; id: string; action: "pause" | "play" }
  | { type: "report" };

export type MenuItemModel =
  | { kind: "separator" }
  | { kind: "label"; label: string }
  | { kind: "action"; label: string; action: MenuAction; checked?: boolean; enabled?: boolean }
  | { kind: "submenu"; label: string; items: MenuItemModel[] };

const SEPARATOR: MenuItemModel = { kind: "separator" };

export function snoozeChoices(): Array<{ label: string; preset: SnoozePresetInput }> {
  return [
    { label: t("menu.snooze30"), preset: { kind: "minutes", minutes: 30 } },
    { label: t("menu.snooze1h"), preset: { kind: "minutes", minutes: 60 } },
    { label: t("menu.snooze4h"), preset: { kind: "minutes", minutes: 240 } },
    { label: t("menu.snoozeTomorrow"), preset: { kind: "tomorrow-morning" } },
    { label: t("menu.snoozeMonday"), preset: { kind: "next-monday" } },
    { label: t("menu.snoozeIndefinitely"), preset: { kind: "indefinitely" } }
  ];
}

/** Accès direct : bouton Snooze → durée, sans sous-menu supplémentaire. */
export function snoozeMenu(id: string): MenuItemModel[] {
  return [
    ...snoozeChoices().map((choice): MenuItemModel => ({ kind: "action", label: choice.label, action: { type: "snooze", id, preset: choice.preset } })),
    { kind: "action", label: t("menu.snoozeDate"), action: { type: "snooze-date", id } }
  ];
}

export function accountLine(account: AccountItem, now: Date): string {
  const hint = statusHint(account, now);
  return `${account.active ? "✓" : statusSymbol(account)}  ${account.label}${hint ? `   ${hint}` : ""}`;
}

/** Actions d'un compte : sous-menu du tray et clic droit dans la barre latérale. */
export function accountMenu(account: AccountItem, options: { includeRemove: boolean }): MenuItemModel[] {
  const id = account.id;
  const items: MenuItemModel[] = [{ kind: "action", label: t("menu.show"), action: { type: "switch", id } }, SEPARATOR];

  if (account.policy.source === "manual" && account.policy.mode !== "normal") {
    items.push({ kind: "action", label: t("menu.resume"), action: { type: "resume", id } });
  } else if (account.policy.mode !== "normal") {
    items.push({ kind: "action", label: t("menu.resumeUntilChange"), action: { type: "resume", id } });
  }
  items.push({
    kind: "submenu",
    label: t("menu.snooze"),
    items: snoozeMenu(id)
  });
  items.push(SEPARATOR);

  if (account.lifecycle === "sleeping") {
    items.push({ kind: "action", label: t("menu.wake"), action: { type: "wake", id } });
  } else {
    items.push({ kind: "action", label: t("menu.sleep"), action: { type: "sleep", id }, enabled: !account.inCall });
    items.push({ kind: "action", label: t("menu.reload"), action: { type: "reload", id } });
  }
  items.push({ kind: "action", label: t("menu.settings"), action: { type: "settings", accountId: id } });

  if (options.includeRemove) {
    items.push(SEPARATOR, { kind: "action", label: t("menu.remove"), action: { type: "remove", id } });
  }
  return items;
}

export function focusMenu(state: Pick<ShellState, "focus">): MenuItemModel[] {
  const { profiles, activeProfileId } = state.focus;
  const items: MenuItemModel[] = [
    { kind: "action", label: t("menu.focusNone"), action: { type: "focus", profileId: null, minutes: null }, checked: activeProfileId === null }
  ];
  for (const profile of profiles) {
    items.push({
      kind: "submenu",
      label: `${activeProfileId === profile.id ? "✓ " : ""}${profile.name}`,
      items: [
        { kind: "action", label: t("menu.focusUntilOff"), action: { type: "focus", profileId: profile.id, minutes: null } },
        { kind: "action", label: t("menu.snooze1h"), action: { type: "focus", profileId: profile.id, minutes: 60 } },
        { kind: "action", label: t("menu.snooze2h"), action: { type: "focus", profileId: profile.id, minutes: 120 } },
        { kind: "action", label: t("menu.snooze4h"), action: { type: "focus", profileId: profile.id, minutes: 240 } }
      ]
    });
  }
  if (profiles.length === 0) items.push({ kind: "label", label: t("menu.focusEmpty") });
  items.push(SEPARATOR, { kind: "action", label: t("menu.focusConfigure"), action: { type: "settings", section: "focus" } });
  return items;
}

export function trayMenu(state: ShellState, now: Date): MenuItemModel[] {
  // Verrouillé, le menu ne montre ni les comptes ni leur état.
  if (state.lock.locked) {
    return [
      { kind: "label", label: state.productName },
      SEPARATOR,
      { kind: "action", label: t("menu.unlock"), action: { type: "show" } },
      { kind: "action", label: t("menu.quit"), action: { type: "quit" } }
    ];
  }
  const items: MenuItemModel[] = [{ kind: "label", label: state.productName }, SEPARATOR];
  // Lecture en cours, avec Pause / Reprendre.
  const playing = state.nowPlaying;
  if (playing) {
    const title = playing.title ?? (playing.kind === "video" ? t("media.video") : t("media.voiceMessage"));
    items.push(
      { kind: "label", label: `${playing.playing ? "▶" : "❚❚"}  ${t(playing.playing ? "media.nowPlaying" : "media.paused", { label: playing.label })} · ${title}` },
      { kind: "action", label: playing.playing ? t("media.pause") : t("media.resume"), action: { type: "media", id: playing.accountId, action: playing.playing ? "pause" : "play" } },
      SEPARATOR
    );
  }
  for (const account of state.accounts) {
    items.push({ kind: "submenu", label: accountLine(account, now), items: accountMenu(account, { includeRemove: false }) });
  }
  if (state.accounts.length > 0) items.push(SEPARATOR);
  items.push({ kind: "submenu", label: t("menu.focus"), items: focusMenu(state) }, SEPARATOR);
  items.push({ kind: "action", label: t("menu.addAccount"), action: { type: "add-account" } });
  items.push({ kind: "action", label: t("menu.settings"), action: { type: "settings" } });
  items.push({ kind: "action", label: t("menu.report"), action: { type: "report" } }, SEPARATOR);
  if (state.lock.enabled) items.push({ kind: "action", label: t("menu.lock"), action: { type: "lock" } });
  items.push({ kind: "action", label: t("menu.show"), action: { type: "show" } });
  items.push({ kind: "action", label: t("menu.quit"), action: { type: "quit" } });
  return items;
}

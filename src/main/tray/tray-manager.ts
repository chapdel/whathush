// TrayManager (§18, §21) : icône et menu natifs, construits depuis le modèle pur.

import { Menu, nativeImage, Tray, type MenuItemConstructorOptions } from "electron";
import path from "node:path";
import type { MenuAction, MenuItemModel } from "../core/menus";

export function toElectronMenu(items: MenuItemModel[], dispatch: (action: MenuAction) => void): MenuItemConstructorOptions[] {
  return items.map((item): MenuItemConstructorOptions => {
    switch (item.kind) {
      case "separator":
        return { type: "separator" };
      case "label":
        return { label: item.label, enabled: false };
      case "submenu":
        return { label: item.label, submenu: toElectronMenu(item.items, dispatch) };
      case "action":
        return {
          label: item.label,
          enabled: item.enabled ?? true,
          ...(item.checked !== undefined ? { type: "checkbox" as const, checked: item.checked } : {}),
          click: () => dispatch(item.action)
        };
    }
  });
}

export class TrayManager {
  private tray: Tray | null = null;
  private lastUnread: boolean | null = null;

  constructor(
    private readonly iconDir: string,
    private readonly tooltip: string
  ) {}

  create(): void {
    if (this.tray) return;
    this.tray = new Tray(this.icon(false));
    this.tray.setToolTip(this.tooltip);
  }

  private icon(unread: boolean) {
    return nativeImage.createFromPath(path.join(this.iconDir, unread ? "tray-unread.png" : "tray.png"));
  }

  /** §21 : le clic n'est pas fiable partout, tout passe par le menu, reconstruit à chaque changement. */
  update(items: MenuItemModel[], unread: number, dispatch: (action: MenuAction) => void): void {
    if (!this.tray) return;
    this.tray.setContextMenu(Menu.buildFromTemplate(toElectronMenu(items, dispatch)));
    this.tray.setToolTip(unread > 0 ? `${this.tooltip} — ${unread} non lu${unread > 1 ? "s" : ""}` : this.tooltip);
    const hasUnread = unread > 0;
    if (hasUnread !== this.lastUnread) {
      this.lastUnread = hasUnread;
      this.tray.setImage(this.icon(hasUnread));
    }
  }

  destroy(): void {
    this.tray?.destroy();
    this.tray = null;
  }
}

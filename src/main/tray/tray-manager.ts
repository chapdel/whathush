// TrayManager (§18, §21) : icône et menu natifs, construits depuis le modèle pur.

import { Menu, nativeImage, Tray, type MenuItemConstructorOptions } from "electron";
import path from "node:path";
import { t } from "../../shared/i18n";
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
  private lastIcon: string | null = null;

  constructor(
    private readonly iconDir: string,
    private readonly tooltip: string
  ) {}

  create(): void {
    if (this.tray) return;
    this.tray = new Tray(this.icon("tray"));
    this.tray.setToolTip(this.tooltip);
  }

  /** Electron choisit la variante @2x sur un écran HiDPI. */
  private icon(name: string) {
    return nativeImage.createFromPath(path.join(this.iconDir, `${name}.png`));
  }

  /**
   * §21 : le clic n'est pas fiable partout, tout passe par le menu, reconstruit à chaque
   * changement. F4 : l'image porte le nombre de non-lus (voir core/tray.ts).
   */
  update(items: MenuItemModel[], unread: number, iconName: string, dispatch: (action: MenuAction) => void): void {
    if (!this.tray) return;
    this.tray.setContextMenu(Menu.buildFromTemplate(toElectronMenu(items, dispatch)));
    this.tray.setToolTip(unread > 0 ? t("tray.unread", { product: this.tooltip, count: unread }) : this.tooltip);
    if (iconName !== this.lastIcon) {
      this.lastIcon = iconName;
      this.tray.setImage(this.icon(iconName));
    }
  }

  destroy(): void {
    this.tray?.destroy();
    this.tray = null;
  }
}

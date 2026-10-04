// Icône du tray selon le total de non-lus (F4). Les images tray-1 … tray-9plus sont
// générées par scripts/icons.mjs (1x et @2x, choisies par Electron selon l'écran).

import type { TrayCountStyle } from "../../shared/schemas";

export function trayIconName(total: number, style: TrayCountStyle): string {
  if (total <= 0 || style === "none") return "tray";
  if (style === "dot") return "tray-unread";
  return total > 9 ? "tray-9plus" : `tray-${total}`;
}

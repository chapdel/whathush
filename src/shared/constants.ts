// Constantes partagées entre le processus principal, les preloads et l'UI.

export const WHATSAPP_ORIGIN = "https://web.whatsapp.com";
export const WHATSAPP_URL = `${WHATSAPP_ORIGIN}/`;

/** Partition Chromium d'un compte (§4). Figée à la création du compte. */
export function partitionFor(accountId: string): string {
  return `persist:wa-${accountId}`;
}

/** Dossier de la partition sous `<userData>/Partitions/` (§8). */
export function partitionDirName(accountId: string): string {
  return `wa-${accountId}`;
}

export const MAX_ACCOUNTS = 50;
export const LABEL_MAX_LENGTH = 40;
export const DEFAULT_ACCOUNT_COLOR = "#52796f";

/** Largeur de la barre latérale, partagée par la mise en page des vues et l'UI. */
export const SIDEBAR_WIDTH = { expanded: 232, collapsed: 76 } as const;
/** Bandeau réseau du shell, hors de la surface native WhatsApp. */
export const CONNECTION_BAR_HEIGHT = 44;

/** Donner la place aux conversations sur les petites fenêtres, sans modifier le choix enregistré. */
export function compactSidebar(contentWidth: number, preferred: boolean): boolean {
  return preferred || contentWidth < 960;
}

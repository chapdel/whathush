// Constantes partagées entre le processus principal, les preloads et l'UI.

export const WHATSAPP_ORIGIN = "https://web.whatsapp.com";
export const WHATSAPP_URL = `${WHATSAPP_ORIGIN}/`;

/** Partition Chromium d'un compte. Figée à la création du compte. */
export function partitionFor(accountId: string): string {
  return `persist:wa-${accountId}`;
}

/** Dossier de la partition sous `<userData>/Partitions/`. */
export function partitionDirName(accountId: string): string {
  return `wa-${accountId}`;
}

export const MAX_ACCOUNTS = 50;
export const LABEL_MAX_LENGTH = 40;
/** Indigo du logo. Toute la palette garde un contraste ≥ 4,5:1 avec des initiales blanches. */
export const DEFAULT_ACCOUNT_COLOR = "#5a5fc4";
/** name : suffixe de la clé de traduction « color.<name> ». */
export const ACCOUNT_COLORS = [
  { value: DEFAULT_ACCOUNT_COLOR, name: "indigo" },
  { value: "#4f7593", name: "blue" },
  { value: "#7f6690", name: "plum" },
  { value: "#8f6c45", name: "sand" },
  { value: "#8f5d67", name: "rose" },
  { value: "#4a6f65", name: "sage" },
  { value: "#5f6d55", name: "olive" }
] as const;

/** Largeur de la barre latérale, partagée par la mise en page des vues et l'UI. */
export const SIDEBAR_WIDTH = { expanded: 232, collapsed: 76 } as const;
/** Bandeau réseau du shell, hors de la surface native WhatsApp. */
export const CONNECTION_BAR_HEIGHT = 44;

/** Donner la place aux conversations sur les petites fenêtres, sans modifier le choix enregistré. */
export function compactSidebar(contentWidth: number, preferred: boolean): boolean {
  return preferred || contentWidth < 960;
}

/** Couleur de la palette la moins utilisée (à égalité, la première) : les comptes restent distincts. */
export function leastUsedAccountColor(used: readonly (string | undefined)[]): string {
  const counts = new Map<string, number>(ACCOUNT_COLORS.map((color) => [color.value, 0]));
  for (const color of used) if (color && counts.has(color)) counts.set(color, (counts.get(color) ?? 0) + 1);
  let best: string = DEFAULT_ACCOUNT_COLOR;
  let bestCount = Number.POSITIVE_INFINITY;
  for (const { value } of ACCOUNT_COLORS) {
    const count = counts.get(value) ?? 0;
    if (count < bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

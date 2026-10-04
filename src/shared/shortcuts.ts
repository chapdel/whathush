// Raccourcis clavier (§9, F1) : une seule table, lue par le gestionnaire de touches
// du processus principal et par la feuille des raccourcis. Impossible qu'ils divergent.

import type { MessageKey } from "./i18n";

export interface KeyInput {
  key: string;
  /** Touche physique (« Digit1 ») : Ctrl+1 marche aussi en AZERTY, où la touche produit « & ». */
  code?: string;
  control: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
}

export type ShortcutId =
  | "switch-account"
  | "next-account"
  | "previous-account"
  | "settings"
  | "focus-toggle"
  | "zoom-in"
  | "zoom-out"
  | "zoom-reset"
  | "shortcuts"
  | "veil"
  | "lock"
  | "paste-plain";

export interface ShortcutDefinition {
  id: ShortcutId;
  /** Touches affichées ; « Shift » est traduit à l'affichage. */
  keys: string[];
  label: MessageKey;
  match(input: KeyInput): boolean;
}

const ctrl = (input: KeyInput) => input.control && !input.alt && !input.meta;
const ctrlOnly = (input: KeyInput) => ctrl(input) && !input.shift;
const ctrlShift = (input: KeyInput) => ctrl(input) && input.shift;
const letter = (input: KeyInput, value: string) => input.key.toLowerCase() === value;

const ZOOM_KEYS = new Set(["=", "+", "-", "_"]);

/**
 * Chiffre d'un raccourci : la touche produit un chiffre (QWERTY, ou Maj en AZERTY), ou
 * bien la touche physique est un chiffre sans Maj (AZERTY : Ctrl+& vaut Ctrl+1). En
 * AZERTY, « - » est sur la touche 6 : c'est le zoom arrière, pas le compte 6.
 */
export function shortcutDigit(input: KeyInput): number | null {
  if (/^\d$/.test(input.key)) return Number(input.key);
  if (input.shift || ZOOM_KEYS.has(input.key)) return null;
  const fromCode = /^(?:Digit|Numpad)(\d)$/.exec(input.code ?? "");
  return fromCode ? Number(fromCode[1]) : null;
}

export const SHORTCUTS: readonly ShortcutDefinition[] = [
  { id: "switch-account", keys: ["Ctrl", "1…9"], label: "shortcut.switchAccount", match: (input) => ctrl(input) && (shortcutDigit(input) ?? 0) >= 1 },
  { id: "next-account", keys: ["Ctrl", "Tab"], label: "shortcut.nextAccount", match: (input) => ctrlOnly(input) && input.key === "Tab" },
  { id: "previous-account", keys: ["Ctrl", "Shift", "Tab"], label: "shortcut.previousAccount", match: (input) => ctrlShift(input) && input.key === "Tab" },
  { id: "settings", keys: ["Ctrl", ","], label: "shortcut.settings", match: (input) => ctrlOnly(input) && input.key === "," },
  {
    id: "focus-toggle",
    keys: ["F6"],
    label: "shortcut.focusToggle",
    match: (input) => input.key === "F6" && !input.control && !input.alt && !input.meta && !input.shift
  },
  // « + » : Ctrl+= sur un clavier QWERTY, Ctrl+Maj+= ou la touche « + » du pavé numérique.
  { id: "zoom-in", keys: ["Ctrl", "+"], label: "shortcut.zoomIn", match: (input) => ctrl(input) && (input.key === "=" || input.key === "+") },
  { id: "zoom-out", keys: ["Ctrl", "−"], label: "shortcut.zoomOut", match: (input) => ctrl(input) && (input.key === "-" || input.key === "_") },
  { id: "zoom-reset", keys: ["Ctrl", "0"], label: "shortcut.zoomReset", match: (input) => ctrl(input) && shortcutDigit(input) === 0 },
  { id: "shortcuts", keys: ["Ctrl", "/"], label: "shortcut.sheet", match: (input) => ctrl(input) && (input.key === "/" || input.key === "?") },
  { id: "veil", keys: ["Ctrl", "Shift", "H"], label: "shortcut.veil", match: (input) => ctrlShift(input) && letter(input, "h") },
  { id: "lock", keys: ["Ctrl", "Shift", "L"], label: "shortcut.lock", match: (input) => ctrlShift(input) && letter(input, "l") },
  { id: "paste-plain", keys: ["Ctrl", "Shift", "V"], label: "shortcut.pastePlain", match: (input) => ctrlShift(input) && letter(input, "v") }
];

export function matchShortcut(input: KeyInput): ShortcutDefinition | undefined {
  return SHORTCUTS.find((shortcut) => shortcut.match(input));
}

/** F1 : zoom par compte, de 50 à 200 % par paliers de 10 %. */
export const ZOOM = { min: 50, max: 200, step: 10, default: 100 } as const;

export function nextZoom(current: number, action: "in" | "out" | "reset"): number {
  if (action === "reset") return ZOOM.default;
  const snapped = Math.round(current / ZOOM.step) * ZOOM.step;
  const next = action === "in" ? snapped + ZOOM.step : snapped - ZOOM.step;
  return Math.min(ZOOM.max, Math.max(ZOOM.min, next));
}

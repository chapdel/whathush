// Liste blanche des permissions (§26). Tout le reste est refusé.

import { WHATSAPP_ORIGIN } from "../../shared/constants";

export const GRANTED_PERMISSIONS: ReadonlySet<string> = new Set([
  // Demandée au chargement : protège la session contre l'éviction du stockage (constat du Lab).
  "persistent-storage",
  "notifications",
  "media",
  "display-capture",
  "clipboard-read",
  "clipboard-sanitized-write",
  "fullscreen"
]);

/** Chromium transmet l'origine avec ou sans barre finale selon le chemin : on normalise. */
export function normalizeOrigin(value: string | null | undefined): string {
  if (!value) return "";
  try {
    return new URL(value).origin;
  } catch {
    return "";
  }
}

export function isPermissionGranted(permission: string, requestingOrigin: string | null | undefined, whatsappOrigin = WHATSAPP_ORIGIN): boolean {
  return normalizeOrigin(requestingOrigin) === whatsappOrigin && GRANTED_PERMISSIONS.has(permission);
}

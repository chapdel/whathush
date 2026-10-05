// Liste blanche des permissions et réglages par compte. Tout le reste est
// refusé ; une origine autre que WhatsApp est toujours refusée, quel que soit le réglage.

import { WHATSAPP_ORIGIN } from "../../shared/constants";
import type { AccountPermissions } from "../../shared/schemas";

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

/** Gérées par les réglages du compte ; les autres restent fixées par l'application. */
const ACCOUNT_MANAGED: ReadonlySet<string> = new Set(["media", "geolocation", "display-capture"]);

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

export type PermissionDecision = "grant" | "deny" | "ask";
export type PermissionSubject = "microphone" | "camera" | "microphoneCamera" | "location";

export interface PermissionRequest {
  permission: string;
  origin: string | null | undefined;
  /** Pour « media » : ce que la page demande (vide = inconnu, donc les deux). */
  mediaTypes?: readonly string[];
}

export interface PermissionOutcome {
  decision: PermissionDecision;
  /** Ce que le dialogue « Demander » doit nommer. */
  subject?: PermissionSubject;
}

/** Décision d'une demande de permission : origine, puis réglage du compte. */
export function decidePermission(request: PermissionRequest, settings: AccountPermissions, whatsappOrigin = WHATSAPP_ORIGIN): PermissionOutcome {
  if (normalizeOrigin(request.origin) !== whatsappOrigin) return { decision: "deny" };
  const { permission } = request;
  if (!ACCOUNT_MANAGED.has(permission)) return { decision: GRANTED_PERMISSIONS.has(permission) ? "grant" : "deny" };

  if (permission === "geolocation") return { decision: choice(settings.location), subject: "location" };
  // Partage d'écran : « Demander » laisse faire le portail (Wayland) ou notre dialogue de
  // choix d'écran (X11), qui sont eux-mêmes la demande.
  if (permission === "display-capture") return { decision: settings.screenShare === "deny" ? "deny" : "grant" };

  const types = request.mediaTypes && request.mediaTypes.length > 0 ? request.mediaTypes : ["audio", "video"];
  const wantsAudio = types.includes("audio");
  const wantsVideo = types.includes("video");
  const choices = [...(wantsAudio ? [settings.microphone] : []), ...(wantsVideo ? [settings.camera] : [])];
  const subject: PermissionSubject = wantsAudio && wantsVideo ? "microphoneCamera" : wantsVideo ? "camera" : "microphone";
  if (choices.includes("deny")) return { decision: "deny", subject };
  if (choices.includes("ask")) return { decision: "ask", subject };
  return { decision: "grant", subject };
}

function choice(value: "allow" | "ask" | "deny"): PermissionDecision {
  return value === "allow" ? "grant" : value;
}

/**
 * Vérification synchrone (navigator.permissions, enumerateDevices…). « Demander » répond
 * oui : la page fait alors sa demande, qui passe par le dialogue. Répondre non lui ferait
 * afficher « autorisez le micro dans votre navigateur ».
 */
export function checkPermission(permission: string, origin: string | null | undefined, mediaType: string | undefined, settings: AccountPermissions, whatsappOrigin = WHATSAPP_ORIGIN): boolean {
  if (normalizeOrigin(origin) !== whatsappOrigin) return false;
  if (permission === "geolocation") return settings.location !== "deny";
  if (permission === "display-capture") return settings.screenShare !== "deny";
  if (permission === "media") {
    if (mediaType === "audio") return settings.microphone !== "deny";
    if (mediaType === "video") return settings.camera !== "deny";
    return settings.microphone !== "deny" || settings.camera !== "deny";
  }
  return GRANTED_PERMISSIONS.has(permission);
}

/** « Toujours pour ce compte » : le réglage passe à « allow » pour ce qui a été demandé. */
export function alwaysAllow(settings: AccountPermissions, subject: PermissionSubject): AccountPermissions {
  switch (subject) {
    case "microphone":
      return { ...settings, microphone: "allow" };
    case "camera":
      return { ...settings, camera: "allow" };
    case "microphoneCamera":
      return { ...settings, microphone: "allow", camera: "allow" };
    case "location":
      return { ...settings, location: "allow" };
  }
}

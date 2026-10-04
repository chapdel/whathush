// Traduction des signaux de l'adaptateur WhatsApp (§35) en événements de cycle de vie.
// L'adaptateur lit l'écran de liaison (niveau 3) ; s'il ne répond pas, le compte
// est considéré connecté après ADAPTER_TIMEOUT_MS (mode dégradé, journalisé).

import type { LinkStatePayload } from "../../shared/ipc";
import type { Lifecycle, LifecycleEvent } from "./lifecycle";

export const ADAPTER_TIMEOUT_MS = 45_000;

/**
 * wasLinked : le compte a déjà été connecté pendant cette session. Sans cela, un
 * QR affiché après un échec de chargement n'est pas une « déconnexion à distance ».
 */
export function linkStateEvent(lifecycle: Lifecycle, signal: LinkStatePayload, wasLinked: boolean): LifecycleEvent | null {
  // Les conversations d'abord : un repère large de l'écran de liaison peut aussi
  // apparaître dans l'interface connectée (panneau « Appareils connectés »).
  if (signal.chats) {
    if (lifecycle === "loading") return "session-valid";
    if (lifecycle === "needs_qr") return "linked";
    // §34 : après un rechargement réussi, sortir de l'état hors ligne.
    if (lifecycle === "offline") return "network-restored";
    return null;
  }
  if (signal.linking) {
    if (lifecycle === "loading") return "link-required";
    if (lifecycle === "ready") return "remote-logout";
    if (lifecycle === "offline") return wasLinked ? "remote-logout" : "link-required";
  }
  return null;
}

/**
 * Fin du délai de l'adaptateur sans signal : la page s'est chargée sans erreur,
 * on la considère connectée (ou de nouveau en ligne). Mode dégradé.
 */
export function adapterTimeoutEvent(lifecycle: Lifecycle): LifecycleEvent | null {
  if (lifecycle === "loading") return "session-valid";
  if (lifecycle === "offline") return "network-restored";
  return null;
}

// LinkClassifier (§23) : décide du sort de toute navigation ou ouverture de fenêtre
// depuis une vue WhatsApp. Fonction pure, appelée par setWindowOpenHandler et
// will-navigate.

import { WHATSAPP_ORIGIN } from "../../shared/constants";

export type LinkContext = "window-open" | "navigation";

export type BlockReason =
  | "invalid-url"
  | "credentials-in-url"
  | "scheme-not-allowed"
  | "about-navigation"
  | "foreign-blob"
  | "invalid-phone"
  | "unsupported-whatsapp-link";

export type LinkDecision =
  /** navigation : rester dans la vue ; window-open : popup dans la même session. */
  | { action: "allow" }
  /** Lien de conversation : demander avec quel compte l'ouvrir (§23). */
  | { action: "choose-account"; webUrl: string; phone: string | null }
  /** Navigateur système, après filtrage du schéma. */
  | { action: "open-external"; url: string }
  | { action: "block"; reason: BlockReason };

const EXTERNAL_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);
const WA_ME_HOSTS = new Set(["wa.me", "www.wa.me"]);
const WA_SEND_HOSTS = new Set(["api.whatsapp.com", "whatsapp.com", "www.whatsapp.com"]);
const PHONE_DIGITS = /^\d{6,15}$/;
const MAX_TEXT_LENGTH = 4096;

function normalizePhone(raw: string | null): string | null | "invalid" {
  if (raw === null || raw.trim() === "") return null;
  const digits = raw.replace(/[\s+\-().]/g, "");
  return PHONE_DIGITS.test(digits) ? digits : "invalid";
}

function chatLink(phoneRaw: string | null, textRaw: string | null, whatsappOrigin: string): LinkDecision {
  const phone = normalizePhone(phoneRaw);
  const text = textRaw ? textRaw.slice(0, MAX_TEXT_LENGTH) : null;
  if (phone === "invalid" || (phone === null && !text)) return { action: "block", reason: "invalid-phone" };
  const params = new URLSearchParams();
  if (phone) params.set("phone", phone);
  if (text) params.set("text", text);
  return { action: "choose-account", webUrl: `${whatsappOrigin}/send?${params.toString()}`, phone };
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function classifyLink(rawUrl: string, context: LinkContext, whatsappOrigin = WHATSAPP_ORIGIN): LinkDecision {
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    return { action: "block", reason: "invalid-url" };
  }

  if (url.protocol === "about:") {
    return url.pathname === "blank" && context === "window-open"
      ? { action: "allow" }
      : { action: "block", reason: "about-navigation" };
  }

  if (url.protocol === "blob:") {
    // L'origine d'une URL blob est celle de la page qui l'a créée.
    return url.origin === whatsappOrigin && context === "window-open"
      ? { action: "allow" }
      : { action: "block", reason: "foreign-blob" };
  }

  if (url.protocol === "whatsapp:") {
    // whatsapp://send?phone=…&text=… : l'hôte porte l'action.
    return url.host === "send"
      ? chatLink(url.searchParams.get("phone"), url.searchParams.get("text"), whatsappOrigin)
      : { action: "block", reason: "unsupported-whatsapp-link" };
  }

  if (!EXTERNAL_PROTOCOLS.has(url.protocol)) return { action: "block", reason: "scheme-not-allowed" };
  if (url.username || url.password) return { action: "block", reason: "credentials-in-url" };
  if (url.protocol === "mailto:") return { action: "open-external", url: url.href };

  if (url.origin === whatsappOrigin) return { action: "allow" };

  const host = url.hostname.toLowerCase();
  if (WA_ME_HOSTS.has(host)) {
    const path = safeDecode(url.pathname.slice(1)).replace(/\/$/, "");
    // wa.me/<numéro> ou wa.me/?text=… ; les autres formes (wa.me/message/…)
    // sont résolues côté serveur : navigateur système.
    if (path === "" || /^[\d\s+\-().]+$/.test(path)) {
      return chatLink(path || null, url.searchParams.get("text"), whatsappOrigin);
    }
    return { action: "open-external", url: url.href };
  }
  if (WA_SEND_HOSTS.has(host) && /^\/send\/?$/.test(url.pathname)) {
    return chatLink(url.searchParams.get("phone"), url.searchParams.get("text"), whatsappOrigin);
  }

  return { action: "open-external", url: url.href };
}

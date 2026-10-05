import { describe, expect, it } from "vitest";
import { classifyLink, type LinkDecision } from "../../src/main/core/links";

const cases: Array<[string, string, "window-open" | "navigation", LinkDecision]> = [
  // WhatsApp lui-même
  ["navigation interne", "https://web.whatsapp.com/send?phone=33612345678", "navigation", { action: "allow" }],
  ["popup même origine", "https://web.whatsapp.com/call", "window-open", { action: "allow" }],
  ["popup about:blank", "about:blank", "window-open", { action: "allow" }],
  ["blob de WhatsApp en popup", "blob:https://web.whatsapp.com/1b2c3d4e", "window-open", { action: "allow" }],

  // Liens externes
  ["https externe", "https://example.com/page?q=1", "window-open", { action: "open-external", url: "https://example.com/page?q=1" }],
  ["navigation vers l'extérieur", "https://example.com/", "navigation", { action: "open-external", url: "https://example.com/" }],
  ["http externe", "http://example.com", "window-open", { action: "open-external", url: "http://example.com/" }],
  ["mailto", "mailto:contact@example.com", "window-open", { action: "open-external", url: "mailto:contact@example.com" }],
  ["sosie de domaine", "https://web.whatsapp.com.evil.example/", "navigation", { action: "open-external", url: "https://web.whatsapp.com.evil.example/" }],
  ["WhatsApp en http", "http://web.whatsapp.com/", "navigation", { action: "open-external", url: "http://web.whatsapp.com/" }],
  ["wa.me/message (résolu côté serveur)", "https://wa.me/message/ABCDEF123", "window-open", { action: "open-external", url: "https://wa.me/message/ABCDEF123" }],

  // Liens de conversation → choix du compte
  ["wa.me numéro", "https://wa.me/33612345678", "window-open", { action: "choose-account", webUrl: "https://web.whatsapp.com/send?phone=33612345678", phone: "33612345678" }],
  ["wa.me numéro + texte", "https://wa.me/33612345678?text=Bonjour%20toi", "window-open", { action: "choose-account", webUrl: "https://web.whatsapp.com/send?phone=33612345678&text=Bonjour+toi", phone: "33612345678" }],
  ["wa.me numéro formaté", "https://wa.me/+33%206%2012%2034%2056%2078", "window-open", { action: "choose-account", webUrl: "https://web.whatsapp.com/send?phone=33612345678", phone: "33612345678" }],
  ["wa.me texte seul", "https://wa.me/?text=Salut", "window-open", { action: "choose-account", webUrl: "https://web.whatsapp.com/send?text=Salut", phone: null }],
  ["api.whatsapp.com/send", "https://api.whatsapp.com/send?phone=33612345678&text=hi", "window-open", { action: "choose-account", webUrl: "https://web.whatsapp.com/send?phone=33612345678&text=hi", phone: "33612345678" }],
  ["whatsapp://send", "whatsapp://send?phone=33612345678", "navigation", { action: "choose-account", webUrl: "https://web.whatsapp.com/send?phone=33612345678", phone: "33612345678" }],
  ["whatsapp://send texte seul", "whatsapp://send?text=hello", "navigation", { action: "choose-account", webUrl: "https://web.whatsapp.com/send?text=hello", phone: null }],

  // Bloqués
  ["file://", "file:///etc/passwd", "window-open", { action: "block", reason: "scheme-not-allowed" }],
  ["javascript:", "javascript:alert(1)", "navigation", { action: "block", reason: "scheme-not-allowed" }],
  ["data:", "data:text/html,<script>alert(1)</script>", "window-open", { action: "block", reason: "scheme-not-allowed" }],
  ["smb://", "smb://server/share", "window-open", { action: "block", reason: "scheme-not-allowed" }],
  ["schéma applicatif", "vscode://file/etc/passwd", "window-open", { action: "block", reason: "scheme-not-allowed" }],
  ["tel:", "tel:+33612345678", "window-open", { action: "block", reason: "scheme-not-allowed" }],
  ["identifiants dans l'URL", "https://user:secret@example.com/", "window-open", { action: "block", reason: "credentials-in-url" }],
  ["about:blank en navigation", "about:blank", "navigation", { action: "block", reason: "about-navigation" }],
  ["blob étranger", "blob:https://evil.example/123", "window-open", { action: "block", reason: "foreign-blob" }],
  ["blob WhatsApp en navigation", "blob:https://web.whatsapp.com/123", "navigation", { action: "block", reason: "foreign-blob" }],
  ["numéro trop court", "https://wa.me/123", "window-open", { action: "block", reason: "invalid-phone" }],
  ["whatsapp://call", "whatsapp://call?phone=33612345678", "navigation", { action: "block", reason: "unsupported-whatsapp-link" }],
  ["URL invalide", "pas une url", "window-open", { action: "block", reason: "invalid-url" }],
  ["chaîne vide", "   ", "window-open", { action: "block", reason: "invalid-url" }]
];

describe("classifyLink", () => {
  it.each(cases)("%s", (_name, url, context, expected) => {
    expect(classifyLink(url, context)).toEqual(expected);
  });

  it("borne la longueur du texte prérempli", () => {
    const decision = classifyLink(`https://wa.me/33612345678?text=${"a".repeat(10_000)}`, "window-open");
    expect(decision.action).toBe("choose-account");
    if (decision.action === "choose-account") {
      expect(new URL(decision.webUrl).searchParams.get("text")).toHaveLength(4096);
    }
  });

  it("accepte une autre origine WhatsApp (fausse page des tests)", () => {
    expect(classifyLink("http://127.0.0.1:4000/x", "navigation", "http://127.0.0.1:4000")).toEqual({ action: "allow" });
  });
});

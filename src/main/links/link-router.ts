// LinkRouter (§23) : applique le LinkClassifier pur aux vues WhatsApp et aux
// liens reçus du système (whatsapp://, argument de ligne de commande).

import { shell, type BrowserWindow, type WebContents } from "electron";
import { classifyLink, type LinkDecision } from "../core/links";
import type { Logger } from "../log";

export interface LinkRouterDeps {
  whatsappOrigin: string;
  log: Logger;
  accountIds(): string[];
  openInAccount(accountId: string, url: string): void;
  /** Plusieurs comptes : demander lequel utiliser. */
  askAccount(pending: { webUrl: string; phone: string | null }): void;
  /** Preload injecté aussi dans les popups de WhatsApp (interception, suivi des appels). */
  popupPreload: string;
  /** Rattache une popup à son compte (IPC, notifications, appels, fermeture). */
  registerPopup(accountId: string, window: BrowserWindow): void;
  /** Mode test : enregistre au lieu d'ouvrir le navigateur. */
  openExternal?: (url: string) => void;
}

export class LinkRouter {
  private pending: { id: number; webUrl: string; phone: string | null } | null = null;
  private sequence = 0;

  constructor(private readonly deps: LinkRouterDeps) {}

  /** Chaque demande a son identifiant : l'UI ne rouvre pas une demande déjà traitée. */
  pendingLink(): { id: number; phone: string | null } | null {
    return this.pending ? { id: this.pending.id, phone: this.pending.phone } : null;
  }

  attach(accountId: string, webContents: WebContents): void {
    webContents.setWindowOpenHandler(({ url }) => {
      const decision = classifyLink(url, "window-open", this.deps.whatsappOrigin);
      if (decision.action === "allow") {
        // about:blank : on ne sait pas quelle frame l'ouvre (une iframe tierce le
        // pourrait) et la page y écrit ce qu'elle veut. Refusé tant que le Lab n'a
        // pas montré que WhatsApp en a besoin (question ouverte n°6).
        if (url.startsWith("about:")) {
          this.deps.log.warn("popup-about-blank-refused", { accountId });
          return { action: "deny" };
        }
        this.deps.log.info("popup-allowed", { accountId });
        return {
          action: "allow",
          overrideBrowserWindowOptions: {
            autoHideMenuBar: true,
            webPreferences: { preload: this.deps.popupPreload, sandbox: true, contextIsolation: true, nodeIntegration: false }
          }
        };
      }
      this.execute(decision, accountId);
      return { action: "deny" };
    });

    webContents.on("did-create-window", (child) => {
      this.deps.registerPopup(accountId, child);
      // Les popups héritent de la session : même routage pour leurs fenêtres et
      // leurs navigations. Sans cela, une popup about:blank pourrait ensuite charger
      // n'importe quel site dans l'application, avec la session du compte.
      child.webContents.setWindowOpenHandler(({ url }) => {
        this.execute(classifyLink(url, "window-open", this.deps.whatsappOrigin), accountId);
        return { action: "deny" };
      });
      child.webContents.on("will-navigate", (event) => {
        const decision = classifyLink(event.url, "navigation", this.deps.whatsappOrigin);
        if (decision.action === "allow") return;
        event.preventDefault();
        this.execute(decision, accountId);
      });
      child.webContents.on("will-redirect", (event) => {
        const decision = classifyLink(event.url, "navigation", this.deps.whatsappOrigin);
        if (decision.action === "allow") return;
        event.preventDefault();
        this.execute(decision, accountId);
      });
    });

    for (const eventName of ["will-navigate", "will-redirect"] as const) {
      webContents.on(eventName as "will-navigate", (event) => {
        if (!event.isMainFrame) return;
        const decision = classifyLink(event.url, "navigation", this.deps.whatsappOrigin);
        if (decision.action === "allow") return;
        event.preventDefault();
        this.execute(decision, accountId);
      });
    }
  }

  /** Lien reçu de l'extérieur (whatsapp://…), sans compte d'origine. */
  handleExternal(url: string): void {
    this.execute(classifyLink(url, "navigation", this.deps.whatsappOrigin), null);
  }

  execute(decision: LinkDecision, sourceAccountId: string | null): void {
    switch (decision.action) {
      case "allow":
        return;
      case "open-external":
        this.deps.log.info("open-external", { sourceAccountId });
        if (this.deps.openExternal) this.deps.openExternal(decision.url);
        else void shell.openExternal(decision.url);
        return;
      case "choose-account": {
        const ids = this.deps.accountIds();
        if (ids.length === 1 && ids[0]) {
          this.deps.openInAccount(ids[0], decision.webUrl);
        } else if (ids.length > 1) {
          this.pending = { id: ++this.sequence, webUrl: decision.webUrl, phone: decision.phone };
          this.deps.askAccount(this.pending);
        }
        return;
      }
      case "block":
        this.deps.log.warn("link-blocked", { reason: decision.reason, sourceAccountId });
        return;
    }
  }

  resolve(accountId: string | null): void {
    const pending = this.pending;
    this.pending = null;
    if (pending && accountId) this.deps.openInAccount(accountId, pending.webUrl);
  }
}

/** Liens whatsapp:// passés en argument (lancement ou deuxième instance). */
export function linksFromArgv(argv: readonly string[]): string[] {
  return argv.filter((arg) => /^whatsapp:\/\//i.test(arg));
}

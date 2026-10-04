// NotificationManager (§10) : reçoit les notifications interceptées par le preload,
// applique la politique du compte, affiche la notification système et ramène
// l'utilisateur sur le bon compte et la bonne conversation au clic.
// Les notifications sont rattachées à la page qui les a créées : une page qui
// navigue ou disparaît emporte les siennes (leurs identifiants n'auraient plus de sens).

import { nativeImage, Notification } from "electron";
import type { NotifyPayload } from "../../shared/ipc";
import type { AccountConfig } from "../../shared/schemas";
import type { EffectivePolicy } from "../core/policy";
import type { Logger } from "../log";
import { looksLikeCallNotification } from "../whatsapp-adapter/call-classifier";

export interface ShownNotification {
  accountId: string;
  webContentsId: number;
  id: number;
  title: string;
  body: string;
  silent: boolean;
  isCall: boolean;
}

export interface NotificationDeps {
  log: Logger;
  account(accountId: string): AccountConfig | undefined;
  policy(accountId: string): EffectivePolicy | undefined;
  accountsInCall(): string[];
  /** Affiche le compte, ramène la fenêtre et renvoie le clic à la page d'origine. */
  open(accountId: string, webContentsId: number, notificationId: number): void;
  /** Mode test : enregistre au lieu d'afficher (§39). */
  sink?: (notification: ShownNotification) => void;
}

export type NotifyOutcome = "shown" | "dropped-policy" | "dropped-disabled";

interface Live {
  accountId: string;
  webContentsId: number;
  notification: Notification;
}

export class NotificationManager {
  private readonly live = new Map<string, Live>();

  constructor(private readonly deps: NotificationDeps) {}

  private key(webContentsId: number, notificationId: number): string {
    return `${webContentsId}:${notificationId}`;
  }

  handle(accountId: string, webContentsId: number, payload: NotifyPayload): NotifyOutcome {
    const account = this.deps.account(accountId);
    const policy = this.deps.policy(accountId);
    if (!account || !policy) return "dropped-disabled";

    const isCall = looksLikeCallNotification(payload.title, payload.body);
    const allowed = isCall ? policy.notifyCalls : policy.notifyMessages;
    if (!allowed) {
      this.deps.log.debug("notification-dropped", { accountId, mode: policy.mode, isCall });
      return account.notifications.enabled ? "dropped-policy" : "dropped-disabled";
    }

    const otherCall = isCall && this.deps.accountsInCall().some((id) => id !== accountId);
    const title = `${account.label} — ${payload.title}`;
    const preview = !policy.showPreview ? (isCall ? "Appel entrant" : "Nouveau message") : payload.body;
    const body = otherCall ? `${preview}\nUn autre appel est en cours.` : preview;
    // Le réglage « Son » du compte vaut aussi pour les appels.
    const silent = payload.silent || !account.notifications.sound;

    if (this.deps.sink) {
      this.deps.sink({ accountId, webContentsId, id: payload.id, title, body, silent, isCall });
      return "shown";
    }
    if (!Notification.isSupported()) return "dropped-disabled";

    const key = this.key(webContentsId, payload.id);
    this.live.get(key)?.notification.close();
    const notification = new Notification({
      title,
      body,
      silent,
      ...(policy.showPreview && payload.icon ? { icon: nativeImage.createFromDataURL(payload.icon) } : {}),
      // Jamais « critical » : cette urgence passerait outre le mode Ne pas déranger du bureau.
      urgency: "normal"
    });
    // Garder une référence : sans elle, le ramasse-miettes peut perdre le clic.
    this.live.set(key, { accountId, webContentsId, notification });
    notification.on("click", () => {
      this.deps.log.info("notification-click", { accountId });
      this.deps.open(accountId, webContentsId, payload.id);
    });
    notification.on("close", () => {
      if (this.live.get(key)?.notification === notification) this.live.delete(key);
    });
    notification.show();
    return "shown";
  }

  close(webContentsId: number, notificationId: number): void {
    const key = this.key(webContentsId, notificationId);
    this.live.get(key)?.notification.close();
    this.live.delete(key);
  }

  /** La page a navigué ou disparu. */
  closeForPage(webContentsId: number): void {
    for (const [key, entry] of this.live) {
      if (entry.webContentsId === webContentsId) {
        entry.notification.close();
        this.live.delete(key);
      }
    }
  }

  /** Compte mis en veille ou supprimé. */
  closeForAccount(accountId: string): void {
    for (const [key, entry] of this.live) {
      if (entry.accountId === accountId) {
        entry.notification.close();
        this.live.delete(key);
      }
    }
  }
}

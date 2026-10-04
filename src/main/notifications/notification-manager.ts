// NotificationManager (§10) : reçoit les notifications interceptées par le preload,
// applique la politique du compte, affiche la notification système et ramène
// l'utilisateur sur le bon compte et la bonne conversation au clic.
// Les notifications sont rattachées à la page qui les a créées : une page qui
// navigue ou disparaît emporte les siennes (leurs identifiants n'auraient plus de sens).

import { nativeImage, Notification } from "electron";
import { t } from "../../shared/i18n";
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
  hasIcon: boolean;
}

export interface NotificationDeps {
  log: Logger;
  account(accountId: string): AccountConfig | undefined;
  policy(accountId: string): EffectivePolicy | undefined;
  accountsInCall(): string[];
  /** Affiche le compte, ramène la fenêtre et renvoie le clic à la page d'origine. */
  open(accountId: string, webContentsId: number, notificationId: number): void;
  /** F6 : verrouillé, ni aperçu ni photo. */
  locked(): boolean;
  /** F10 : photo servie par un autre domaine de WhatsApp. */
  fetchAvatar(accountId: string, url: string): Promise<Buffer | null>;
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
  /** Notifications dont la photo se télécharge : fermées entre-temps, elles ne s'affichent pas. */
  private readonly pending = new Map<string, { accountId: string; webContentsId: number }>();

  constructor(private readonly deps: NotificationDeps) {}

  private key(webContentsId: number, notificationId: number): string {
    return `${webContentsId}:${notificationId}`;
  }

  async handle(accountId: string, webContentsId: number, payload: NotifyPayload): Promise<NotifyOutcome> {
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
    // Le réglage « Son » du compte vaut aussi pour les appels.
    const silent = payload.silent || !account.notifications.sound;
    const key = this.key(webContentsId, payload.id);
    let icon: Electron.NativeImage | null = null;
    if (policy.showPreview && !this.deps.locked() && payload.icon) icon = nativeImage.createFromDataURL(payload.icon);
    else if (policy.showPreview && !this.deps.locked() && payload.iconUrl) {
      this.pending.set(key, { accountId, webContentsId });
      const image = await this.deps.fetchAvatar(accountId, payload.iconUrl);
      if (!this.pending.delete(key)) return "dropped-disabled";
      if (image) icon = nativeImage.createFromBuffer(image);
    }
    // Verrouillé (F6), y compris pendant le téléchargement de la photo : la notification
    // reste, pour ne pas manquer un appel, mais sans aperçu, sans expéditeur et sans photo.
    const locked = this.deps.locked();
    const showPreview = policy.showPreview && !locked;
    if (!showPreview || icon?.isEmpty()) icon = null;
    const title = locked ? account.label : `${account.label} — ${payload.title}`;
    const preview = !showPreview ? (isCall ? t("notification.incomingCall") : t("notification.newMessage")) : payload.body;
    const body = otherCall ? `${preview}\n${t("notification.otherCall")}` : preview;

    if (this.deps.sink) {
      this.deps.sink({ accountId, webContentsId, id: payload.id, title, body, silent, isCall, hasIcon: icon !== null });
      return "shown";
    }
    if (!Notification.isSupported()) return "dropped-disabled";

    this.live.get(key)?.notification.close();
    const notification = new Notification({
      title,
      body,
      silent,
      ...(icon ? { icon } : {}),
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
    this.pending.delete(key);
    this.live.get(key)?.notification.close();
    this.live.delete(key);
  }

  /** La page a navigué ou disparu. */
  closeForPage(webContentsId: number): void {
    for (const [key, entry] of this.pending) if (entry.webContentsId === webContentsId) this.pending.delete(key);
    for (const [key, entry] of this.live) {
      if (entry.webContentsId === webContentsId) {
        entry.notification.close();
        this.live.delete(key);
      }
    }
  }

  /** Compte mis en veille ou supprimé. */
  closeForAccount(accountId: string): void {
    for (const [key, entry] of this.pending) if (entry.accountId === accountId) this.pending.delete(key);
    for (const [key, entry] of this.live) {
      if (entry.accountId === accountId) {
        entry.notification.close();
        this.live.delete(key);
      }
    }
  }
}

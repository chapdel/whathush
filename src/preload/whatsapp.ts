// Preload injecté dans chaque vue WhatsApp (sandbox + contextIsolation).
// - Niveau 1 (§35) : encapsule Notification, getUserMedia et getDisplayMedia dans
//   le main world, avant le code de la page (vérifié au Lab).
// - Niveau 3, isolé : l'adaptateur lit l'écran de liaison pour détecter QR et
//   déconnexion (lecture seule, sélecteurs regroupés ci-dessous).
// Le compte n'est jamais transmis : le processus principal le déduit de l'expéditeur.

import { contextBridge, ipcRenderer, webFrame } from "electron";
import { CHANNELS } from "../shared/channels";

const BRIDGE_NAME = "__whathushBridge";

contextBridge.exposeInMainWorld(BRIDGE_NAME, {
  notify: (payload: unknown) => ipcRenderer.send(CHANNELS.waNotify, payload),
  close: (id: number) => ipcRenderer.send(CHANNELS.waNotificationClose, id),
  media: (payload: unknown) => ipcRenderer.send(CHANNELS.waMedia, payload),
  swNotification: () => ipcRenderer.send(CHANNELS.waSwNotification),
  env: (payload: unknown) => ipcRenderer.send(CHANNELS.waEnv, payload),
  onNotificationClick: (callback: (id: number) => void) => {
    ipcRenderer.on(CHANNELS.waNotificationClick, (_event, id: number) => callback(id));
  }
});

// Exécutée dans le main world. Sérialisée : elle ne doit rien utiliser de ce module.
function installMainWorldHooks(bridgeName: string): void {
  const bridge = (window as any)[bridgeName];
  if (!bridge) return;
  const scriptsBeforeOverride = document.scripts.length;
  const MAX_ICON_BYTES = 256 * 1024;

  async function iconToDataUrl(source: string): Promise<string | null> {
    if (!source) return null;
    if (/^data:image\/(png|jpeg|webp|gif);base64,/.test(source)) return source.length < 350_000 ? source : null;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1000);
      const response = await fetch(source, { signal: controller.signal });
      clearTimeout(timer);
      const blob = await response.blob();
      if (!/^image\/(png|jpeg|webp|gif)$/.test(blob.type) || blob.size > MAX_ICON_BYTES) return null;
      return await new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : null);
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(blob);
      });
    } catch {
      return null;
    }
  }

  // --- Notification (§10) -------------------------------------------------------
  let sequence = 0;
  const live = new Map<number, ProxyNotification>();

  class ProxyNotification extends EventTarget {
    static get permission(): NotificationPermission {
      return "granted";
    }
    static requestPermission(callback?: (permission: NotificationPermission) => void): Promise<NotificationPermission> {
      if (typeof callback === "function") callback("granted");
      return Promise.resolve("granted");
    }
    static get maxActions(): number {
      return 0;
    }

    readonly title: string;
    readonly body: string;
    readonly tag: string;
    readonly icon: string;
    readonly silent: boolean;
    readonly data: unknown;
    readonly proxyId: number;
    onclick: ((event: Event) => unknown) | null = null;
    onclose: ((event: Event) => unknown) | null = null;
    onshow: ((event: Event) => unknown) | null = null;
    onerror: ((event: Event) => unknown) | null = null;

    constructor(title: string, options: NotificationOptions = {}) {
      super();
      this.title = String(title);
      this.body = options.body ? String(options.body) : "";
      this.tag = options.tag ? String(options.tag) : "";
      this.icon = options.icon ? String(options.icon) : "";
      this.silent = Boolean(options.silent);
      this.data = options.data ?? null;
      this.proxyId = ++sequence;

      // Même tag : la nouvelle notification remplace l'ancienne.
      if (this.tag) {
        for (const [id, existing] of live) {
          if (existing.tag === this.tag) {
            live.delete(id);
            bridge.close(id);
          }
        }
      }
      live.set(this.proxyId, this);

      void iconToDataUrl(this.icon).then((icon) => {
        // Fermée (ou remplacée par tag) pendant le chargement de l'icône : rien à afficher.
        if (!live.has(this.proxyId)) return;
        bridge.notify({ id: this.proxyId, title: this.title, body: this.body, tag: this.tag, silent: this.silent, icon });
        this.fire("show");
      });
    }

    close(): void {
      if (live.delete(this.proxyId)) {
        bridge.close(this.proxyId);
        this.fire("close");
      }
    }

    fire(type: "click" | "close" | "show" | "error"): void {
      const event = new Event(type);
      this.dispatchEvent(event);
      const handler = (this as any)["on" + type];
      if (typeof handler === "function") handler.call(this, event);
    }
  }

  bridge.onNotificationClick((id: number) => live.get(id)?.fire("click"));
  Object.defineProperty(window, "Notification", { value: ProxyNotification, writable: true, configurable: true });

  // Question ouverte n°2 : notifications passant par le service worker (non interceptées).
  const swProto = (window as any).ServiceWorkerRegistration?.prototype;
  if (swProto && typeof swProto.showNotification === "function") {
    const original = swProto.showNotification;
    swProto.showNotification = function (this: unknown, ...args: unknown[]) {
      try {
        bridge.swNotification();
      } catch {
        // le signalement ne doit jamais casser la page
      }
      return original.apply(this, args);
    };
  }

  // --- Micro, caméra, partage d'écran (§19) ---------------------------------------
  const track = (source: "getUserMedia" | "getDisplayMedia", stream: MediaStream): void => {
    for (const mediaTrack of stream.getTracks()) {
      let ended = false;
      const end = (): void => {
        if (ended) return;
        ended = true;
        bridge.media({ source, event: "stop", trackKind: mediaTrack.kind });
      };
      bridge.media({ source, event: "start", trackKind: mediaTrack.kind });
      mediaTrack.addEventListener("ended", end);
      const originalStop = mediaTrack.stop.bind(mediaTrack);
      mediaTrack.stop = () => {
        end();
        originalStop();
      };
    }
  };
  const mediaDevices = navigator.mediaDevices as any;
  if (mediaDevices) {
    for (const name of ["getUserMedia", "getDisplayMedia"] as const) {
      const original = mediaDevices[name];
      if (typeof original !== "function") continue;
      mediaDevices[name] = function (this: unknown, ...args: unknown[]) {
        return original.apply(this, args).then((stream: MediaStream) => {
          track(name, stream);
          return stream;
        });
      };
    }
  }

  bridge.env({
    userAgent: navigator.userAgent,
    notificationOverridden: (window as any).Notification === ProxyNotification,
    scriptsBeforeOverride
  });
}

try {
  contextBridge.executeInMainWorld({ func: installMainWorldHooks, args: [BRIDGE_NAME] });
} catch {
  void webFrame.executeJavaScript(`(${installMainWorldHooks.toString()})(${JSON.stringify(BRIDGE_NAME)})`);
}

// --- Visibilité de la page (§9 : accusés de lecture) -----------------------------
const sendVisibility = (): void => {
  ipcRenderer.send(CHANNELS.waVisibility, { state: document.visibilityState === "visible" ? "visible" : "hidden", hasFocus: document.hasFocus() });
};
document.addEventListener("visibilitychange", sendVisibility);
window.addEventListener("DOMContentLoaded", sendVisibility);

// --- Adaptateur WhatsApp (§35, niveau 3, lecture seule) ----------------------------
// Écran de liaison : repères relevés au Lab sur web.whatsapp.com (2026-10-04).
const LINKING_SELECTORS = [
  '[data-testid="link-device-qr-code"]',
  '[data-testid^="link_device"]',
  '[data-testid^="link-device"]',
  "div[data-ref]"
].join(",");
// Interface des conversations : repères historiques, à confirmer avec un compte
// connecté (test n°17). Sans réponse, le compte passe « connecté » après 45 s.
const CHATS_SELECTORS = ['#pane-side', '[data-testid="chat-list"]', '[data-testid="chatlist-header"]', "#side"].join(",");

let lastLinkState = "";
let linkTimer: ReturnType<typeof setTimeout> | null = null;

function reportLinkState(): void {
  linkTimer = null;
  const state = {
    linking: document.querySelector(LINKING_SELECTORS) !== null,
    chats: document.querySelector(CHATS_SELECTORS) !== null
  };
  const key = `${state.linking}|${state.chats}`;
  if (key !== lastLinkState) {
    lastLinkState = key;
    ipcRenderer.send(CHANNELS.waLinkState, state);
  }
}

// Limité à un relevé toutes les 1,5 s, même si la page change sans cesse.
function scheduleLinkState(): void {
  if (linkTimer === null) linkTimer = setTimeout(reportLinkState, 1500);
}

window.addEventListener("DOMContentLoaded", () => {
  new MutationObserver(scheduleLinkState).observe(document.documentElement, { childList: true, subtree: true });
  scheduleLinkState();
});

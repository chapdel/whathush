// Preload injecté dans chaque vue WhatsApp (sandbox + contextIsolation).
// Niveau 1 du plan (§35) : on encapsule des API standard du navigateur
// (Notification, getUserMedia, getDisplayMedia), sans jamais lire le DOM de WhatsApp.

import { contextBridge, ipcRenderer, webFrame } from "electron";
import type { EnvPayload, MediaPayload, NotifyPayload, VisibilityPayload } from "./shared";

const BRIDGE_NAME = "__labBridge";

// Pont minimal exposé au main world. Le main déduit le compte de l'expéditeur :
// la page ne transmet jamais d'identifiant de compte.
contextBridge.exposeInMainWorld(BRIDGE_NAME, {
  notify: (payload: NotifyPayload) => ipcRenderer.send("wa:notify", payload),
  close: (id: number) => ipcRenderer.send("wa:notification-close", id),
  media: (payload: MediaPayload) => ipcRenderer.send("wa:media", payload),
  swNotification: (payload: { title: string; tag: string }) => ipcRenderer.send("wa:sw-notification", payload),
  env: (payload: EnvPayload) => ipcRenderer.send("wa:env", payload),
  onNotificationClick: (callback: (id: number) => void) => {
    ipcRenderer.on("wa:notification-click", (_event, id: number) => callback(id));
  }
});

// Exécutée dans le main world, avant les scripts de la page.
// Doit rester autonome : elle est sérialisée, sans accès au scope de ce module.
function installMainWorldHooks(bridgeName: string): void {
  const bridge = (window as any)[bridgeName];
  if (!bridge) return;

  const scriptsBeforeOverride = document.scripts.length;
  const readyState = document.readyState;

  // --- Notification ---------------------------------------------------------
  let sequence = 0;
  const live = new Map<number, LabNotification>();

  class LabNotification extends EventTarget {
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
    onclick: ((event: Event) => unknown) | null = null;
    onclose: ((event: Event) => unknown) | null = null;
    onshow: ((event: Event) => unknown) | null = null;
    onerror: ((event: Event) => unknown) | null = null;
    readonly labId: number;

    constructor(title: string, options: NotificationOptions = {}) {
      super();
      this.title = String(title);
      this.body = options.body ? String(options.body) : "";
      this.tag = options.tag ? String(options.tag) : "";
      this.icon = options.icon ? String(options.icon) : "";
      this.silent = Boolean(options.silent);
      this.data = options.data ?? null;
      this.labId = ++sequence;

      // Même tag = remplacement de la notification précédente.
      if (this.tag) {
        for (const [id, existing] of live) {
          if (existing.tag === this.tag) {
            live.delete(id);
            bridge.close(id);
          }
        }
      }

      live.set(this.labId, this);
      bridge.notify({
        id: this.labId,
        title: this.title,
        body: this.body,
        tag: this.tag,
        hasIcon: this.icon.length > 0,
        silent: this.silent
      });
      setTimeout(() => this.fire("show"), 0);
    }

    close(): void {
      if (live.delete(this.labId)) {
        bridge.close(this.labId);
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

  bridge.onNotificationClick((id: number) => {
    const notification = live.get(id);
    if (notification) notification.fire("click");
  });

  Object.defineProperty(window, "Notification", {
    value: LabNotification,
    writable: true,
    configurable: true
  });

  // --- Notifications via service worker (journalisées, non interceptées) ---
  const swProto = (window as any).ServiceWorkerRegistration?.prototype;
  if (swProto && typeof swProto.showNotification === "function") {
    const original = swProto.showNotification;
    swProto.showNotification = function (this: unknown, title: string, options?: NotificationOptions) {
      try {
        bridge.swNotification({ title: String(title), tag: String(options?.tag ?? "") });
      } catch {
        // le journal ne doit jamais casser la page
      }
      return original.call(this, title, options);
    };
  }

  // --- Micro / caméra / partage d'écran -------------------------------------
  const trackStream = (source: "getUserMedia" | "getDisplayMedia", stream: MediaStream): void => {
    for (const track of stream.getTracks()) {
      let ended = false;
      const end = (): void => {
        if (ended) return;
        ended = true;
        bridge.media({ source, event: "stop", trackKind: track.kind });
      };
      bridge.media({ source, event: "start", trackKind: track.kind });
      track.addEventListener("ended", end);
      const originalStop = track.stop.bind(track);
      track.stop = () => {
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
          trackStream(name, stream);
          return stream;
        });
      };
    }
  }

  // --- Environnement (test n°1) ----------------------------------------------
  const uaData = (navigator as any).userAgentData;
  bridge.env({
    href: location.href,
    userAgent: navigator.userAgent,
    brands: Array.isArray(uaData?.brands) ? uaData.brands.map((b: any) => `${b.brand}/${b.version}`) : [],
    readyState,
    scriptsBeforeOverride,
    notificationOverridden: (window as any).Notification === LabNotification
  });
}

try {
  contextBridge.executeInMainWorld({ func: installMainWorldHooks, args: [BRIDGE_NAME] });
} catch (error) {
  ipcRenderer.send("wa:preload-error", `executeInMainWorld: ${String(error)}`);
  void webFrame.executeJavaScript(`(${installMainWorldHooks.toString()})(${JSON.stringify(BRIDGE_NAME)})`);
}

// --- Visibilité de la page (test n°5 : accusés de lecture) -------------------
// Le DOM est partagé entre les mondes : ces événements sont visibles ici.
const sendVisibility = (): void => {
  const payload: VisibilityPayload = { state: document.visibilityState, hasFocus: document.hasFocus() };
  ipcRenderer.send("wa:visibility", payload);
};
document.addEventListener("visibilitychange", sendVisibility);
window.addEventListener("DOMContentLoaded", sendVisibility);
window.addEventListener("focus", sendVisibility);
window.addEventListener("blur", sendVisibility);

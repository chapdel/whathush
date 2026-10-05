// Preload injecté dans chaque vue WhatsApp (sandbox + contextIsolation).
// - Niveau 1 : encapsule Notification, getUserMedia et getDisplayMedia dans
//   le main world, avant le code de la page (vérifié au Lab) ; observe la lecture
//   des éléments audio et vidéo par l'API standard des médias.
// - Niveau 3, isolé : l'adaptateur lit l'écran de liaison pour détecter QR et
//   déconnexion (lecture seule, sélecteurs regroupés ci-dessous) et vérifie les
//   repères du flou des messages.
// Le compte n'est jamais transmis : le processus principal le déduit de l'expéditeur.
// Son nom non plus n'entre jamais dans la page (WhatsApp pourrait le lire).

import { contextBridge, ipcRenderer, webFrame } from "electron";
import { CHANNELS } from "../shared/channels";

const BRIDGE_NAME = "__whathushBridge";

// Textes des métadonnées de lecture (« Message vocal »), dans la langue de l'application.
let labels: { voiceMessage: string; video: string; product: string } | null = null;
void ipcRenderer.invoke(CHANNELS.waLabels).then((value: typeof labels) => {
  labels = value;
});

contextBridge.exposeInMainWorld(BRIDGE_NAME, {
  notify: (payload: unknown) => ipcRenderer.send(CHANNELS.waNotify, payload),
  playback: (payload: unknown) => ipcRenderer.send(CHANNELS.waMediaPlayback, payload),
  labels: () => labels,
  onMediaControl: (callback: (action: string) => void) => {
    ipcRenderer.on(CHANNELS.waMediaControl, (_event, action: string) => callback(action));
  },
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

  // Une photo servie par une autre origine (pps.whatsapp.net) n'est pas lisible
  // ici (CORS) ; son adresse est transmise et le processus principal la télécharge.
  function crossOrigin(source: string): boolean {
    try {
      const url = new URL(source, location.href);
      return (url.protocol === "https:" || url.protocol === "http:") && url.origin !== location.origin;
    } catch {
      return false;
    }
  }

  async function iconToDataUrl(source: string): Promise<string | null> {
    if (!source) return null;
    if (/^data:image\/(png|jpeg|webp|gif);base64,/.test(source)) return source.length < 350_000 ? source : null;
    if (crossOrigin(source)) return null;
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

  // --- Notification -------------------------------------------------------------
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
        const iconUrl = !icon && this.icon && crossOrigin(this.icon) ? new URL(this.icon, location.href).href.slice(0, 2048) : null;
        bridge.notify({ id: this.proxyId, title: this.title, body: this.body, tag: this.tag, silent: this.silent, icon, iconUrl });
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

  // --- Micro, caméra, partage d'écran ---------------------------------------------
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

  // --- Lecture des médias ---------------------------------------------------------------
  // Les éléments hors du DOM (new Audio()) ne remontent pas leurs événements jusqu'au
  // document : play() est aussi encapsulé. Les sons courts (notification, < 2,5 s) et en
  // boucle (sonnerie) ne sont pas des lectures.
  const watched = new WeakSet<HTMLMediaElement>();
  const playing = new Set<HTMLMediaElement>();
  let lastPaused: HTMLMediaElement | null = null;
  let ourMetadata: MediaMetadata | null = null;
  // Ni sonnerie (en boucle), ni son court, ni flux d'appel (srcObject : caméra, correspondant).
  const isReading = (element: HTMLMediaElement): boolean =>
    !element.loop && element.srcObject === null && !(Number.isFinite(element.duration) && element.duration < 2.5);
  const kindOf = (element: HTMLMediaElement): "audio" | "video" => (element instanceof HTMLVideoElement && element.videoWidth > 0 ? "video" : "audio");
  const pageTitle = (): string | null => {
    try {
      const metadata = navigator.mediaSession?.metadata;
      return metadata && metadata !== ourMetadata && metadata.title ? String(metadata.title).slice(0, 300) : null;
    } catch {
      return null;
    }
  };
  const reportPlayback = (element: HTMLMediaElement, state: "playing" | "paused" | "ended"): void => {
    if (!isReading(element)) return;
    try {
      // Bureau (MPRIS) : sans métadonnées de la page, « Message vocal — WhatHush ».
      if (state === "playing" && navigator.mediaSession && !navigator.mediaSession.metadata) {
        const texts = bridge.labels();
        if (texts) {
          ourMetadata = new MediaMetadata({ title: kindOf(element) === "video" ? texts.video : texts.voiceMessage, artist: texts.product });
          navigator.mediaSession.metadata = ourMetadata;
        }
      }
      if (state === "ended" && playing.size === 0 && ourMetadata && navigator.mediaSession?.metadata === ourMetadata) {
        navigator.mediaSession.metadata = null;
        ourMetadata = null;
      }
      bridge.playback({ state, kind: kindOf(element), title: pageTitle(), startedVisible: document.visibilityState === "visible" });
    } catch {
      // le suivi ne doit jamais casser la page
    }
  };
  const watch = (element: HTMLMediaElement): void => {
    if (watched.has(element)) return;
    watched.add(element);
    // « playing » plutôt que « play » : la lecture a vraiment commencé, la durée est
    // connue (un son de notification court est alors reconnu).
    element.addEventListener("playing", () => {
      if (!isReading(element)) return;
      playing.add(element);
      reportPlayback(element, "playing");
    });
    element.addEventListener("pause", () => {
      playing.delete(element);
      if (element.ended || !isReading(element)) return;
      lastPaused = element;
      reportPlayback(element, "paused");
    });
    element.addEventListener("ended", () => {
      playing.delete(element);
      if (lastPaused === element) lastPaused = null;
      reportPlayback(element, "ended");
    });
  };
  // Phase de capture : l'élément est suivi avant que sa lecture ne commence vraiment.
  document.addEventListener(
    "play",
    (event) => {
      if (event.target instanceof HTMLMediaElement) watch(event.target);
    },
    true
  );
  const mediaProto = HTMLMediaElement.prototype as any;
  const originalPlay = mediaProto.play;
  mediaProto.play = function (this: HTMLMediaElement, ...args: unknown[]) {
    watch(this);
    return originalPlay.apply(this, args);
  };
  // Pause / Reprendre depuis la barre latérale ou le tray : API standard, aucun sélecteur.
  bridge.onMediaControl((action: string) => {
    if (action === "pause") for (const element of [...playing]) element.pause();
    else if (action === "play" && lastPaused) void lastPaused.play().catch(() => undefined);
  });

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

// --- Visibilité de la page (accusés de lecture) ----------------------------------
const sendVisibility = (): void => {
  ipcRenderer.send(CHANNELS.waVisibility, { state: document.visibilityState === "visible" ? "visible" : "hidden", hasFocus: document.hasFocus() });
};
document.addEventListener("visibilitychange", sendVisibility);
window.addEventListener("DOMContentLoaded", sendVisibility);

// --- Adaptateur WhatsApp (niveau 3, lecture seule) ---------------------------------
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

// --- Voile de confidentialité -------------------------------------------------------------
// Le flou est appliqué par le processus principal (CSS inséré) ; ici, on signale
// seulement le premier survol ou clic pendant le voile. Pendant un partage d'écran
// (strict), seul un clic dévoile.
let veil = { veiled: false, strict: false, blurMessages: false };
let revealSent = false;
ipcRenderer.on(CHANNELS.waVeil, (_event, state: typeof veil) => {
  veil = state;
  revealSent = false;
  if (veil.blurMessages) scheduleAdapterCheck();
});
function onPointer(kind: "hover" | "click"): void {
  if (!veil.veiled || revealSent || (veil.strict && kind !== "click")) return;
  revealSent = true;
  ipcRenderer.send(CHANNELS.waVeilReveal, { kind });
}
// Seuls les gestes réels comptent : un événement fabriqué par la page ne dévoile rien.
window.addEventListener("pointermove", (event) => event.isTrusted && onPointer("hover"), { capture: true, passive: true });
window.addEventListener("pointerdown", (event) => event.isTrusted && onPointer("click"), { capture: true, passive: true });

// Expérimental : les repères du flou des messages existent-ils encore ? Relevé une
// fois les conversations affichées ; sans correspondance, la fonction se désactive.
const MESSAGE_BLUR_SELECTORS = ['#pane-side [data-testid="cell-frame-secondary"]', "[data-pre-plain-text]"].join(",");
let adapterChecked = false;
let adapterTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleAdapterCheck(): void {
  if (adapterChecked || adapterTimer || !veil.blurMessages) return;
  adapterTimer = setTimeout(() => {
    adapterTimer = null;
    if (adapterChecked || document.querySelector(CHATS_SELECTORS) === null) return;
    adapterChecked = true;
    ipcRenderer.send(CHANNELS.waAdapterCheck, { messageBlur: document.querySelector(MESSAGE_BLUR_SELECTORS) !== null });
  }, 3000);
}
window.addEventListener("DOMContentLoaded", () => {
  new MutationObserver(() => scheduleAdapterCheck()).observe(document.documentElement, { childList: true, subtree: true });
});

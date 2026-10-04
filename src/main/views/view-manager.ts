// ViewManager (§9, §17) : une WebContentsView par compte chargé.
// Règle de visibilité : seule la vue du compte affiché est visible ; toutes les
// autres sont masquées, donc vues comme « hidden » par la page (accusés de lecture).
// backgroundThrottling reste activé : le désactiver fausserait la Page Visibility API.

import { WebContentsView, type BrowserWindow, type Rectangle, type RenderProcessGoneDetails, type Session, type WebContents } from "electron";
import type { Logger } from "../log";

export interface ViewEvents {
  titleUpdated(accountId: string, title: string): void;
  finishedLoad(accountId: string): void;
  failedLoad(accountId: string, errorCode: number, description: string): void;
  rendererGone(accountId: string, details: RenderProcessGoneDetails): void;
  audioChanged(accountId: string, audible: boolean): void;
  unresponsive(accountId: string, unresponsive: boolean): void;
  /** Une page du compte (vue ou popup) a navigué ou disparu. */
  pageGone(accountId: string, webContentsId: number): void;
}

export interface ViewManagerDeps {
  window: BrowserWindow;
  preloadPath: string;
  sessionFor(accountId: string): Session;
  /** Branche liens, menu contextuel et raccourcis sur la WebContents. */
  configure(accountId: string, webContents: WebContents): void;
  bounds(): Rectangle;
  events: ViewEvents;
  log: Logger;
  devTools: boolean;
}

export class ViewManager {
  private readonly views = new Map<string, WebContentsView>();
  private readonly accountsByWebContents = new Map<number, string>();
  private readonly popups = new Map<string, Set<BrowserWindow>>();
  private shownId: string | null = null;
  private lastBounds: Rectangle | null = null;

  constructor(private readonly deps: ViewManagerDeps) {}

  has(accountId: string): boolean {
    return this.views.has(accountId);
  }

  webContents(accountId: string): WebContents | null {
    const view = this.views.get(accountId);
    return view && !view.webContents.isDestroyed() ? view.webContents : null;
  }

  accountIdFor(webContents: WebContents): string | undefined {
    return this.accountsByWebContents.get(webContents.id);
  }

  create(accountId: string, url: string): void {
    if (this.views.has(accountId)) return;
    const { window, events } = this.deps;
    const view = new WebContentsView({
      webPreferences: {
        session: this.deps.sessionFor(accountId),
        preload: this.deps.preloadPath,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
        devTools: this.deps.devTools,
        spellcheck: true
      }
    });
    const wc = view.webContents;
    this.views.set(accountId, view);
    this.accountsByWebContents.set(wc.id, accountId);

    wc.on("page-title-updated", (_event, title) => events.titleUpdated(accountId, title));
    wc.on("did-finish-load", () => events.finishedLoad(accountId));
    wc.on("did-fail-load", (_event, errorCode, description, _url, isMainFrame) => {
      // -3 = ERR_ABORTED : navigation remplacée, pas une erreur.
      if (isMainFrame && errorCode !== -3) events.failedLoad(accountId, errorCode, description);
    });
    wc.on("render-process-gone", (_event, details) => events.rendererGone(accountId, details));
    wc.on("audio-state-changed", (event) => events.audioChanged(accountId, event.audible));
    wc.on("unresponsive", () => events.unresponsive(accountId, true));
    wc.on("responsive", () => events.unresponsive(accountId, false));
    wc.on("did-start-navigation", (details) => {
      if (details.isMainFrame && !details.isSameDocument) events.pageGone(accountId, wc.id);
    });
    this.deps.configure(accountId, wc);

    window.contentView.addChildView(view);
    view.setBounds(this.deps.bounds());
    view.setVisible(accountId === this.shownId);
    wc.loadURL(url).catch((error: unknown) => this.deps.log.warn("load-url-failed", { accountId, error: String(error) }));
    this.deps.log.info("view-created", { accountId });
  }

  /**
   * Popup de WhatsApp (même origine) : rattachée au compte pour que ses messages
   * IPC soient acceptés, ses notifications filtrées et ses pistes média comptées.
   */
  registerPopup(accountId: string, window: BrowserWindow): void {
    const wc = window.webContents;
    const id = wc.id;
    this.accountsByWebContents.set(id, accountId);
    const set = this.popups.get(accountId) ?? new Set<BrowserWindow>();
    set.add(window);
    this.popups.set(accountId, set);
    wc.on("did-start-navigation", (details) => {
      if (details.isMainFrame && !details.isSameDocument) this.deps.events.pageGone(accountId, id);
    });
    window.on("closed", () => {
      set.delete(window);
      this.accountsByWebContents.delete(id);
      this.deps.events.pageGone(accountId, id);
    });
    this.deps.log.info("popup-registered", { accountId });
  }

  closePopups(accountId: string): void {
    for (const window of this.popups.get(accountId) ?? []) if (!window.isDestroyed()) window.close();
    this.popups.delete(accountId);
  }

  isMainView(accountId: string, webContents: WebContents): boolean {
    return this.webContents(accountId) === webContents;
  }

  destroy(accountId: string): void {
    this.closePopups(accountId);
    const view = this.views.get(accountId);
    if (!view) return;
    this.views.delete(accountId);
    const wc = view.webContents;
    this.accountsByWebContents.delete(wc.id);
    if (!this.deps.window.isDestroyed()) this.deps.window.contentView.removeChildView(view);
    if (!wc.isDestroyed()) {
      // Fermeture volontaire : ce n'est pas un crash.
      wc.removeAllListeners("render-process-gone");
      wc.close();
    }
    this.deps.log.info("view-destroyed", { accountId });
  }

  /** Affiche la vue d'un compte (ou aucune) ; toutes les autres sont masquées. */
  show(accountId: string | null): void {
    const changed = accountId !== this.shownId;
    this.shownId = accountId;
    for (const [id, view] of this.views) view.setVisible(id === accountId);
    if (accountId) {
      const wc = this.webContents(accountId);
      if (wc && changed && this.deps.window.isFocused()) wc.focus();
    }
  }

  shown(): string | null {
    return this.shownId && this.views.has(this.shownId) ? this.shownId : null;
  }

  relayout(): void {
    const bounds = this.deps.bounds();
    const previous = this.lastBounds;
    if (previous && previous.x === bounds.x && previous.y === bounds.y && previous.width === bounds.width && previous.height === bounds.height) return;
    this.lastBounds = bounds;
    for (const view of this.views.values()) view.setBounds(bounds);
  }

  setMuted(accountId: string, muted: boolean): void {
    const wc = this.webContents(accountId);
    if (wc && wc.isAudioMuted() !== muted) wc.setAudioMuted(muted);
  }

  load(accountId: string, url: string): void {
    this.webContents(accountId)
      ?.loadURL(url)
      .catch((error: unknown) => this.deps.log.warn("load-url-failed", { accountId, error: String(error) }));
  }

  reload(accountId: string): void {
    this.webContents(accountId)?.reload();
  }

  processId(accountId: string): number | null {
    const wc = this.webContents(accountId);
    if (!wc) return null;
    try {
      return wc.getOSProcessId();
    } catch {
      return null;
    }
  }

  ids(): string[] {
    return [...this.views.keys()];
  }
}

// Contrôleur de l'application : assemble les modules du §45, construit l'état
// poussé vers l'UI, exécute les commandes validées et relaie les messages des pages.

import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  net,
  powerMonitor,
  screen,
  session,
  shell,
  webContents as allWebContents,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type Session,
  type WebContents
} from "electron";
import fs from "node:fs";
import path from "node:path";
import { compactSidebar, CONNECTION_BAR_HEIGHT, DEFAULT_ACCOUNT_COLOR, SIDEBAR_WIDTH, WHATSAPP_ORIGIN } from "../shared/constants";
import { locale, localeTag, resolveLocale, setLocale, t } from "../shared/i18n";
import { ISSUES_URL, PRODUCT_NAME } from "../shared/identity";
import {
  AdapterCheckPayloadSchema,
  CHANNELS,
  CommandSchema,
  EnvPayloadSchema,
  LinkStatePayloadSchema,
  MediaPayloadSchema,
  NotifyPayloadSchema,
  PlaybackPayloadSchema,
  VeilRevealPayloadSchema,
  VisibilityPayloadSchema,
  type AccountItem,
  type AccountPatch,
  type Command,
  type Notice,
  type PreferencesPatch,
  type SettingsSection,
  type SettingsState,
  type ShellState
} from "../shared/ipc";
import type { AccountConfig, ProxyServer } from "../shared/schemas";
import { matchShortcut, nextZoom, shortcutDigit } from "../shared/shortcuts";
import { AccountManager } from "./accounts/account-manager";
import { CallCoordinator } from "./calls/call-coordinator";
import { reorderAccounts } from "./core/accounts";
import { accountMenu, focusMenu, snoozeMenu, trayMenu, type MenuAction, type MenuItemModel } from "./core/menus";
import { alwaysAllow, normalizeOrigin, type PermissionSubject } from "./core/permissions";
import { PlaybackTracker, shouldMute } from "./core/playback";
import { BUNDLED_DICTIONARIES, spellcheckPlan, systemDictionary, type SpellcheckPlan } from "./core/spellcheck";
import { trayIconName } from "./core/tray";
import { attachContextMenu, isTrayAvailable, setLaunchAtLogin, setWhatsappLinkHandler } from "./desktop/desktop";
import { systemInfo, writeReport } from "./diagnostic/report";
import { DownloadManager } from "./downloads/download-manager";
import { LinkRouter, linksFromArgv } from "./links/link-router";
import type { Logger } from "./log";
import { AvatarFetcher } from "./notifications/avatar-fetcher";
import { NotificationManager, type ShownNotification } from "./notifications/notification-manager";
import { PolicyService } from "./policy/policy-service";
import { VeilService } from "./privacy/veil-service";
import { ProxyService, type ProxyTestResult } from "./proxy/proxy-service";
import { ResourceMonitor } from "./resources/resource-monitor";
import { LockService } from "./security/lock-service";
import { systemTimeZone } from "./system-timezone";
import { accountSession, applySpellcheck, chromeUserAgent, usesWaylandPortal } from "./sessions/session-factory";
import type { AppStore } from "./storage/app-store";
import { TrayManager, toElectronMenu } from "./tray/tray-manager";
import { ViewManager } from "./views/view-manager";
import { createMainWindow, createSettingsWindow, rendererBaseUrl, windowBackground, type WindowPaths } from "./windows";

export interface AppOptions {
  store: AppStore;
  log: Logger;
  paths: WindowPaths & { iconDir: string };
  targetUrl: string;
  whatsappOrigin?: string;
  test: boolean;
  startHidden: boolean;
  devTools: boolean;
  initialArgv: string[];
  /** Tests : origines autorisées pour les photos des notifications (F10). */
  avatarOrigins?: string[];
}

/** Ce que les tests de bout en bout observent (WHATHUSH_TEST=1, §39). */
export interface TestProbe {
  notifications: ShownNotification[];
  external: string[];
  downloads: Array<{ accountId: string; file: string; state: string }>;
  visibility: Record<string, string>;
  env: Record<string, unknown>;
  /** F2, F3 : fichiers ouverts ou montrés dans leur dossier. */
  opened: Array<{ action: "open" | "show"; file: string }>;
  /** F6 : inactivité simulée du système, en secondes. */
  idleSeconds: number;
}

const NETWORK_POLL_MS = 10_000;

/** Même serveur de proxy (type, hôte, port) : les identifiants enregistrés restent valables. */
function sameServer(a: ProxyServer | null, b: ProxyServer | null): boolean {
  return Boolean(a && b && a.type === b.type && a.host.toLowerCase() === b.host.toLowerCase() && a.port === b.port);
}
/** Commandes acceptées pendant le verrouillage (F6). */
const ALLOWED_WHILE_LOCKED: ReadonlySet<Command["type"]> = new Set(["unlock", "forgot-lock-code", "set-modal", "dismiss-notice"]);

export class Application {
  readonly store: AppStore;
  readonly log: Logger;
  readonly calls = new CallCoordinator();
  readonly policy: PolicyService;
  readonly accounts: AccountManager;
  readonly notifications: NotificationManager;
  readonly links: LinkRouter;
  readonly downloads: DownloadManager;
  readonly resources: ResourceMonitor;
  readonly lock: LockService;
  readonly veil: VeilService;
  readonly proxy: ProxyService;
  readonly playback = new PlaybackTracker();
  readonly probe: TestProbe | null;
  private readonly avatars: AvatarFetcher;
  private views!: ViewManager;
  private mainWindow!: BrowserWindow;
  private settingsWindow: BrowserWindow | null = null;
  private settingsRequest: SettingsState["navigationRequest"] = null;
  private tray: TrayManager | null = null;
  private trayAvailable = false;
  private readonly notices: Notice[] = [];
  private quitting = false;
  private pushScheduled = false;
  private traySignature = "";
  private zoomToast: ShellState["zoomToast"] = null;
  private zoomSequence = 0;
  private sharingScreen = false;
  private readonly proxyTests: SettingsState["proxyTests"] = {};
  private readonly whatsappOrigin: string;
  private readonly userAgent = chromeUserAgent();

  constructor(private readonly options: AppOptions) {
    this.store = options.store;
    this.log = options.log;
    this.whatsappOrigin = options.whatsappOrigin ?? WHATSAPP_ORIGIN;
    this.probe = options.test ? { notifications: [], external: [], downloads: [], visibility: {}, env: {}, opened: [], idleSeconds: 0 } : null;
    this.applyLocale();
    for (const { key, params, ...notice } of this.store.notices) this.notices.push({ ...notice, message: t(key, params) });

    this.policy = new PolicyService(this.store, () => new Date(), systemTimeZone);
    this.lock = new LockService({
      store: this.store,
      log: this.log,
      watchSession: !options.test,
      ...(this.probe ? { idleSeconds: () => this.probe?.idleSeconds ?? 0 } : {})
    });
    this.accounts = new AccountManager({
      store: this.store,
      views: () => this.views,
      calls: this.calls,
      sessionFor: (id) => this.sessionFor(id),
      targetUrl: options.targetUrl,
      log: this.log,
      notify: (notice) => this.addNotice(notice),
      pageGone: (_accountId, webContentsId) => {
        this.calls.resetPage(webContentsId);
        this.notifications.closeForPage(webContentsId);
        if (this.playback.pageGone(webContentsId)) this.pushState();
      },
      accountGone: (accountId) => {
        this.calls.resetAccount(accountId);
        this.notifications.closeForAccount(accountId);
        if (this.playback.accountGone(accountId)) this.pushState();
      },
      linked: (accountId) => this.accountLinked(accountId)
    });
    this.avatars = new AvatarFetcher({ sessionFor: (id) => this.sessionFor(id), log: this.log, extraOrigins: options.avatarOrigins ?? [] });
    this.notifications = new NotificationManager({
      log: this.log,
      account: (id) => this.accounts.account(id),
      policy: (id) => this.policy.policy(id),
      accountsInCall: () => this.calls.accountsInCall(),
      open: (id, webContentsId, notificationId) => this.openFromNotification(id, webContentsId, notificationId),
      locked: () => this.lock.isLocked(),
      fetchAvatar: (id, url) => this.avatars.fetch(id, url),
      ...(this.probe ? { sink: (notification: ShownNotification) => this.probe?.notifications.push(notification) } : {})
    });
    this.links = new LinkRouter({
      whatsappOrigin: this.whatsappOrigin,
      log: this.log,
      accountIds: () => this.accounts.accounts().map((account) => account.id),
      openInAccount: (id, url) => {
        this.accounts.openUrl(id, url);
        this.showMainWindow();
      },
      popupPreload: path.join(options.paths.preloadDir, "whatsapp.js"),
      registerPopup: (accountId, window) => {
        this.views.registerPopup(accountId, window);
        this.configurePage(accountId, window.webContents);
      },
      askAccount: () => {
        this.showMainWindow();
        this.pushState();
      },
      locked: () => this.lock.isLocked(),
      ...(this.probe ? { openExternal: (url: string) => this.probe?.external.push(url) } : {})
    });
    this.downloads = new DownloadManager({
      log: this.log,
      store: this.store,
      askLocation: () => this.store.get("preferences").askDownloadLocation,
      retentionDays: () => this.store.get("preferences").downloadsHistoryDays,
      accountLabel: (id) => this.accounts.account(id)?.label ?? "",
      locked: () => this.lock.isLocked(),
      ...(this.probe
        ? {
            sink: (event: { accountId: string; file: string; state: string }) => this.probe?.downloads.push(event),
            opened: (action: "open" | "show", file: string) => this.probe?.opened.push({ action, file })
          }
        : {})
    });
    this.resources = new ResourceMonitor(this.accounts, () => this.views, this.calls, (notice) => this.addNotice(notice));
    this.veil = new VeilService({ log: this.log, preferences: () => this.store.get("preferences").privacyVeil, pages: () => this.views?.allPages() ?? [] });
    this.proxy = new ProxyService({
      store: this.store,
      log: this.log,
      sessionFor: (id) => this.sessionFor(id),
      account: (id) => this.accounts.account(id),
      accounts: () => this.accounts.accounts(),
      pages: (id) => this.views?.pages(id) ?? [],
      accountForPage: (contents) => this.views?.accountIdFor(contents),
      notifyAuthProblem: (scope, kind) => {
        const label = scope === "global" ? t("proxy.scopeGlobal") : (this.accounts.account(scope)?.label ?? t("common.anAccount"));
        this.addNotice({ id: `proxy-${kind}-${scope}`, level: "warning", message: t(kind === "failed" ? "notice.proxyAuthFailed" : "notice.proxyCredentialsNeeded", { scope: label }) });
      },
      includeLoopback: options.test
    });
  }

  // --- Démarrage ---------------------------------------------------------------------

  async start(): Promise<void> {
    const preferences = this.store.get("preferences");
    nativeTheme.themeSource = preferences.theme;
    this.trayAvailable = process.env.WHATHUSH_TRAY === "0" ? false : await isTrayAvailable(this.log);
    this.log.info("start", { trayAvailable: this.trayAvailable, test: this.options.test });

    const hidden = this.options.startHidden && this.trayAvailable;
    this.mainWindow = createMainWindow(this.options.paths, { devTools: this.options.devTools, show: !hidden });
    if (this.options.startHidden && !this.trayAvailable) this.mainWindow.once("ready-to-show", () => this.mainWindow.minimize());

    this.views = new ViewManager({
      window: this.mainWindow,
      preloadPath: path.join(this.options.paths.preloadDir, "whatsapp.js"),
      sessionFor: (id) => this.sessionFor(id),
      configure: (id, webContents) => this.configurePage(id, webContents),
      prepare: (id) => this.proxy.apply(id),
      zoomFor: (id) => this.accounts.account(id)?.zoomPercent ?? 100,
      bounds: () => this.viewBounds(),
      events: this.accounts,
      log: this.log,
      devTools: this.options.devTools
    });

    this.wireWindow();
    this.registerIpc();
    this.wireSystem();

    for (const source of [this.accounts, this.policy, this.calls, this.resources, this.downloads, this.veil, this.lock] as const) {
      source.on("changed", () => this.pushState());
    }
    this.policy.on("changed", () => this.applyAudio());
    this.calls.on("changed", () => {
      this.applyAudio();
      // F7 : voile automatique au début d'un partage d'écran.
      const sharing = this.calls.sharingScreen();
      if (sharing !== this.sharingScreen) {
        this.sharingScreen = sharing;
        this.veil.screenShareChanged(sharing);
      }
    });
    this.accounts.on("changed", () => this.applyAudio());
    this.accounts.on("changed", () => this.views.relayout());
    this.store.on("change", (key) => {
      if (key === "preferences") this.views.relayout();
      if (key === "accounts" || key === "schedules" || key === "focus") this.policy.recompute();
      this.pushState();
    });
    // F6 : verrouillé, aucune page WhatsApp n'est affichée (vues et popups), les paramètres
    // sont fermés et le clavier va à l'écran de verrouillage, jamais à une vue masquée.
    this.lock.on("locked", () => {
      this.accounts.setLocked(true);
      this.views.setPopupsHidden(true);
      if (this.settingsWindow && !this.settingsWindow.isDestroyed()) this.settingsWindow.close();
      if (!this.mainWindow.isDestroyed()) this.mainWindow.webContents.focus();
    });
    this.lock.on("unlocked", () => {
      this.accounts.setLocked(false);
      this.views.setPopupsHidden(false);
    });

    if (this.trayAvailable && process.env.WHATHUSH_TRAY !== "0") {
      this.tray = new TrayManager(this.options.paths.iconDir, PRODUCT_NAME);
      this.tray.create();
    }

    this.downloads.start();
    // Avant les comptes : verrouillé au démarrage, aucune vue ne s'affiche, même un instant.
    this.lock.start();
    this.policy.start();
    this.accounts.start();
    this.resources.start();
    this.pushState();

    for (const link of linksFromArgv(this.options.initialArgv)) this.links.handleExternal(link);
    void this.checkForUpdates();
  }

  private sessionFor(id: string): Session {
    return accountSession(id, {
      whatsappOrigin: this.whatsappOrigin,
      userAgent: this.userAgent,
      log: this.log,
      onDownload: (accountId, item) => this.downloads.handle(accountId, item),
      spellcheck: () => this.spellcheckPlan(),
      chooseScreen: (accountId, sources) => this.chooseScreen(accountId, sources),
      permissions: (accountId) => this.accounts.account(accountId)?.permissions ?? { microphone: "deny", camera: "deny", location: "deny", screenShare: "deny" },
      askPermission: (accountId, subject) => this.askPermission(accountId, subject)
    });
  }

  /** F5 : langues du correcteur selon le mode choisi. */
  private spellcheckPlan(): SpellcheckPlan {
    const preferences = this.store.get("preferences");
    return spellcheckPlan(preferences.spellcheckMode, preferences.spellcheckLanguages, app.getPreferredSystemLanguages(), session.defaultSession.availableSpellCheckerLanguages);
  }

  /** F12 : langue choisie, sinon celle du système, sinon l'anglais. */
  private applyLocale(): void {
    const { locale: next, tag } = resolveLocale(this.store.get("preferences").language, app.getPreferredSystemLanguages());
    setLocale(next, tag);
    this.log.info("locale", { locale: next, tag });
  }

  /** §20 : sous X11, confirmation et choix de l'écran (sous Wayland, le portail l'a fait). */
  private async chooseScreen(accountId: string, sources: Electron.DesktopCapturerSource[]): Promise<Electron.DesktopCapturerSource | null> {
    const ozone = app.commandLine.getSwitchValue("ozone-platform");
    if (usesWaylandPortal(ozone) || this.options.test) return sources[0] ?? null;
    if (sources.length === 0) return null;
    const label = this.accounts.account(accountId)?.label ?? t("common.anAccount");
    const { response } = await dialog.showMessageBox(this.mainWindow, {
      type: "question",
      title: t("dialog.screenShareTitle"),
      message: t("dialog.screenShareMessage", { label }),
      detail: t("dialog.screenShareDetail"),
      buttons: [t("common.cancel"), ...sources.map((source, index) => source.name || t("dialog.screenName", { n: index + 1 }))],
      defaultId: 0,
      cancelId: 0
    });
    return response === 0 ? null : (sources[response - 1] ?? null);
  }

  /** F8 : « Demander » ; « Toujours pour ce compte » enregistre « Autoriser ». */
  private async askPermission(accountId: string, subject: PermissionSubject): Promise<"deny" | "once" | "always"> {
    const account = this.accounts.account(accountId);
    if (!account || this.lock.isLocked()) return "deny";
    const { response } = await dialog.showMessageBox(this.mainWindow, {
      type: "question",
      title: t("dialog.permissionTitle"),
      message: t("dialog.permissionMessage", { label: account.label, what: t(`permission.what.${subject}`) }),
      buttons: [t("dialog.permissionDeny"), t("dialog.permissionOnce"), t("dialog.permissionAlways")],
      defaultId: 0,
      cancelId: 0
    });
    if (response === 2) {
      const current = this.accounts.account(accountId);
      if (current) this.updateAccount(accountId, { permissions: alwaysAllow(current.permissions, subject) });
      return "always";
    }
    return response === 1 ? "once" : "deny";
  }

  /** Vue ou popup d'un compte : liens, menu, raccourcis, zoom, voile, WebRTC. */
  private configurePage(id: string, webContents: WebContents): void {
    this.links.attach(id, webContents);
    attachContextMenu(webContents, {
      devTools: this.options.devTools,
      openLink: (url) => this.links.handleExternal(url)
    });
    webContents.on("before-input-event", (event, input) => this.handleShortcut(event, input, webContents));
    // Ctrl + molette : Electron ne zoome pas de lui-même, il le signale (F1).
    webContents.on("zoom-changed", (_event, direction) => this.zoom(direction, id));
    webContents.on("did-finish-load", () => this.veil.pageLoaded(webContents));
    webContents.once("destroyed", () => this.veil.pageGone(webContents));
    this.proxy.applyWebRtc(webContents);
  }

  private interfaceScale(): number {
    return this.store.get("preferences").interfaceScale / 100;
  }

  private viewBounds(): Electron.Rectangle {
    const [width = 0, height = 0] = this.mainWindow.getContentSize();
    // F1 : la coque est zoomée ; ses dimensions CSS sont multipliées par l'échelle.
    const scale = this.interfaceScale();
    const compact = compactSidebar(width / scale, this.store.get("preferences").sidebarCollapsed);
    const sidebar = Math.round((compact ? SIDEBAR_WIDTH.collapsed : SIDEBAR_WIDTH.expanded) * scale);
    const active = this.accounts.active();
    const top = active && this.accounts.runtime(active)?.lifecycle === "offline" ? Math.round(CONNECTION_BAR_HEIGHT * scale) : 0;
    return { x: sidebar, y: top, width: Math.max(0, width - sidebar), height: Math.max(0, height - top) };
  }

  /** F1 : échelle de la coque et des paramètres (pas des vues WhatsApp). */
  private applyInterfaceScale(): void {
    const factor = this.interfaceScale();
    for (const contents of [this.mainWindow.webContents, this.settingsWebContents()]) {
      if (contents && !contents.isDestroyed() && Math.abs(contents.getZoomFactor() - factor) > 0.001) contents.setZoomFactor(factor);
    }
    this.views.relayout();
  }

  private wireWindow(): void {
    const window = this.mainWindow;
    for (const event of ["resize", "maximize", "unmaximize", "enter-full-screen", "leave-full-screen"] as const) {
      window.on(event as "resize", () => this.views.relayout());
    }
    window.on("show", () => this.accounts.refreshVisibility());
    // F6 et F7 : fenêtre masquée ou réduite, fenêtre qui perd le focus.
    window.on("hide", () => this.lock.trigger("hide"));
    window.on("minimize", () => this.lock.trigger("hide"));
    window.on("blur", () => this.veil.windowBlurred());
    // F6 : la fenêtre rendrait le clavier à la dernière vue qui l'avait (masquée) ;
    // verrouillé, il va toujours au champ du code.
    window.on("focus", () => {
      if (this.lock.isLocked()) window.webContents.focus();
    });
    window.on("close", (event) => {
      if (this.quitting) return;
      if (this.store.get("preferences").closeToTray && this.trayAvailable) {
        event.preventDefault();
        window.hide();
      } else {
        this.quitting = true;
        app.quit();
      }
    });
    window.webContents.on("before-input-event", (event, input) => this.handleShortcut(event, input, window.webContents));
    window.webContents.on("did-finish-load", () => {
      this.applyInterfaceScale();
      this.pushState();
    });
    // §32 : un plantage de la coque la recharge, sans toucher aux vues WhatsApp.
    window.webContents.on("render-process-gone", (_event, details) => {
      this.log.error("shell-renderer-gone", { reason: details.reason });
      this.accounts.setModal(false);
      window.webContents.reload();
    });
  }

  private wireSystem(): void {
    nativeTheme.on("updated", () => {
      if (!this.mainWindow.isDestroyed()) this.mainWindow.setBackgroundColor(windowBackground());
      if (this.settingsWindow && !this.settingsWindow.isDestroyed()) this.settingsWindow.setBackgroundColor(windowBackground(true));
    });
    app.on("before-quit", () => {
      this.quitting = true;
      this.accounts.flush();
      this.lock.stop();
      this.proxy.stop();
    });
    // F9 : identifiants d'un proxy HTTP(S) ; Chromium les redemande s'ils sont refusés.
    app.on("login", (event, contents, details, authInfo, callback) => {
      if (!authInfo.isProxy) return;
      const credentials = this.proxy.handleLogin(contents ?? null, details.url, authInfo);
      event.preventDefault();
      if (credentials) callback(credentials.username, credentials.password);
      else callback();
    });
    // §34 : au réveil, recalculer les politiques et vérifier le réseau.
    powerMonitor.on("resume", () => {
      this.log.info("system-resume");
      this.policy.recompute();
      // Un seul chemin : en ligne, on recharge les comptes hors ligne une fois ;
      // hors ligne, on marque les comptes connectés comme hors ligne.
      if (net.isOnline()) this.accounts.resumed();
      else this.accounts.networkChanged(false);
    });
    let online = net.isOnline();
    setInterval(() => {
      const now = net.isOnline();
      if (now !== online) {
        online = now;
        this.log.info(now ? "network-online" : "network-offline");
        this.accounts.networkChanged(now);
      }
    }, NETWORK_POLL_MS);
  }

  // --- Raccourcis (§9, F1) ---------------------------------------------------------------

  private handleShortcut(event: Electron.Event, input: Electron.Input, contents: WebContents): void {
    if (input.type !== "keyDown") return;
    const shortcut = matchShortcut(input);
    // F6 : verrouillé, aucun raccourci de l'application, ni outils de développement (le
    // champ du code reste utilisable).
    if (this.lock.isLocked()) {
      if (shortcut || input.key === "F12") event.preventDefault();
      return;
    }
    if (input.key === "F12" && this.options.devTools && !input.control && !input.alt && !input.shift) {
      event.preventDefault();
      const id = this.accounts.active();
      const wc = id ? this.views.webContents(id) : null;
      if (wc) wc.isDevToolsOpened() ? wc.closeDevTools() : wc.openDevTools({ mode: "detach" });
      return;
    }
    if (!shortcut) return;
    const isView = contents !== this.mainWindow.webContents;
    switch (shortcut.id) {
      case "switch-account":
        event.preventDefault();
        this.accounts.switchToShortcut(shortcutDigit(input) ?? 0);
        return;
      case "next-account":
      case "previous-account":
        event.preventDefault();
        this.accounts.cycle(shortcut.id === "next-account" ? 1 : -1);
        return;
      case "settings":
        event.preventDefault();
        this.openSettings();
        return;
      case "focus-toggle": {
        event.preventDefault();
        const active = this.accounts.active();
        const view = active ? this.views.webContents(active) : null;
        if (!isView && view && this.views.shown()) view.focus();
        else {
          this.mainWindow.webContents.focus();
          this.mainWindow.webContents.send(CHANNELS.shellRequestFocusAccounts);
        }
        return;
      }
      case "zoom-in":
      case "zoom-out":
      case "zoom-reset":
        event.preventDefault();
        this.zoom(shortcut.id === "zoom-in" ? "in" : shortcut.id === "zoom-out" ? "out" : "reset");
        return;
      case "shortcuts":
        event.preventDefault();
        this.mainWindow.webContents.focus();
        this.mainWindow.webContents.send(CHANNELS.shellRequestShortcuts);
        return;
      case "veil":
        event.preventDefault();
        this.veil.toggle();
        return;
      case "lock":
        event.preventDefault();
        this.lockNow();
        return;
      case "paste-plain":
        // F13 : Chromium colle déjà en texte brut avec Ctrl+Maj+V dans un champ ; la
        // table ne sert ici qu'à la feuille des raccourcis.
        return;
    }
  }

  /** F1 : zoom par compte, mémorisé, affiché brièvement dans la barre latérale. */
  private zoom(action: "in" | "out" | "reset", accountId: string | null = this.accounts.active()): void {
    if (!accountId) return;
    const account = this.accounts.account(accountId);
    if (!account) return;
    const percent = nextZoom(account.zoomPercent, action);
    if (percent !== account.zoomPercent) this.updateAccount(accountId, { zoomPercent: percent });
    this.views.setZoom(accountId, percent);
    this.zoomToast = { accountId, percent, sequence: ++this.zoomSequence };
    this.pushState();
  }

  /** F6 : « Verrouiller maintenant » ; sans code, ouvre la section Sécurité. */
  private lockNow(): void {
    if (this.lock.isEnabled()) this.lock.trigger("manual");
    else this.openSettings(undefined, "security");
  }

  // --- Fenêtres -------------------------------------------------------------------------------

  showMainWindow(): void {
    const window = this.mainWindow;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  }

  openSettings(accountId?: string, section?: SettingsSection): void {
    if (this.lock.isLocked()) return;
    if (section || (accountId && this.accounts.account(accountId))) {
      this.settingsRequest = { section: section ?? "accounts", ...(accountId ? { accountId } : {}), sequence: (this.settingsRequest?.sequence ?? 0) + 1 };
    }
    if (this.settingsWindow && !this.settingsWindow.isDestroyed()) {
      if (this.settingsWindow.isMinimized()) this.settingsWindow.restore();
      this.settingsWindow.focus();
      this.pushState();
      return;
    }
    const settings = createSettingsWindow(this.options.paths, null, { devTools: this.options.devTools });
    this.settingsWindow = settings;
    settings.webContents.on("did-finish-load", () => {
      this.applyInterfaceScale();
      this.pushState();
    });
    settings.webContents.on("before-input-event", (event, input) => {
      // Verrouiller depuis les paramètres aussi ; les autres raccourcis restent à la fenêtre principale.
      if (input.type === "keyDown" && matchShortcut(input)?.id === "lock") {
        event.preventDefault();
        this.lockNow();
      }
    });
    settings.webContents.on("render-process-gone", () => settings.webContents.reload());
    this.settingsWindow.on("closed", () => {
      this.settingsWindow = null;
    });
  }

  settingsWebContents(): WebContents | null {
    return this.settingsWindow && !this.settingsWindow.isDestroyed() ? this.settingsWindow.webContents : null;
  }

  mainWebContents(): WebContents {
    return this.mainWindow.webContents;
  }

  private openFromNotification(id: string, webContentsId: number, notificationId: number): void {
    this.accounts.switchTo(id);
    this.showMainWindow();
    // Verrouillé : la fenêtre s'ouvre sur l'écran de verrouillage, la conversation attendra.
    if (this.lock.isLocked()) return;
    // La page d'origine (vue ou popup) reçoit le clic et ouvre la conversation.
    const origin = allWebContents.fromId(webContentsId);
    if (origin && !origin.isDestroyed() && this.views.accountIdFor(origin) === id) origin.send(CHANNELS.waNotificationClick, notificationId);
  }

  /** F11 : à la première connexion d'un compte, l'aide « thème de WhatsApp », une fois. */
  private accountLinked(accountId: string): void {
    const account = this.accounts.account(accountId);
    if (!account || account.themeHintShown) return;
    this.store.update("accounts", (file) => ({ ...file, accounts: file.accounts.map((candidate) => (candidate.id === accountId ? { ...candidate, themeHintShown: true } : candidate)) }));
    // Une seule information à la fois, même si plusieurs comptes se connectent ensemble.
    this.addNotice({ id: "theme-hint", level: "info", sticky: true, message: t("notice.themeHint", { label: account.label }) });
  }

  // --- Notices --------------------------------------------------------------------------------

  private addNotice(notice: Notice): void {
    const index = this.notices.findIndex((candidate) => candidate.id === notice.id);
    if (index >= 0) this.notices.splice(index, 1);
    this.notices.push(notice);
    // Les informations s'effacent seules ; avertissements, erreurs et suggestions attendent l'utilisateur.
    if (notice.level === "info" && !notice.sticky) {
      setTimeout(() => {
        const position = this.notices.indexOf(notice);
        if (position >= 0) {
          this.notices.splice(position, 1);
          this.pushState();
        }
      }, 8000);
    }
    this.pushState();
  }

  // --- État ---------------------------------------------------------------------------------------

  shellState(): ShellState {
    const preferences = this.store.get("preferences");
    const focus = this.store.get("focus");
    const lock = this.lock.state();
    const now = Date.now();
    const accounts: AccountItem[] = this.accounts.accounts().map((account, index) => this.accountItem(account, index, now));
    const totalUnread = accounts.reduce((sum, item) => {
      const account = this.accounts.account(item.id);
      const policy = this.policy.policy(item.id);
      return account?.notifications.includeInTotal && policy?.badge ? sum + (item.unread ?? 0) : sum;
    }, 0);
    const media = accounts.filter((item) => item.playback).sort((a, b) => Number(b.playback?.playing) - Number(a.playback?.playing))[0];
    const state: ShellState = {
      productName: PRODUCT_NAME,
      language: locale(),
      localeTag: localeTag(),
      accounts,
      activeId: this.accounts.active(),
      totalUnread,
      focus: {
        profiles: focus.profiles.map((profile) => ({ id: profile.id, name: profile.name })),
        activeProfileId: focus.active?.profileId ?? null,
        until: focus.active?.until ?? null
      },
      sidebarCollapsed: preferences.sidebarCollapsed,
      onboardingDone: preferences.onboardingDone,
      pendingLink: this.links.pendingLink(),
      notices: [...this.notices],
      trayAvailable: this.trayAvailable,
      lock,
      veiled: this.veil.isVeiled(),
      nowPlaying: media?.playback ? { accountId: media.id, label: media.label, ...media.playback } : null,
      downloads: this.downloads.summary(),
      zoomToast: this.zoomToast
    };
    // F6 : verrouillé, l'interface ne reçoit ni les comptes ni les informations.
    if (lock.locked) return { ...state, accounts: [], activeId: null, focus: { profiles: [], activeProfileId: null, until: null }, pendingLink: null, notices: [], nowPlaying: null, zoomToast: null };
    return state;
  }

  private accountItem(account: AccountConfig, index: number, now: number): AccountItem {
    const runtime = this.accounts.runtime(account.id);
    const policy = this.policy.policy(account.id);
    const playback = this.playback.forAccount(account.id, now);
    return {
      id: account.id,
      label: account.label,
      color: account.color ?? DEFAULT_ACCOUNT_COLOR,
      icon: account.icon ?? null,
      shortcut: index < 9 ? index + 1 : null,
      lifecycle: account.sleeping ? "sleeping" : (runtime?.lifecycle ?? "loading"),
      active: account.id === this.accounts.active(),
      policy: {
        mode: policy?.mode ?? "normal",
        source: policy?.source ?? "default",
        until: policy?.until ? policy.until.toISOString() : null
      },
      unread: policy?.badge ? (runtime?.unread ?? null) : null,
      inCall: this.calls.inCall(account.id),
      audible: runtime?.audible ?? false,
      memoryMB: this.resources.memoryMB(account.id),
      zoomPercent: account.zoomPercent,
      playback: playback ? { playing: playback.playing, kind: playback.kind, title: playback.title } : null
    };
  }

  settingsState(): SettingsState {
    const memory: Record<string, number | null> = {};
    for (const account of this.accounts.accounts()) memory[account.id] = this.resources.memoryMB(account.id);
    const lock = this.store.get("security").lock;
    const proxyAccounts: Record<string, boolean> = {};
    for (const account of this.accounts.accounts()) proxyAccounts[account.id] = this.proxy.hasCredentials(account.id);
    return {
      productName: PRODUCT_NAME,
      language: locale(),
      localeTag: localeTag(),
      systemLanguages: app.getPreferredSystemLanguages(),
      disclaimer: t("common.disclaimer"),
      preferences: this.store.get("preferences"),
      accounts: this.accounts.accounts(),
      schedules: this.store.get("schedules").schedules,
      focus: this.store.get("focus"),
      trayAvailable: this.trayAvailable,
      spellcheck: {
        available: session.defaultSession.availableSpellCheckerLanguages,
        bundled: Object.keys(BUNDLED_DICTIONARIES),
        systemDictionary: systemDictionary(app.getPreferredSystemLanguages()),
        active: this.spellcheckPlan().languages
      },
      versions: { app: app.getVersion(), electron: process.versions.electron, chromium: process.versions.chrome, node: process.versions.node },
      paths: { userData: app.getPath("userData"), logs: this.log.dir },
      memory,
      navigationRequest: this.settingsRequest,
      notices: [...this.notices],
      downloads: this.downloads.list().map((entry) => ({
        id: entry.id,
        accountId: entry.accountId,
        accountLabel: this.accounts.account(entry.accountId)?.label ?? "—",
        fileName: entry.fileName,
        bytes: entry.bytes,
        state: entry.state,
        startedAt: entry.startedAt,
        finishedAt: entry.finishedAt ?? null,
        missing: entry.missing,
        progress: entry.progress
      })),
      security: {
        lock: { enabled: lock.enabled, onStart: lock.onStart, onHide: lock.onHide, idleMinutes: lock.idleMinutes, onScreenLock: lock.onScreenLock },
        secureStorage: this.proxy.secureStorage(),
        proxyCredentials: { global: this.proxy.hasCredentials("global"), accounts: proxyAccounts }
      },
      proxyTests: { ...this.proxyTests }
    };
  }

  pushState(): void {
    if (this.pushScheduled) return;
    this.pushScheduled = true;
    setTimeout(() => {
      this.pushScheduled = false;
      if (this.mainWindow.isDestroyed()) return;
      const state = this.shellState();
      this.mainWindow.webContents.send(CHANNELS.shellState, state);
      if (!this.lock.isLocked()) this.settingsWebContents()?.send(CHANNELS.settingsState, this.settingsState());
      this.updateBadge(state);
      // §21 : le menu du tray n'est reconstruit que si son contenu change (un menu
      // ouvert se refermerait sinon sur certains bureaux).
      const menu = trayMenu(state, new Date());
      const icon = trayIconName(state.lock.locked ? 0 : state.totalUnread, this.store.get("preferences").trayCountStyle);
      const signature = JSON.stringify(menu) + state.totalUnread + icon;
      if (this.tray && signature !== this.traySignature) {
        this.traySignature = signature;
        this.tray.update(menu, state.lock.locked ? 0 : state.totalUnread, icon, (action) => this.dispatchMenuAction(action));
      }
    }, 30);
  }

  private updateBadge(state: ShellState): void {
    const total = state.lock.locked ? 0 : state.totalUnread;
    app.setBadgeCount(total);
    this.mainWindow.setTitle(total > 0 ? `(${total}) ${PRODUCT_NAME}` : PRODUCT_NAME);
  }

  /** §12, F14 : son coupé pour un compte en Snooze caché, sauf appel ou lecture lancée par l'utilisateur. */
  private applyAudio(): void {
    const shown = this.views.shown();
    const now = Date.now();
    for (const id of this.views.ids()) {
      const policy = this.policy.policy(id);
      const playback = this.playback.forAccount(id, now);
      this.views.setMuted(
        id,
        shouldMute({ muteWhenHidden: Boolean(policy?.muteAudioWhenHidden), shown: id === shown, inCall: this.calls.inCall(id), userPlayback: Boolean(playback?.playing && playback.userStarted) })
      );
    }
  }

  // --- Commandes --------------------------------------------------------------------------------

  async handleCommand(command: Command): Promise<void> {
    this.log.debug("command", { type: command.type });
    if (this.lock.isLocked() && !ALLOWED_WHILE_LOCKED.has(command.type)) {
      this.log.warn("command-refused-locked", { type: command.type });
      return;
    }
    switch (command.type) {
      case "add-account":
        this.accounts.add({ label: command.label, ...(command.color ? { color: command.color } : {}), ...(command.icon ? { icon: command.icon } : {}) });
        if (!this.store.get("preferences").onboardingDone) this.setPreferences({ onboardingDone: true });
        return;
      case "switch-account":
        this.accounts.switchTo(command.id);
        return;
      case "sleep-account":
        if (!this.accounts.sleep(command.id)) this.addNotice({ id: `sleep-${command.id}`, level: "info", message: t("notice.sleepRefusedInCall") });
        return;
      case "wake-account":
        this.accounts.wake(command.id);
        return;
      case "reload-account":
        this.accounts.reload(command.id);
        return;
      case "remove-account":
        await this.removeAccount(command.id);
        return;
      case "request-remove-account":
        await this.confirmRemove(command.id, this.settingsWindow ?? this.mainWindow);
        return;
      case "snooze":
        this.policy.snooze(command.id, command.preset);
        return;
      case "resume":
        this.policy.resume(command.id);
        return;
      case "account-menu": {
        const item = this.shellState().accounts.find((account) => account.id === command.id);
        if (item) this.popup(accountMenu(item, { includeRemove: true }), command.x, command.y);
        return;
      }
      case "snooze-menu":
        if (this.accounts.account(command.id)) this.popup(snoozeMenu(command.id), command.x, command.y);
        return;
      case "focus-menu":
        this.popup(focusMenu(this.shellState()), command.x, command.y);
        return;
      case "set-modal":
        this.accounts.setModal(command.open);
        if (!command.open) this.mainWindow.webContents.focus();
        return;
      case "resolve-link":
        this.links.resolve(command.accountId);
        this.pushState();
        return;
      case "reorder-accounts":
        this.store.update("accounts", (file) => reorderAccounts(file, command.ids));
        return;
      case "dismiss-notice": {
        const index = this.notices.findIndex((notice) => notice.id === command.id);
        if (index >= 0) this.notices.splice(index, 1);
        this.pushState();
        return;
      }
      case "open-settings":
        this.openSettings(command.accountId, command.section);
        return;
      case "update-account":
        this.updateAccount(command.id, command.patch);
        return;
      case "clear-cache": {
        // §27 : jamais IndexedDB, localStorage ni cookies (ce serait une déconnexion).
        const ses = this.sessionFor(command.id);
        await ses.clearCache();
        await ses.clearStorageData({ storages: ["cachestorage", "shadercache"] });
        this.addNotice({ id: `cache-${command.id}`, level: "info", message: t("notice.cacheCleared") });
        return;
      }
      case "set-preferences":
        this.setPreferences(command.patch);
        return;
      case "save-schedule":
        this.store.update("schedules", (file) => ({
          ...file,
          schedules: file.schedules.some((schedule) => schedule.id === command.schedule.id)
            ? file.schedules.map((schedule) => (schedule.id === command.schedule.id ? command.schedule : schedule))
            : [...file.schedules, command.schedule]
        }));
        return;
      case "delete-schedule":
        this.store.update("accounts", (file) => ({
          ...file,
          accounts: file.accounts.map((account) => {
            if (account.scheduleId !== command.id) return account;
            const { scheduleId: _removed, ...rest } = account;
            return rest;
          })
        }));
        this.store.update("schedules", (file) => ({ ...file, schedules: file.schedules.filter((schedule) => schedule.id !== command.id) }));
        return;
      case "request-delete-schedule": {
        const schedule = this.store.get("schedules").schedules.find((item) => item.id === command.id);
        if (schedule && await this.confirmSettingsDelete(t("dialog.deleteScheduleTitle"), schedule.name, t("dialog.deleteScheduleDetail"))) {
          await this.handleCommand({ type: "delete-schedule", id: command.id });
        }
        return;
      }
      case "save-focus-profile":
        this.store.update("focus", (file) => ({
          ...file,
          profiles: file.profiles.some((profile) => profile.id === command.profile.id)
            ? file.profiles.map((profile) => (profile.id === command.profile.id ? command.profile : profile))
            : [...file.profiles, command.profile]
        }));
        return;
      case "delete-focus-profile":
        this.store.update("focus", (file) => ({
          ...file,
          profiles: file.profiles.filter((profile) => profile.id !== command.id),
          active: file.active?.profileId === command.id ? null : file.active
        }));
        return;
      case "request-delete-focus-profile": {
        const profile = this.store.get("focus").profiles.find((item) => item.id === command.id);
        if (profile && await this.confirmSettingsDelete(t("dialog.deleteFocusTitle"), profile.name, t("dialog.deleteFocusDetail"))) {
          await this.handleCommand({ type: "delete-focus-profile", id: command.id });
        }
        return;
      }
      case "activate-focus":
        this.policy.activateFocus(command.profileId, command.minutes);
        return;
      case "open-logs":
        void shell.openPath(this.log.dir);
        return;
      case "zoom":
        this.zoom(command.action, command.id ?? this.accounts.active());
        return;
      case "media-control":
        this.mediaControl(command.id, command.action);
        return;
      case "download-open":
        await this.downloads.open(command.id);
        return;
      case "download-show":
        this.downloads.show(command.id);
        return;
      case "download-remove":
        this.downloads.remove(command.id);
        return;
      case "downloads-clear":
        this.downloads.clear();
        return;
      case "create-diagnostic-report":
        this.createDiagnosticReport();
        return;
      case "report-problem":
        this.reportProblem();
        return;
      case "lock-now":
        this.lockNow();
        return;
      case "unlock":
        await this.lock.unlock(command.code);
        return;
      case "forgot-lock-code":
        await this.forgotLockCode();
        return;
      case "set-lock-code": {
        const result = await this.lock.setCode(command.current, command.next);
        const wasEnabled = command.current !== null;
        if (result === "ok") this.addNotice({ id: "lock", level: "info", message: t(wasEnabled ? "notice.lockCodeChanged" : "notice.lockEnabled") });
        else if (result === "wrong-current") this.addNotice({ id: "lock", level: "error", message: t("notice.lockWrongCurrent") });
        else this.addNotice({ id: "lock", level: "error", message: t("lock.tooShort") });
        return;
      }
      case "disable-lock": {
        const result = await this.lock.disable(command.current);
        this.addNotice(result === "ok" ? { id: "lock", level: "info", message: t("notice.lockDisabled") } : { id: "lock", level: "error", message: t("notice.lockWrongCurrent") });
        return;
      }
      case "set-lock-options":
        this.lock.setOptions(command.options);
        return;
      case "toggle-veil":
        this.veil.toggle();
        return;
      case "set-proxy-credentials": {
        if (command.scope !== "global" && !this.accounts.account(command.scope)) return;
        const result = this.proxy.setCredentials(command.scope, { username: command.username, password: command.password });
        this.addNotice({ id: `proxy-credentials-${command.scope}`, level: "info", message: t(result === "saved" ? "proxy.credentialsSaved" : "proxy.credentialsMemory") });
        return;
      }
      case "clear-proxy-credentials":
        this.proxy.clearCredentials(command.scope);
        this.pushState();
        return;
      case "test-proxy":
        await this.testProxy(command.scope);
        return;
    }
  }

  private async removeAccount(id: string): Promise<void> {
    await this.accounts.remove(id);
    this.proxy.forgetAccount(id);
    this.downloads.forgetAccount(id);
  }

  private updateAccount(id: string, patch: AccountPatch): void {
    const before = this.accounts.account(id);
    this.store.update("accounts", (file) => ({
      ...file,
      accounts: file.accounts.map((account) => {
        if (account.id !== id) return account;
        const next: AccountConfig = { ...account };
        if (patch.label !== undefined) next.label = patch.label;
        if (patch.color !== undefined) next.color = patch.color;
        if (patch.icon !== undefined) {
          if (patch.icon === null || patch.icon.trim() === "") delete next.icon;
          else next.icon = patch.icon;
        }
        if (patch.notifications) next.notifications = { ...account.notifications, ...patch.notifications };
        if (patch.scheduleId !== undefined) {
          if (patch.scheduleId === null) delete next.scheduleId;
          else next.scheduleId = patch.scheduleId;
        }
        if (patch.autoSleepAfterMinutes !== undefined) {
          if (patch.autoSleepAfterMinutes === null) delete next.autoSleepAfterMinutes;
          else next.autoSleepAfterMinutes = patch.autoSleepAfterMinutes;
        }
        if (patch.zoomPercent !== undefined) next.zoomPercent = patch.zoomPercent;
        if (patch.permissions) next.permissions = { ...account.permissions, ...patch.permissions };
        if (patch.proxy !== undefined) next.proxy = patch.proxy;
        if (patch.proxyMode !== undefined) next.proxyMode = patch.proxyMode === "manual" && !next.proxy ? account.proxyMode : patch.proxyMode;
        return next;
      })
    }));
    const after = this.accounts.account(id);
    if (!before || !after) return;
    if (after.zoomPercent !== before.zoomPercent) this.views.setZoom(id, after.zoomPercent);
    if (after.proxyMode !== before.proxyMode || JSON.stringify(after.proxy) !== JSON.stringify(before.proxy)) {
      // Identifiants liés au serveur : un autre proxy ne reçoit jamais ceux du précédent.
      if (before.proxy && !sameServer(before.proxy, after.proxy)) this.proxy.clearCredentials(id);
      void this.proxy.applyAll();
      delete this.proxyTests[id];
    }
  }

  private setPreferences(patch: PreferencesPatch): void {
    const previous = this.store.get("preferences");
    this.store.update("preferences", (current) => ({
      ...current,
      ...patch,
      privacyVeil: { ...current.privacyVeil, ...patch.privacyVeil }
    }));
    const next = this.store.get("preferences");
    if (next.theme !== previous.theme) nativeTheme.themeSource = next.theme;
    if (next.language !== previous.language) {
      this.applyLocale();
      this.settingsWindow?.setTitle(t("window.settingsTitle", { product: PRODUCT_NAME }));
    }
    // Échec (dossier non accessible, portail refusé…) : on revient en arrière et on le dit.
    if (next.launchAtLogin !== previous.launchAtLogin) {
      void setLaunchAtLogin(next.launchAtLogin, this.log).then((ok) => {
        if (ok) return;
        this.store.update("preferences", (current) => ({ ...current, launchAtLogin: previous.launchAtLogin }));
        this.addNotice({ id: "autostart", level: "error", message: t("notice.autostartFailed") });
      });
    }
    if (next.handleWhatsappLinks !== previous.handleWhatsappLinks) {
      void setWhatsappLinkHandler(next.handleWhatsappLinks, this.log).then((ok) => {
        if (ok) return;
        this.store.update("preferences", (current) => ({ ...current, handleWhatsappLinks: previous.handleWhatsappLinks }));
        this.addNotice({ id: "link-handler", level: "error", message: t("notice.linkHandlerFailed") });
      });
    }
    if (next.spellcheckMode !== previous.spellcheckMode || next.spellcheckLanguages.join() !== previous.spellcheckLanguages.join()) {
      const plan = this.spellcheckPlan();
      for (const account of this.accounts.accounts()) applySpellcheck(this.sessionFor(account.id), plan);
    }
    if (next.sidebarCollapsed !== previous.sidebarCollapsed) this.views.relayout();
    if (next.interfaceScale !== previous.interfaceScale) this.applyInterfaceScale();
    if (next.downloadsHistoryDays !== previous.downloadsHistoryDays) this.downloads.applyRetention();
    if (JSON.stringify(next.privacyVeil) !== JSON.stringify(previous.privacyVeil)) this.veil.applyAll();
    if (JSON.stringify(next.proxy) !== JSON.stringify(previous.proxy)) {
      if (previous.proxy.server && !sameServer(previous.proxy.server, next.proxy.server)) this.proxy.clearCredentials("global");
      void this.proxy.applyAll();
      delete this.proxyTests.global;
    }
  }

  /** F14 : Pause / Reprendre, envoyé à la page qui lit. */
  private mediaControl(accountId: string, action: "pause" | "play"): void {
    const playback = this.playback.forAccount(accountId, Date.now());
    if (!playback) return;
    const page = allWebContents.fromId(playback.webContentsId);
    if (page && !page.isDestroyed()) page.send(CHANNELS.waMediaControl, action);
  }

  /** F3 : rapport écrit dans Téléchargements, puis dossier affiché ; rien n'est envoyé. */
  private createDiagnosticReport(): void {
    try {
      const preferences = this.store.get("preferences");
      const { proxy: _proxy, ...shareable } = preferences;
      const proxyHosts = [preferences.proxy.server?.host ?? "", ...this.accounts.accounts().map((account) => account.proxy?.host ?? "")].filter(Boolean);
      const display = screen.getPrimaryDisplay();
      const file = writeReport({
        product: PRODUCT_NAME,
        versions: { app: app.getVersion(), electron: process.versions.electron, chromium: process.versions.chrome, node: process.versions.node, locale: localeTag() },
        build: this.buildInfo(),
        system: systemInfo({ ozone: app.commandLine.getSwitchValue("ozone-platform") || "auto", scaleFactor: display.scaleFactor, tray: this.trayAvailable, secureStorage: this.proxy.secureStorage() }),
        accounts: this.accounts.accounts().map((account) => {
          const runtime = this.accounts.runtime(account.id);
          const proxy = this.proxy.effective(account.id);
          return {
            label: account.label,
            lifecycle: account.sleeping ? "sleeping" : (runtime?.lifecycle ?? "loading"),
            mode: this.policy.policy(account.id)?.mode ?? "normal",
            sleeping: account.sleeping,
            adapterDegraded: runtime?.adapterDegraded ?? false,
            inCall: this.calls.inCall(account.id),
            memoryMB: this.resources.memoryMB(account.id),
            proxy: proxy.mode === "fixed" ? `${proxy.server.type}${proxy.server.auth ? "+auth" : ""}` : proxy.mode
          };
        }),
        preferences: shareable,
        logFile: path.join(this.log.dir, "app.log"),
        proxyHosts,
        directory: app.getPath("downloads"),
        now: new Date()
      });
      this.log.info("diagnostic-report", { file: path.basename(file) });
      this.addNotice({ id: "report", level: "info", message: t("notice.reportCreated", { file: path.basename(file) }) });
      if (this.probe) this.probe.opened.push({ action: "show", file });
      else shell.showItemInFolder(file);
    } catch (error) {
      this.log.error("diagnostic-report-failed", error);
      this.addNotice({ id: "report", level: "error", message: t("notice.reportFailed") });
    }
  }

  private buildInfo(): unknown {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.options.paths.rendererDir, "..", "build-info.json"), "utf8"));
    } catch {
      return null;
    }
  }

  /** F3 : ouvre la page des tickets avec un titre prérempli ; l'utilisateur joint le rapport. */
  private reportProblem(): void {
    const body = `Version ${app.getVersion()} · Electron ${process.versions.electron} · ${process.env.XDG_CURRENT_DESKTOP ?? "?"} ${process.env.XDG_SESSION_TYPE ?? ""}`.trim();
    const url = `${ISSUES_URL}?title=${encodeURIComponent(t("report.issueTitle"))}&body=${encodeURIComponent(body)}`;
    if (this.probe) this.probe.external.push(url);
    else void shell.openExternal(url);
  }

  /** F6 : sans le code, effacer toutes les sessions est la seule façon de déverrouiller. */
  private async forgotLockCode(): Promise<void> {
    if (!this.lock.isLocked()) return;
    const { response } = await dialog.showMessageBox(this.mainWindow, {
      type: "warning",
      title: t("lock.resetTitle"),
      message: t("lock.resetMessage"),
      detail: t("lock.resetDetail"),
      buttons: [t("common.cancel"), t("lock.resetConfirm")],
      defaultId: 0,
      cancelId: 0
    });
    if (response !== 1) return;
    // D'abord effacer : rien ne doit redevenir lisible avant que les sessions aient disparu.
    // Un effacement en échec laisse le verrou en place.
    if (!(await this.accounts.resetAllSessions())) {
      await dialog.showMessageBox(this.mainWindow, { type: "error", title: t("lock.resetTitle"), message: t("lock.resetFailed"), buttons: [t("common.close")] });
      return;
    }
    // L'historique des téléchargements (noms de fichiers) disparaît avec les sessions.
    this.downloads.clearAll();
    this.lock.removeLock();
    this.addNotice({ id: "lock-reset", level: "warning", message: t("notice.lockReset") });
  }

  /** F9 : test de la route vers WhatsApp, pour le réglage global ou un compte. */
  private async testProxy(scope: "global" | string): Promise<void> {
    const accountId = scope === "global" ? this.accounts.accounts().find((account) => account.proxyMode === "inherit")?.id : scope;
    this.proxyTests[scope] = { ok: false, route: "", running: true };
    this.pushState();
    let result: ProxyTestResult;
    if (accountId && this.accounts.account(accountId)) {
      result = await this.proxy.test(accountId, this.options.targetUrl);
    } else {
      result = { ok: false, route: "", error: t("accounts.empty") };
    }
    this.proxyTests[scope] = result;
    this.pushState();
  }

  private popup(items: MenuItemModel[], x: number, y: number): void {
    Menu.buildFromTemplate(toElectronMenu(items, (action) => this.dispatchMenuAction(action))).popup({
      window: this.mainWindow,
      x: Math.round(x * this.interfaceScale()),
      y: Math.round(y * this.interfaceScale())
    });
  }

  dispatchMenuAction(action: MenuAction): void {
    // Verrouillé : seuls « Afficher » (l'écran de verrouillage) et « Quitter ».
    if (this.lock.isLocked() && action.type !== "show" && action.type !== "quit") return;
    switch (action.type) {
      case "show":
        this.showMainWindow();
        return;
      case "quit":
        this.quitting = true;
        app.quit();
        return;
      case "add-account":
        this.showMainWindow();
        this.mainWindow.webContents.send(CHANNELS.shellRequestAddAccount);
        return;
      case "settings":
        this.openSettings(action.accountId, action.section);
        return;
      case "switch":
        this.accounts.switchTo(action.id);
        this.showMainWindow();
        return;
      case "snooze":
        this.policy.snooze(action.id, action.preset);
        return;
      case "snooze-date":
        this.showMainWindow();
        this.mainWindow.webContents.send(CHANNELS.shellRequestSnoozeDate, action.id);
        return;
      case "resume":
        this.policy.resume(action.id);
        return;
      case "sleep":
        void this.handleCommand({ type: "sleep-account", id: action.id });
        return;
      case "wake":
        this.accounts.wake(action.id);
        return;
      case "reload":
        this.accounts.reload(action.id);
        return;
      case "remove":
        void this.confirmRemove(action.id);
        return;
      case "focus":
        this.policy.activateFocus(action.profileId, action.minutes);
        return;
      case "lock":
        this.lockNow();
        return;
      case "media":
        this.mediaControl(action.id, action.action);
        return;
      case "report":
        this.createDiagnosticReport();
        return;
    }
  }

  private async confirmRemove(id: string, parent = this.mainWindow): Promise<void> {
    const account = this.accounts.account(id);
    if (!account) return;
    const { response } = await dialog.showMessageBox(parent, {
      type: "warning",
      buttons: [t("common.cancel"), t("common.delete")],
      defaultId: 0,
      cancelId: 0,
      title: t("dialog.removeAccountTitle"),
      message: t("dialog.removeMessage", { name: account.label }),
      detail: t("dialog.removeAccountDetail")
    });
    if (response === 1) await this.removeAccount(id);
  }

  private async confirmSettingsDelete(title: string, name: string, detail: string): Promise<boolean> {
    const { response } = await dialog.showMessageBox(this.settingsWindow ?? this.mainWindow, {
      type: "warning", title, message: t("dialog.removeMessage", { name }), detail,
      buttons: [t("common.cancel"), t("common.delete")], defaultId: 0, cancelId: 0
    });
    return response === 1;
  }

  // --- IPC --------------------------------------------------------------------------------

  private isOwnRenderer(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
    const url = event.senderFrame?.url ?? "";
    return url.startsWith(rendererBaseUrl()) && (event.sender === this.mainWindow.webContents || event.sender === this.settingsWebContents());
  }

  /** Message d'une vue WhatsApp : compte déduit de l'expéditeur, jamais du message. */
  private whatsappSender(event: IpcMainEvent | IpcMainInvokeEvent): string | null {
    const id = this.views.accountIdFor(event.sender);
    if (!id) return null;
    const frame = event.senderFrame;
    if (!frame || frame.parent !== null || normalizeOrigin(frame.origin) !== this.whatsappOrigin) {
      this.log.warn("ipc-unexpected-frame", { id, origin: frame?.origin ?? null, top: frame ? frame.parent === null : null });
      return null;
    }
    return id;
  }

  private registerIpc(): void {
    ipcMain.handle(CHANNELS.shellGetState, (event) => (this.isOwnRenderer(event) ? this.shellState() : null));
    ipcMain.handle(CHANNELS.settingsGetState, (event) => (this.isOwnRenderer(event) && !this.lock.isLocked() ? this.settingsState() : null));
    ipcMain.on(CHANNELS.command, (event, raw: unknown) => {
      if (!this.isOwnRenderer(event)) return;
      const parsed = CommandSchema.safeParse(raw);
      if (!parsed.success) {
        this.log.warn("command-invalid", { issues: parsed.error.issues.length });
        return;
      }
      this.handleCommand(parsed.data).catch((error: unknown) => {
        this.log.error("command-failed", error);
        this.addNotice({ id: `command-${parsed.data.type}`, level: "error", message: t("notice.commandFailed", { message: (error as Error).message }) });
      });
    });

    ipcMain.on(CHANNELS.waNotify, (event, raw: unknown) => {
      const id = this.whatsappSender(event);
      const parsed = NotifyPayloadSchema.safeParse(raw);
      if (id && parsed.success) void this.notifications.handle(id, event.sender.id, parsed.data);
    });
    ipcMain.on(CHANNELS.waNotificationClose, (event, raw: unknown) => {
      const id = this.whatsappSender(event);
      if (id && Number.isInteger(raw)) this.notifications.close(event.sender.id, raw as number);
    });
    ipcMain.on(CHANNELS.waMedia, (event, raw: unknown) => {
      const id = this.whatsappSender(event);
      const parsed = MediaPayloadSchema.safeParse(raw);
      if (id && parsed.success) this.calls.onMedia(id, event.sender.id, parsed.data);
    });
    ipcMain.on(CHANNELS.waLinkState, (event, raw: unknown) => {
      const id = this.whatsappSender(event);
      const parsed = LinkStatePayloadSchema.safeParse(raw);
      // L'état de liaison ne vaut que pour la vue principale, pas pour une popup.
      if (id && parsed.success && this.views.isMainView(id, event.sender)) this.accounts.linkState(id, parsed.data);
    });
    ipcMain.on(CHANNELS.waEnv, (event, raw: unknown) => {
      const id = this.whatsappSender(event);
      const parsed = EnvPayloadSchema.safeParse(raw);
      if (!id || !parsed.success) return;
      if (this.probe) this.probe.env[id] = parsed.data;
      if (!parsed.data.notificationOverridden || parsed.data.scriptsBeforeOverride > 0 || /Electron/i.test(parsed.data.userAgent)) {
        this.log.warn("page-env", { id, ...parsed.data });
      }
    });
    ipcMain.on(CHANNELS.waSwNotification, (event) => {
      const id = this.whatsappSender(event);
      if (id) this.log.warn("sw-notification", { id, note: "notification via le service worker : non interceptée" });
    });
    ipcMain.on(CHANNELS.waVisibility, (event, raw: unknown) => {
      const id = this.whatsappSender(event);
      const parsed = VisibilityPayloadSchema.safeParse(raw);
      if (!id || !parsed.success || !this.views.isMainView(id, event.sender)) return;
      if (this.probe) this.probe.visibility[id] = parsed.data.state;
      if (parsed.data.state === "visible" && id !== this.views.shown()) this.log.warn("hidden-account-visible", { id });
    });
    // F14 : lecture d'un média ; « une seule lecture à la fois » en option.
    ipcMain.on(CHANNELS.waMediaPlayback, (event, raw: unknown) => {
      const id = this.whatsappSender(event);
      const parsed = PlaybackPayloadSchema.safeParse(raw);
      if (!id || !parsed.success) return;
      const started = this.playback.report(id, event.sender.id, parsed.data, Date.now());
      if (started && this.store.get("preferences").exclusivePlayback) {
        for (const pageId of this.playback.playingPagesExcept(id)) allWebContents.fromId(pageId)?.send(CHANNELS.waMediaControl, "pause");
      }
      this.applyAudio();
      this.pushState();
    });
    ipcMain.handle(CHANNELS.waLabels, (event) => (this.whatsappSender(event) ? { voiceMessage: t("media.voiceMessage"), video: t("media.video"), product: PRODUCT_NAME } : null));
    // F7 : survol ou clic dans une vue voilée ; auto-test du flou des messages.
    // Seule la page que l'utilisateur voit peut dévoiler : la vue affichée, ou une popup au premier plan.
    ipcMain.on(CHANNELS.waVeilReveal, (event, raw: unknown) => {
      const parsed = VeilRevealPayloadSchema.safeParse(raw);
      const id = this.whatsappSender(event);
      if (!id || !parsed.success) return;
      const shownView = id === this.views.shown() && this.views.isMainView(id, event.sender);
      const focusedPopup = !this.views.isMainView(id, event.sender) && BrowserWindow.fromWebContents(event.sender)?.isFocused() === true;
      if (shownView || focusedPopup) this.veil.reveal(parsed.data.kind);
    });
    ipcMain.on(CHANNELS.waAdapterCheck, (event, raw: unknown) => {
      const id = this.whatsappSender(event);
      const parsed = AdapterCheckPayloadSchema.safeParse(raw);
      if (!id || !parsed.success) return;
      if (!parsed.data.messageBlur) this.log.warn("adapter-message-blur-unmatched", { id });
      if (this.veil.adapterCheck(event.sender, parsed.data.messageBlur) && this.store.get("preferences").privacyVeil.blurMessages) {
        this.addNotice({ id: `blur-${id}`, level: "warning", message: t("notice.blurUnavailable", { label: this.accounts.account(id)?.label ?? t("common.anAccount") }) });
      }
    });
  }

  // --- Mises à jour (§42) ------------------------------------------------------------------

  private async checkForUpdates(): Promise<void> {
    if (!process.env.APPIMAGE || this.options.test) return;
    try {
      const { checkAppImageUpdates } = await import("./updates");
      await checkAppImageUpdates(this.log, (message) => this.addNotice({ id: "update", level: "info", message }));
    } catch (error) {
      this.log.warn("update-check-failed", error);
    }
  }

  /** Liens reçus d'une seconde instance (whatsapp://…). */
  handleSecondInstance(argv: string[]): void {
    this.showMainWindow();
    for (const link of linksFromArgv(argv)) this.links.handleExternal(link);
  }

  sessionPartitionsDir(): string {
    return path.join(app.getPath("userData"), "Partitions");
  }

  viewsManager(): ViewManager {
    return this.views;
  }
}

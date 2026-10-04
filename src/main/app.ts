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
  session,
  shell,
  webContents as allWebContents,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type Session,
  type WebContents
} from "electron";
import path from "node:path";
import { compactSidebar, CONNECTION_BAR_HEIGHT, DEFAULT_ACCOUNT_COLOR, SIDEBAR_WIDTH, WHATSAPP_ORIGIN } from "../shared/constants";
import { DISCLAIMER, PRODUCT_NAME } from "../shared/identity";
import {
  CHANNELS,
  CommandSchema,
  EnvPayloadSchema,
  LinkStatePayloadSchema,
  MediaPayloadSchema,
  NotifyPayloadSchema,
  VisibilityPayloadSchema,
  type AccountItem,
  type AccountPatch,
  type Command,
  type Notice,
  type PreferencesPatch,
  type SettingsState,
  type ShellState
} from "../shared/ipc";
import type { AccountConfig } from "../shared/schemas";
import { AccountManager } from "./accounts/account-manager";
import { CallCoordinator } from "./calls/call-coordinator";
import { reorderAccounts } from "./core/accounts";
import { accountMenu, focusMenu, snoozeMenu, trayMenu, type MenuAction, type MenuItemModel } from "./core/menus";
import { normalizeOrigin } from "./core/permissions";
import { attachContextMenu, isTrayAvailable, setLaunchAtLogin, setWhatsappLinkHandler } from "./desktop/desktop";
import { DownloadManager } from "./downloads/download-manager";
import { LinkRouter, linksFromArgv } from "./links/link-router";
import type { Logger } from "./log";
import { NotificationManager, type ShownNotification } from "./notifications/notification-manager";
import { PolicyService } from "./policy/policy-service";
import { ResourceMonitor } from "./resources/resource-monitor";
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
}

/** Ce que les tests de bout en bout observent (WHATHUSH_TEST=1, §39). */
export interface TestProbe {
  notifications: ShownNotification[];
  external: string[];
  downloads: Array<{ accountId: string; file: string; state: string }>;
  visibility: Record<string, string>;
  env: Record<string, unknown>;
}

const NETWORK_POLL_MS = 10_000;

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
  readonly probe: TestProbe | null;
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
  private readonly whatsappOrigin: string;
  private readonly userAgent = chromeUserAgent();

  constructor(private readonly options: AppOptions) {
    this.store = options.store;
    this.log = options.log;
    this.whatsappOrigin = options.whatsappOrigin ?? WHATSAPP_ORIGIN;
    this.probe = options.test ? { notifications: [], external: [], downloads: [], visibility: {}, env: {} } : null;
    this.notices.push(...this.store.notices);

    this.policy = new PolicyService(this.store, () => new Date(), systemTimeZone);
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
      },
      accountGone: (accountId) => {
        this.calls.resetAccount(accountId);
        this.notifications.closeForAccount(accountId);
      }
    });
    this.notifications = new NotificationManager({
      log: this.log,
      account: (id) => this.accounts.account(id),
      policy: (id) => this.policy.policy(id),
      accountsInCall: () => this.calls.accountsInCall(),
      open: (id, webContentsId, notificationId) => this.openFromNotification(id, webContentsId, notificationId),
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
      registerPopup: (accountId, window) => this.views.registerPopup(accountId, window),
      askAccount: () => {
        this.showMainWindow();
        this.pushState();
      },
      ...(this.probe ? { openExternal: (url: string) => this.probe?.external.push(url) } : {})
    });
    this.downloads = new DownloadManager({
      log: this.log,
      askLocation: () => this.store.get("preferences").askDownloadLocation,
      accountLabel: (id) => this.accounts.account(id)?.label ?? "",
      ...(this.probe ? { sink: (event: { accountId: string; file: string; state: string }) => this.probe?.downloads.push(event) } : {})
    });
    this.resources = new ResourceMonitor(this.accounts, () => this.views, this.calls, (notice) => this.addNotice(notice));
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
      configure: (id, webContents) => this.configureWebContents(id, webContents),
      bounds: () => this.viewBounds(),
      events: this.accounts,
      log: this.log,
      devTools: this.options.devTools
    });

    this.wireWindow();
    this.registerIpc();
    this.wireSystem();

    for (const source of [this.accounts, this.policy, this.calls, this.resources] as const) {
      source.on("changed", () => this.pushState());
    }
    this.policy.on("changed", () => this.applyAudio());
    this.calls.on("changed", () => this.applyAudio());
    this.accounts.on("changed", () => this.applyAudio());
    this.accounts.on("changed", () => this.views.relayout());
    this.store.on("change", (key) => {
      if (key === "preferences") this.views.relayout();
      if (key !== "preferences") this.policy.recompute();
      this.pushState();
    });

    if (this.trayAvailable && process.env.WHATHUSH_TRAY !== "0") {
      this.tray = new TrayManager(this.options.paths.iconDir, PRODUCT_NAME);
      this.tray.create();
    }

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
      spellcheckLanguages: () => this.store.get("preferences").spellcheckLanguages,
      chooseScreen: (accountId, sources) => this.chooseScreen(accountId, sources)
    });
  }

  /** §20 : sous X11, confirmation et choix de l'écran (sous Wayland, le portail l'a fait). */
  private async chooseScreen(accountId: string, sources: Electron.DesktopCapturerSource[]): Promise<Electron.DesktopCapturerSource | null> {
    const ozone = app.commandLine.getSwitchValue("ozone-platform");
    if (usesWaylandPortal(ozone) || this.options.test) return sources[0] ?? null;
    if (sources.length === 0) return null;
    const label = this.accounts.account(accountId)?.label ?? "Un compte";
    const { response } = await dialog.showMessageBox(this.mainWindow, {
      type: "question",
      title: "Partage d’écran",
      message: `« ${label} » demande à partager votre écran.`,
      detail: "Tout ce qui s’affiche sur l’écran choisi sera visible par vos correspondants.",
      buttons: ["Annuler", ...sources.map((source, index) => source.name || `Écran ${index + 1}`)],
      defaultId: 0,
      cancelId: 0
    });
    return response === 0 ? null : (sources[response - 1] ?? null);
  }

  private configureWebContents(id: string, webContents: WebContents): void {
    this.links.attach(id, webContents);
    attachContextMenu(webContents, {
      devTools: this.options.devTools,
      openLink: (url) => this.links.handleExternal(url)
    });
    webContents.on("before-input-event", (event, input) => this.handleShortcut(event, input, webContents));
  }

  private viewBounds(): Electron.Rectangle {
    const [width = 0, height = 0] = this.mainWindow.getContentSize();
    const sidebar = compactSidebar(width, this.store.get("preferences").sidebarCollapsed) ? SIDEBAR_WIDTH.collapsed : SIDEBAR_WIDTH.expanded;
    const active = this.accounts.active();
    const top = active && this.accounts.runtime(active)?.lifecycle === "offline" ? CONNECTION_BAR_HEIGHT : 0;
    return { x: sidebar, y: top, width: Math.max(0, width - sidebar), height: Math.max(0, height - top) };
  }

  private wireWindow(): void {
    const window = this.mainWindow;
    for (const event of ["resize", "maximize", "unmaximize", "enter-full-screen", "leave-full-screen"] as const) {
      window.on(event as "resize", () => this.views.relayout());
    }
    window.on("show", () => this.accounts.refreshVisibility());
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
    window.webContents.on("did-finish-load", () => this.pushState());
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

  // --- Raccourcis (§9) -----------------------------------------------------------------

  private handleShortcut(event: Electron.Event, input: Electron.Input, contents: WebContents): void {
    if (input.type !== "keyDown") return;
    const ctrlOnly = input.control && !input.alt && !input.meta;
    if (ctrlOnly && !input.shift && /^[1-9]$/.test(input.key)) {
      event.preventDefault();
      this.accounts.switchToShortcut(Number(input.key));
    } else if (ctrlOnly && input.key === "Tab") {
      event.preventDefault();
      this.accounts.cycle(input.shift ? -1 : 1);
    } else if (ctrlOnly && !input.shift && input.key === ",") {
      event.preventDefault();
      this.openSettings();
    } else if (input.key === "F6" && !input.control && !input.alt && !input.meta) {
      event.preventDefault();
      const active = this.accounts.active();
      const view = active ? this.views.webContents(active) : null;
      if (contents === this.mainWindow.webContents && view && this.views.shown()) view.focus();
      else {
        this.mainWindow.webContents.focus();
        this.mainWindow.webContents.send(CHANNELS.shellRequestFocusAccounts);
      }
    } else if (input.key === "F12" && this.options.devTools) {
      event.preventDefault();
      const id = this.accounts.active();
      const wc = id ? this.views.webContents(id) : null;
      if (wc) wc.isDevToolsOpened() ? wc.closeDevTools() : wc.openDevTools({ mode: "detach" });
    }
  }

  // --- Fenêtres -------------------------------------------------------------------------------

  showMainWindow(): void {
    const window = this.mainWindow;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  }

  openSettings(accountId?: string, section?: "focus"): void {
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
    settings.webContents.on("did-finish-load", () => this.pushState());
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
    // La page d'origine (vue ou popup) reçoit le clic et ouvre la conversation.
    const origin = allWebContents.fromId(webContentsId);
    if (origin && !origin.isDestroyed() && this.views.accountIdFor(origin) === id) origin.send(CHANNELS.waNotificationClick, notificationId);
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
    const accounts: AccountItem[] = this.accounts.accounts().map((account, index) => this.accountItem(account, index));
    const totalUnread = accounts.reduce((sum, item) => {
      const account = this.accounts.account(item.id);
      const policy = this.policy.policy(item.id);
      return account?.notifications.includeInTotal && policy?.badge ? sum + (item.unread ?? 0) : sum;
    }, 0);
    return {
      productName: PRODUCT_NAME,
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
      trayAvailable: this.trayAvailable
    };
  }

  private accountItem(account: AccountConfig, index: number): AccountItem {
    const runtime = this.accounts.runtime(account.id);
    const policy = this.policy.policy(account.id);
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
      memoryMB: this.resources.memoryMB(account.id)
    };
  }

  settingsState(): SettingsState {
    const memory: Record<string, number | null> = {};
    for (const account of this.accounts.accounts()) memory[account.id] = this.resources.memoryMB(account.id);
    return {
      productName: PRODUCT_NAME,
      disclaimer: DISCLAIMER,
      preferences: this.store.get("preferences"),
      accounts: this.accounts.accounts(),
      schedules: this.store.get("schedules").schedules,
      focus: this.store.get("focus"),
      trayAvailable: this.trayAvailable,
      spellcheckLanguages: session.defaultSession.availableSpellCheckerLanguages,
      versions: { app: app.getVersion(), electron: process.versions.electron, chromium: process.versions.chrome, node: process.versions.node },
      paths: { userData: app.getPath("userData"), logs: this.log.dir },
      memory,
      navigationRequest: this.settingsRequest,
      notices: [...this.notices]
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
      this.settingsWebContents()?.send(CHANNELS.settingsState, this.settingsState());
      this.updateBadge(state);
      // §21 : le menu du tray n'est reconstruit que si son contenu change (un menu
      // ouvert se refermerait sinon sur certains bureaux).
      const menu = trayMenu(state, new Date());
      const signature = JSON.stringify(menu) + state.totalUnread;
      if (this.tray && signature !== this.traySignature) {
        this.traySignature = signature;
        this.tray.update(menu, state.totalUnread, (action) => this.dispatchMenuAction(action));
      }
    }, 30);
  }

  private updateBadge(state: ShellState): void {
    app.setBadgeCount(state.totalUnread);
    this.mainWindow.setTitle(state.totalUnread > 0 ? `(${state.totalUnread}) ${PRODUCT_NAME}` : PRODUCT_NAME);
  }

  /** §12 : son de la page coupé pour un compte en Snooze caché, jamais pendant un appel. */
  private applyAudio(): void {
    const shown = this.views.shown();
    for (const id of this.views.ids()) {
      const policy = this.policy.policy(id);
      this.views.setMuted(id, Boolean(policy?.muteAudioWhenHidden) && id !== shown && !this.calls.inCall(id));
    }
  }

  // --- Commandes --------------------------------------------------------------------------------

  async handleCommand(command: Command): Promise<void> {
    this.log.debug("command", { type: command.type });
    switch (command.type) {
      case "add-account":
        this.accounts.add({ label: command.label, ...(command.color ? { color: command.color } : {}), ...(command.icon ? { icon: command.icon } : {}) });
        if (!this.store.get("preferences").onboardingDone) this.setPreferences({ onboardingDone: true });
        return;
      case "switch-account":
        this.accounts.switchTo(command.id);
        return;
      case "sleep-account":
        if (!this.accounts.sleep(command.id)) this.addNotice({ id: `sleep-${command.id}`, level: "info", message: "Impossible de mettre ce compte en veille pendant un appel." });
        return;
      case "wake-account":
        this.accounts.wake(command.id);
        return;
      case "reload-account":
        this.accounts.reload(command.id);
        return;
      case "remove-account":
        await this.accounts.remove(command.id);
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
        this.openSettings(command.accountId);
        return;
      case "update-account":
        this.updateAccount(command.id, command.patch);
        return;
      case "clear-cache": {
        // §27 : jamais IndexedDB, localStorage ni cookies (ce serait une déconnexion).
        const ses = this.sessionFor(command.id);
        await ses.clearCache();
        await ses.clearStorageData({ storages: ["cachestorage", "shadercache"] });
        this.addNotice({ id: `cache-${command.id}`, level: "info", message: "Cache vidé. La session WhatsApp est conservée." });
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
        if (schedule && await this.confirmSettingsDelete("Supprimer l’horaire", schedule.name, "Les comptes associés n’utiliseront plus cet horaire.")) {
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
        if (profile && await this.confirmSettingsDelete("Supprimer le Focus", profile.name, "Ce Focus ne sera plus disponible. S’il est actif, il sera désactivé.")) {
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
    }
  }

  private updateAccount(id: string, patch: AccountPatch): void {
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
        return next;
      })
    }));
  }

  private setPreferences(patch: PreferencesPatch): void {
    const previous = this.store.get("preferences");
    this.store.update("preferences", (current) => ({ ...current, ...patch }));
    const next = this.store.get("preferences");
    if (next.theme !== previous.theme) nativeTheme.themeSource = next.theme;
    // Échec (dossier non accessible, portail refusé…) : on revient en arrière et on le dit.
    if (next.launchAtLogin !== previous.launchAtLogin) {
      void setLaunchAtLogin(next.launchAtLogin, this.log).then((ok) => {
        if (ok) return;
        this.store.update("preferences", (current) => ({ ...current, launchAtLogin: previous.launchAtLogin }));
        this.addNotice({ id: "autostart", level: "error", message: "Impossible de modifier le lancement à l’ouverture de session (voir le journal)." });
      });
    }
    if (next.handleWhatsappLinks !== previous.handleWhatsappLinks) {
      void setWhatsappLinkHandler(next.handleWhatsappLinks, this.log).then((ok) => {
        if (ok) return;
        this.store.update("preferences", (current) => ({ ...current, handleWhatsappLinks: previous.handleWhatsappLinks }));
        this.addNotice({ id: "link-handler", level: "error", message: "Impossible de modifier le gestionnaire des liens whatsapp:// (voir le journal)." });
      });
    }
    if (next.spellcheckLanguages.join() !== previous.spellcheckLanguages.join()) {
      for (const account of this.accounts.accounts()) applySpellcheck(this.sessionFor(account.id), next.spellcheckLanguages);
    }
    if (next.sidebarCollapsed !== previous.sidebarCollapsed) this.views.relayout();
  }

  private popup(items: MenuItemModel[], x: number, y: number): void {
    Menu.buildFromTemplate(toElectronMenu(items, (action) => this.dispatchMenuAction(action))).popup({
      window: this.mainWindow,
      x: Math.round(x),
      y: Math.round(y)
    });
  }

  dispatchMenuAction(action: MenuAction): void {
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
    }
  }

  private async confirmRemove(id: string, parent = this.mainWindow): Promise<void> {
    const account = this.accounts.account(id);
    if (!account) return;
    const { response } = await dialog.showMessageBox(parent, {
      type: "warning",
      buttons: ["Annuler", "Supprimer"],
      defaultId: 0,
      cancelId: 0,
      title: "Supprimer le compte",
      message: `Supprimer « ${account.label} » ?`,
      detail:
        "La session et les données locales de ce compte seront effacées. Pensez aussi à retirer l’appareil depuis votre téléphone : WhatsApp → Appareils connectés."
    });
    if (response === 1) await this.accounts.remove(id);
  }

  private async confirmSettingsDelete(title: string, name: string, detail: string): Promise<boolean> {
    const { response } = await dialog.showMessageBox(this.settingsWindow ?? this.mainWindow, {
      type: "warning", title, message: `Supprimer « ${name} » ?`, detail,
      buttons: ["Annuler", "Supprimer"], defaultId: 0, cancelId: 0
    });
    return response === 1;
  }

  // --- IPC --------------------------------------------------------------------------------

  private isOwnRenderer(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
    const url = event.senderFrame?.url ?? "";
    return url.startsWith(rendererBaseUrl()) && (event.sender === this.mainWindow.webContents || event.sender === this.settingsWebContents());
  }

  /** Message d'une vue WhatsApp : compte déduit de l'expéditeur, jamais du message. */
  private whatsappSender(event: IpcMainEvent): string | null {
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
    ipcMain.handle(CHANNELS.settingsGetState, (event) => (this.isOwnRenderer(event) ? this.settingsState() : null));
    ipcMain.on(CHANNELS.command, (event, raw: unknown) => {
      if (!this.isOwnRenderer(event)) return;
      const parsed = CommandSchema.safeParse(raw);
      if (!parsed.success) {
        this.log.warn("command-invalid", { issues: parsed.error.issues.length });
        return;
      }
      this.handleCommand(parsed.data).catch((error: unknown) => {
        this.log.error("command-failed", error);
        this.addNotice({ id: `command-${parsed.data.type}`, level: "error", message: `Action impossible : ${(error as Error).message}` });
      });
    });

    ipcMain.on(CHANNELS.waNotify, (event, raw: unknown) => {
      const id = this.whatsappSender(event);
      const parsed = NotifyPayloadSchema.safeParse(raw);
      if (id && parsed.success) this.notifications.handle(id, event.sender.id, parsed.data);
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

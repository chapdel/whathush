// Feasibility Lab — processus principal.
// Prototype jetable : il sert à répondre aux questions
// ouvertes, pas à préfigurer l'architecture finale. Les morceaux validés
// (fabrique de sessions, interception des notifications, visibilité) seront
// repris proprement en phase 1.

import {
  app,
  BrowserWindow,
  clipboard,
  desktopCapturer,
  ipcMain,
  Menu,
  net,
  Notification,
  powerMonitor,
  session,
  shell,
  WebContentsView
} from "electron";
import type { IpcMainEvent, Session, WebContents } from "electron";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import type {
  AccountView,
  EnvPayload,
  Lifecycle,
  LogEntry,
  MediaPayload,
  NotifyPayload,
  ShellState,
  VisibilityPayload
} from "./shared";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// LAB_MODE : "smoke" (fausse page, vérifications automatiques) ou "probe"
// (vrai web.whatsapp.com sans compte). Tous deux tournent dans un dossier jetable.
const MODE = process.env.LAB_MODE ?? "";
const SMOKE = MODE === "smoke";
const PROBE = MODE === "probe";
const ISOLATED = SMOKE || PROBE;
const FAKE = SMOKE || process.env.LAB_FAKE === "1";
// LAB_UA=electron garde le User-Agent par défaut d'Electron (pour comparaison).
const UA_OVERRIDE = process.env.LAB_UA !== "electron";
const PERMISSIVE = process.env.LAB_PERMISSIVE === "1";
const LOG_CONTENT = process.env.LAB_LOG_CONTENT === "1";

const SIDEBAR_WIDTH = 260;
const LOG_HEIGHT = 190;
const METRICS_INTERVAL_MS = 5000;
const STAGGER_MS = SMOKE ? 200 : 2000;
const CRASH_BACKOFF_MS = [1000, 5000, 30000];
const CRASH_WINDOW_MS = 5 * 60_000;
const COLORS = ["#25a366", "#3b82f6", "#f59e0b", "#ef4444", "#8b5cf6", "#14b8a6", "#ec4899", "#64748b"];

// Liste blanche des permissions. Tout refus est journalisé : c'est ainsi qu'on découvre
// ce dont WhatsApp a réellement besoin.
const ALLOWED_PERMISSIONS = new Set<string>([
  // Demandée par WhatsApp au chargement : protège la session contre l'éviction
  // du stockage (IndexedDB) quand l'espace disque manque. Constat de la sonde.
  "persistent-storage",
  "notifications",
  "media",
  "display-capture",
  "clipboard-read",
  "clipboard-sanitized-write",
  "fullscreen"
]);

let targetUrl = process.env.LAB_TARGET_URL ?? "https://web.whatsapp.com/";
let targetOrigin = new URL(targetUrl).origin;

// Dossiers séparés : vrais comptes, fausse page, smoke test jetable.
const userDataDir = ISOLATED
  ? (process.env.LAB_TEMP_DIR ?? fs.mkdtempSync(path.join(os.tmpdir(), "feasibility-lab-")))
  : path.join(app.getPath("appData"), FAKE ? "feasibility-lab-fake" : "feasibility-lab");
app.setPath("userData", userDataDir);
if (UA_OVERRIDE) app.userAgentFallback = chromeUserAgent();

// ---------------------------------------------------------------------------
// Journal et métriques
// ---------------------------------------------------------------------------

const logDir = path.join(userDataDir, "logs");
fs.mkdirSync(logDir, { recursive: true });
const runStamp = new Date().toISOString().replace(/[:.]/g, "-");
const logFile = path.join(logDir, `lab-${runStamp}.jsonl`);
const metricsFile = path.join(logDir, `metrics-${runStamp}.csv`);
fs.writeFileSync(metricsFile, "ts,account,label,pid,workingSetMB,cpuPercent\n");
const recentLogs: LogEntry[] = [];

function log(event: string, data?: unknown, options: { account?: string; level?: LogEntry["level"] } = {}): void {
  const entry: LogEntry = {
    ts: new Date().toISOString(),
    level: options.level ?? "info",
    account: options.account,
    event,
    data
  };
  fs.appendFileSync(logFile, JSON.stringify(entry) + "\n");
  recentLogs.push(entry);
  if (recentLogs.length > 300) recentLogs.shift();
  if (!ISOLATED || entry.level !== "info") console.log(formatLog(entry));
  sendToShell("lab:log", entry);
}

function formatLog(entry: LogEntry): string {
  const time = entry.ts.slice(11, 19);
  const data = entry.data === undefined ? "" : " " + JSON.stringify(entry.data);
  return `${time} ${entry.level.toUpperCase().padEnd(5)} [${entry.account ?? "lab"}] ${entry.event}${data}`;
}

// ---------------------------------------------------------------------------
// Stockage des comptes
// ---------------------------------------------------------------------------

interface StoredAccount {
  id: string;
  label: string;
  color: string;
  sleeping: boolean;
  snoozed: boolean;
}

interface StoreFile {
  schemaVersion: 1;
  accounts: StoredAccount[];
  activeId: string | null;
  pendingPartitionDeletion: string[];
}

const storeFile = path.join(userDataDir, "lab-accounts.json");
const store: StoreFile = loadStore();

function loadStore(): StoreFile {
  try {
    const raw = JSON.parse(fs.readFileSync(storeFile, "utf8"));
    if (raw?.schemaVersion === 1 && Array.isArray(raw.accounts)) {
      return { activeId: null, pendingPartitionDeletion: [], ...raw };
    }
    throw new Error("format inattendu");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      // Jamais d'écrasement silencieux : on garde une copie du fichier illisible.
      try {
        fs.copyFileSync(storeFile, `${storeFile}.corrupt`);
      } catch {
        // rien à sauvegarder
      }
      console.error(`lab-accounts.json illisible (${String(error)}), copie en .corrupt`);
    }
    return { schemaVersion: 1, accounts: [], activeId: null, pendingPartitionDeletion: [] };
  }
}

function saveStore(): void {
  const tmp = `${storeFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
  fs.renameSync(tmp, storeFile);
}

function findAccount(id: string | null): StoredAccount | undefined {
  return id ? store.accounts.find((account) => account.id === id) : undefined;
}

function partitionOf(id: string): string {
  return `persist:wa-${id}`;
}

// ---------------------------------------------------------------------------
// État runtime
// ---------------------------------------------------------------------------

interface Runtime {
  view: WebContentsView | null;
  lifecycle: Lifecycle;
  unread: number | null;
  pageVisibility: string | null;
  liveTracks: Map<string, number>;
  audible: boolean;
  memoryMB: number | null;
  cpuPercent: number | null;
  crashTimes: number[];
  notifications: Map<number, Notification>;
  permissionChecksSeen: Set<string>;
  envCount: number;
  lastEnv: EnvPayload | null;
  notifyCount: number;
  lastNotifyId: number | null;
}

const runtimes = new Map<string, Runtime>();
const accountByWebContentsId = new Map<number, string>();
let win: BrowserWindow | null = null;
let logsVisible = true;
let totalMemoryMB: number | null = null;
let lastOnline: boolean | null = null;
let badgeSupportLogged = false;

function runtimeOf(id: string): Runtime {
  let runtime = runtimes.get(id);
  if (!runtime) {
    runtime = {
      view: null,
      lifecycle: "sleeping",
      unread: null,
      pageVisibility: null,
      liveTracks: new Map(),
      audible: false,
      memoryMB: null,
      cpuPercent: null,
      crashTimes: [],
      notifications: new Map(),
      permissionChecksSeen: new Set(),
      envCount: 0,
      lastEnv: null,
      notifyCount: 0,
      lastNotifyId: null
    };
    runtimes.set(id, runtime);
  }
  return runtime;
}

function liveCount(runtime: Runtime, key: string): number {
  return runtime.liveTracks.get(key) ?? 0;
}

// ---------------------------------------------------------------------------
// User-Agent et origines
// ---------------------------------------------------------------------------

function chromeUserAgent(): string {
  const major = process.versions.chrome.split(".")[0];
  const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
  return `Mozilla/5.0 (X11; Linux ${arch}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

function originOf(url: string | undefined): string {
  try {
    return url ? new URL(url).origin : "";
  } catch {
    return "";
  }
}

function isPermissionAllowed(permission: string, origin: string): boolean {
  return PERMISSIVE || (origin === targetOrigin && ALLOWED_PERMISSIONS.has(permission));
}

// ---------------------------------------------------------------------------
// Fabrique de sessions : tout le durcissement passe ici
// ---------------------------------------------------------------------------

const hardenedSessions = new WeakSet<Session>();

function sessionFor(account: StoredAccount): Session {
  const ses = session.fromPartition(partitionOf(account.id));
  if (hardenedSessions.has(ses)) return ses;
  hardenedSessions.add(ses);

  if (UA_OVERRIDE) ses.setUserAgent(chromeUserAgent());

  ses.setPermissionRequestHandler((_webContents, permission, callback, details) => {
    const origin = originOf(details.requestingUrl);
    const granted = isPermissionAllowed(permission, origin);
    const mediaTypes = "mediaTypes" in details ? details.mediaTypes : undefined;
    log("permission-request", { permission, origin, granted, mediaTypes }, {
      account: account.label,
      level: granted ? "info" : "warn"
    });
    callback(granted);
  });

  ses.setPermissionCheckHandler((_webContents, permission, requestingOrigin) => {
    // Chromium transmet ici l'origine avec une barre finale : on la normalise.
    const granted = isPermissionAllowed(permission, originOf(requestingOrigin));
    const runtime = runtimeOf(account.id);
    const key = `${permission}|${requestingOrigin}|${granted}`;
    if (!runtime.permissionChecksSeen.has(key)) {
      runtime.permissionChecksSeen.add(key);
      log("permission-check", { permission, origin: requestingOrigin, granted }, { account: account.label });
    }
    return granted;
  });

  ses.setDevicePermissionHandler(() => false);

  // Sous Wayland, desktopCapturer déclenche le sélecteur du portail.
  ses.setDisplayMediaRequestHandler((request, callback) => {
    const origin = originOf(request.securityOrigin);
    log("display-media-request", { origin, video: request.videoRequested, audio: request.audioRequested }, {
      account: account.label
    });
    if (!isPermissionAllowed("display-capture", origin)) {
      callback({});
      return;
    }
    desktopCapturer
      .getSources({ types: ["screen"] })
      .then((sources) => {
        log("display-media-sources", { count: sources.length, names: sources.map((s) => s.name) }, {
          account: account.label
        });
        callback(sources.length > 0 ? { video: sources[0] } : {});
      })
      .catch((error) => {
        log("display-media-error", String(error), { account: account.label, level: "error" });
        callback({});
      });
  });

  ses.on("will-download", (_event, item) => {
    log("download-start", { file: item.getFilename(), mime: item.getMimeType(), bytes: item.getTotalBytes() }, {
      account: account.label
    });
    item.once("done", (_doneEvent, state) => {
      log("download-done", { file: item.getFilename(), state, savePath: item.getSavePath() }, {
        account: account.label
      });
    });
  });

  return ses;
}

// ---------------------------------------------------------------------------
// Vues WhatsApp
// ---------------------------------------------------------------------------

function contentBounds(): Electron.Rectangle {
  const { width, height } = win ? win.getContentBounds() : { width: 0, height: 0 };
  return {
    x: SIDEBAR_WIDTH,
    y: 0,
    width: Math.max(0, width - SIDEBAR_WIDTH),
    height: Math.max(0, height - (logsVisible ? LOG_HEIGHT : 0))
  };
}

function layoutViews(): void {
  const bounds = contentBounds();
  for (const runtime of runtimes.values()) runtime.view?.setBounds(bounds);
}

function createView(account: StoredAccount): void {
  if (!win) return;
  const runtime = runtimeOf(account.id);
  if (runtime.view) return;

  const view = new WebContentsView({
    webPreferences: {
      session: sessionFor(account),
      preload: path.join(__dirname, "preload-whatsapp.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // Désactivé : sous Linux, les dictionnaires seraient téléchargés chez Google.
      spellcheck: false
      // backgroundThrottling reste à true : sinon la page se croit visible.
    }
  });

  runtime.view = view;
  runtime.lifecycle = "loading";
  runtime.unread = null;
  runtime.pageVisibility = null;
  runtime.liveTracks.clear();
  runtime.audible = false;
  accountByWebContentsId.set(view.webContents.id, account.id);

  win.contentView.addChildView(view);
  view.setBounds(contentBounds());
  view.setVisible(account.id === store.activeId);
  wireWebContents(account, view.webContents);

  log("view-created", { partition: partitionOf(account.id) }, { account: account.label });
  view.webContents.loadURL(targetUrl).catch((error) => {
    log("load-error", String(error), { account: account.label, level: "warn" });
  });
  pushState();
}

function destroyView(id: string): void {
  const runtime = runtimes.get(id);
  if (!runtime?.view) return;
  const view = runtime.view;
  runtime.view = null;
  accountByWebContentsId.delete(view.webContents.id);
  for (const notification of runtime.notifications.values()) notification.close();
  runtime.notifications.clear();
  win?.contentView.removeChildView(view);
  if (!view.webContents.isDestroyed()) {
    // Fermeture volontaire : ce n'est pas un crash.
    view.webContents.removeAllListeners("render-process-gone");
    view.webContents.close();
  }
}

function wireWebContents(account: StoredAccount, wc: WebContents): void {
  const runtime = runtimeOf(account.id);
  const tag = { account: account.label };

  // Compteur de non-lus via le titre, sans lire le DOM.
  wc.on("page-title-updated", (_event, title) => {
    const match = /^\((\d+)\)/.exec(title);
    const unread = match ? Number(match[1]) : 0;
    if (unread !== runtime.unread) {
      runtime.unread = unread;
      log("unread", { title, unread }, tag);
      updateBadge();
      pushState();
    }
  });

  wc.on("did-finish-load", () => {
    runtime.lifecycle = "loaded";
    log("did-finish-load", { url: wc.getURL() }, tag);
    pushState();
  });

  wc.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame) return;
    runtime.lifecycle = "failed";
    log("did-fail-load", { errorCode, errorDescription, url: validatedURL }, { ...tag, level: "warn" });
    pushState();
  });

  wc.on("render-process-gone", (_event, details) => handleCrash(account, details));
  wc.on("unresponsive", () => log("unresponsive", undefined, { ...tag, level: "warn" }));
  wc.on("responsive", () => log("responsive", undefined, tag));

  // Test n°16 : un son prolongé dans un compte caché peut signaler un appel entrant.
  wc.on("audio-state-changed", (event) => {
    runtime.audible = event.audible;
    log("audio", { audible: event.audible }, tag);
    pushState();
  });

  wc.on("before-input-event", handleShortcut);

  // Routage des liens et des popups.
  wc.setWindowOpenHandler(({ url }) => routeWindowOpen(account, url));
  wc.on("did-create-window", (child, details) => {
    log("popup-created", { url: details.url }, tag);
    child.webContents.setWindowOpenHandler(({ url }) => routeWindowOpen(account, url));
    child.on("closed", () => log("popup-closed", undefined, tag));
  });
  wc.on("will-navigate", (event) => {
    if (originOf(event.url) !== targetOrigin) {
      event.preventDefault();
      openExternalSafely(account, event.url);
    }
  });

  wc.on("context-menu", (_event, params) => showContextMenu(wc, params));
}

function routeWindowOpen(account: StoredAccount, url: string): { action: "allow" } | { action: "deny" } {
  if (url === "about:blank" || originOf(url) === targetOrigin) {
    // Question ouverte n°6 : l'interface d'appel s'ouvre-t-elle dans une popup ?
    log("window-open-allowed", { url }, { account: account.label });
    return { action: "allow" };
  }
  openExternalSafely(account, url);
  return { action: "deny" };
}

function openExternalSafely(account: StoredAccount, url: string): void {
  let protocol = "";
  try {
    protocol = new URL(url).protocol;
  } catch {
    // URL invalide : bloquée ci-dessous
  }
  if (protocol === "http:" || protocol === "https:" || protocol === "mailto:") {
    log("open-external", { url }, { account: account.label });
    void shell.openExternal(url);
  } else {
    log("blocked-url", { url }, { account: account.label, level: "warn" });
  }
}

function showContextMenu(wc: WebContents, params: Electron.ContextMenuParams): void {
  const items: Electron.MenuItemConstructorOptions[] = [];
  if (params.isEditable) {
    items.push({ role: "cut", label: "Couper" }, { role: "copy", label: "Copier" }, { role: "paste", label: "Coller" });
  } else if (params.selectionText) {
    items.push({ role: "copy", label: "Copier" });
  }
  if (params.linkURL) {
    items.push({ label: "Copier le lien", click: () => clipboard.writeText(params.linkURL) });
  }
  if (items.length > 0) items.push({ type: "separator" });
  items.push({ label: "Inspecter l’élément", click: () => wc.inspectElement(params.x, params.y) });
  Menu.buildFromTemplate(items).popup(win ? { window: win } : undefined);
}

// Reprise après crash avec backoff, arrêt si les crashs s'enchaînent.
function handleCrash(account: StoredAccount, details: Electron.RenderProcessGoneDetails): void {
  const runtime = runtimeOf(account.id);
  log("render-process-gone", details, { account: account.label, level: "error" });
  destroyView(account.id);
  runtime.lifecycle = "crashed";
  pushState();

  const now = Date.now();
  runtime.crashTimes = runtime.crashTimes.filter((time) => now - time < CRASH_WINDOW_MS);
  runtime.crashTimes.push(now);
  if (runtime.crashTimes.length > CRASH_BACKOFF_MS.length) {
    log("crash-loop", { crashes: runtime.crashTimes.length, note: "recréation arrêtée, utiliser Recharger" }, {
      account: account.label,
      level: "error"
    });
    return;
  }
  const delay = CRASH_BACKOFF_MS[runtime.crashTimes.length - 1];
  log("recreate-scheduled", { delayMs: delay }, { account: account.label });
  setTimeout(() => {
    const current = findAccount(account.id);
    if (current && !current.sleeping && !runtimeOf(current.id).view) createView(current);
  }, delay);
}

// ---------------------------------------------------------------------------
// Actions sur les comptes
// ---------------------------------------------------------------------------

function addAccount(label: string): StoredAccount {
  const cleanLabel = label.trim().slice(0, 40) || `Compte ${store.accounts.length + 1}`;
  const account: StoredAccount = {
    id: crypto.randomUUID(),
    label: cleanLabel,
    color: COLORS[store.accounts.length % COLORS.length],
    sleeping: false,
    snoozed: false
  };
  store.accounts.push(account);
  saveStore();
  log("account-added", { partition: partitionOf(account.id) }, { account: cleanLabel });
  createView(account);
  switchTo(account.id);
  return account;
}

function switchTo(id: string): void {
  const account = findAccount(id);
  if (!account) return;
  const started = performance.now();
  store.activeId = id;
  saveStore();
  for (const [otherId, runtime] of runtimes) runtime.view?.setVisible(otherId === id);
  runtimes.get(id)?.view?.webContents.focus();
  log("switch", { ms: Number((performance.now() - started).toFixed(1)) }, { account: account.label });
  pushState();
}

function cycleAccounts(step: number): void {
  if (store.accounts.length === 0) return;
  const index = store.accounts.findIndex((account) => account.id === store.activeId);
  const next = (index + step + store.accounts.length) % store.accounts.length;
  switchTo(store.accounts[next].id);
}

function sleepAccount(id: string): void {
  const account = findAccount(id);
  if (!account || account.sleeping) return;
  const runtime = runtimeOf(id);
  if (liveCount(runtime, "getUserMedia:audio") > 0 || liveCount(runtime, "getUserMedia:video") > 0) {
    log("sleep-refused", { reason: "micro ou caméra actifs" }, { account: account.label, level: "warn" });
    return;
  }
  destroyView(id);
  account.sleeping = true;
  runtime.lifecycle = "sleeping";
  runtime.unread = null;
  runtime.memoryMB = null;
  runtime.cpuPercent = null;
  saveStore();
  log("sleep", undefined, { account: account.label });
  updateBadge();
  pushState();
  // Laisser au processus le temps de disparaître avant de mesurer la RAM libérée.
  setTimeout(collectMetrics, 2000);
}

function wakeAccount(id: string): void {
  const account = findAccount(id);
  if (!account || !account.sleeping) return;
  account.sleeping = false;
  saveStore();
  log("wake", undefined, { account: account.label });
  createView(account);
  if (store.activeId === id) switchTo(id);
}

async function removeAccount(id: string): Promise<void> {
  const account = findAccount(id);
  if (!account) return;
  destroyView(id);
  // Vider la session, puis supprimer le dossier au prochain démarrage.
  const ses = session.fromPartition(partitionOf(id));
  try {
    await ses.clearStorageData();
    await ses.clearCache();
  } catch (error) {
    log("clear-storage-failed", String(error), { account: account.label, level: "warn" });
  }
  store.accounts = store.accounts.filter((candidate) => candidate.id !== id);
  store.pendingPartitionDeletion.push(id);
  if (store.activeId === id) store.activeId = store.accounts[0]?.id ?? null;
  runtimes.delete(id);
  saveStore();
  log("account-removed", { note: "dossier de partition supprimé au prochain démarrage" }, { account: account.label });
  updateBadge();
  if (store.activeId) switchTo(store.activeId);
  else pushState();
}

function purgePendingPartitions(): void {
  for (const id of store.pendingPartitionDeletion) {
    const dir = path.join(userDataDir, "Partitions", `wa-${id}`);
    if (!fs.existsSync(dir)) {
      log("partition-missing", { dir }, { level: "warn" });
      continue;
    }
    fs.rmSync(dir, { recursive: true, force: true });
    log("partition-purged", { dir });
  }
  store.pendingPartitionDeletion = [];
  saveStore();
}

// Simule un crash en tuant le processus de rendu (comme le ferait l'OOM killer).
// forcefullyCrashRenderer() n'est pas utilisé : sous Fedora 44 / Electron 44, le
// processus reste bloqué après « Crashing because hung » et render-process-gone
// n'arrive pas (observé pendant la mise en place du lab).
function killRenderer(id: string): void {
  const account = findAccount(id);
  const wc = runtimes.get(id)?.view?.webContents;
  if (!account || !wc || wc.isDestroyed()) return;
  const pid = wc.getOSProcessId();
  log("renderer-kill", { pid }, { account: account.label, level: "warn" });
  process.kill(pid, "SIGKILL");
}

function toggleDevTools(id: string | null): void {
  const wc = runtimes.get(id ?? "")?.view?.webContents;
  if (!wc) return;
  if (wc.isDevToolsOpened()) wc.closeDevTools();
  else wc.openDevTools({ mode: "detach" });
}

function handleShortcut(event: Electron.Event, input: Electron.Input): void {
  if (input.type !== "keyDown") return;
  const ctrlOnly = input.control && !input.alt && !input.meta;
  if (ctrlOnly && /^[1-9]$/.test(input.key)) {
    const account = store.accounts[Number(input.key) - 1];
    if (account) {
      event.preventDefault();
      switchTo(account.id);
    }
  } else if (ctrlOnly && input.key === "Tab") {
    event.preventDefault();
    cycleAccounts(input.shift ? -1 : 1);
  } else if (input.key === "F12") {
    event.preventDefault();
    toggleDevTools(store.activeId);
  }
}

// ---------------------------------------------------------------------------
// Messages du preload WhatsApp
// ---------------------------------------------------------------------------

function accountFromEvent(event: IpcMainEvent): StoredAccount | undefined {
  const id = accountByWebContentsId.get(event.sender.id);
  const account = findAccount(id ?? null);
  if (!account) {
    log("ipc-unknown-sender", { url: event.sender.getURL() }, { level: "warn" });
    return undefined;
  }
  if (originOf(event.senderFrame?.url) !== targetOrigin) {
    log("ipc-unexpected-origin", { url: event.senderFrame?.url }, { account: account.label, level: "warn" });
    return undefined;
  }
  return account;
}

function boundedString(value: unknown, max: number): string | null {
  return typeof value === "string" ? value.slice(0, max) : null;
}

function parseNotify(raw: unknown): NotifyPayload | null {
  if (typeof raw !== "object" || raw === null) return null;
  const candidate = raw as Record<string, unknown>;
  const title = boundedString(candidate.title, 200);
  const body = boundedString(candidate.body, 2000);
  const tag = boundedString(candidate.tag, 200);
  if (!Number.isInteger(candidate.id) || title === null || body === null || tag === null) return null;
  return {
    id: candidate.id as number,
    title,
    body,
    tag,
    hasIcon: candidate.hasIcon === true,
    silent: candidate.silent === true
  };
}

ipcMain.on("wa:notify", (event, raw: unknown) => {
  const account = accountFromEvent(event);
  if (!account) return;
  const payload = parseNotify(raw);
  if (!payload) {
    log("notify-invalid", undefined, { account: account.label, level: "warn" });
    return;
  }
  const runtime = runtimeOf(account.id);
  runtime.notifyCount++;
  runtime.lastNotifyId = payload.id;

  // Le contenu n'est journalisé que sur demande explicite (comptes de test).
  const summary = LOG_CONTENT
    ? { id: payload.id, title: payload.title, body: payload.body, tag: payload.tag }
    : { id: payload.id, titleLength: payload.title.length, bodyLength: payload.body.length, tag: payload.tag };

  if (account.snoozed) {
    log("notification-dropped-snooze", summary, { account: account.label });
    return;
  }
  log("notification", { ...summary, hasIcon: payload.hasIcon, silent: payload.silent }, { account: account.label });

  if (ISOLATED || !Notification.isSupported()) return;
  const notification = new Notification({
    title: `${account.label} — ${payload.title}`,
    body: payload.body,
    silent: payload.silent
  });
  runtime.notifications.set(payload.id, notification);
  notification.on("click", () => {
    log("notification-click", { id: payload.id }, { account: account.label });
    openFromNotification(account.id, payload.id);
  });
  notification.on("close", () => runtime.notifications.delete(payload.id));
  notification.show();
});

function openFromNotification(id: string, notificationId: number): void {
  switchTo(id);
  if (win) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
  runtimes.get(id)?.view?.webContents.send("wa:notification-click", notificationId);
}

ipcMain.on("wa:notification-close", (event, id: unknown) => {
  const account = accountFromEvent(event);
  if (!account || !Number.isInteger(id)) return;
  runtimeOf(account.id).notifications.get(id as number)?.close();
});

ipcMain.on("wa:media", (event, raw: unknown) => {
  const account = accountFromEvent(event);
  if (!account || typeof raw !== "object" || raw === null) return;
  const payload = raw as MediaPayload;
  if (!["getUserMedia", "getDisplayMedia"].includes(payload.source) || !["start", "stop"].includes(payload.event)) return;
  const trackKind = boundedString(payload.trackKind, 20) ?? "unknown";
  const runtime = runtimeOf(account.id);
  const key = `${payload.source}:${trackKind}`;
  const live = Math.max(0, liveCount(runtime, key) + (payload.event === "start" ? 1 : -1));
  runtime.liveTracks.set(key, live);
  log("media", { source: payload.source, event: payload.event, trackKind, live }, { account: account.label });
  pushState();
});

ipcMain.on("wa:env", (event, raw: unknown) => {
  const account = accountFromEvent(event);
  if (!account || typeof raw !== "object" || raw === null) return;
  const env = raw as EnvPayload;
  const runtime = runtimeOf(account.id);
  runtime.envCount++;
  runtime.lastEnv = env;
  const problems: string[] = [];
  if (/Electron/i.test(env.userAgent)) problems.push("User-Agent contient « Electron »");
  if (env.brands.some((brand) => /Electron/i.test(brand))) problems.push("Client Hints contiennent « Electron »");
  if (!env.notificationOverridden) problems.push("window.Notification non remplacé");
  if (env.scriptsBeforeOverride > 0) problems.push(`${env.scriptsBeforeOverride} script(s) de la page avant l’override`);
  log("page-env", { ...env, problems }, { account: account.label, level: problems.length > 0 ? "warn" : "info" });
});

ipcMain.on("wa:visibility", (event, raw: unknown) => {
  const account = accountFromEvent(event);
  if (!account || typeof raw !== "object" || raw === null) return;
  const payload = raw as VisibilityPayload;
  const runtime = runtimeOf(account.id);
  const state = boundedString(payload.state, 20);
  if (state !== runtime.pageVisibility) {
    runtime.pageVisibility = state;
    log("page-visibility", { state, hasFocus: payload.hasFocus === true, shown: account.id === store.activeId }, {
      account: account.label,
      // Une page « visible » alors que le compte est caché = risque d'accusés de lecture.
      level: state === "visible" && account.id !== store.activeId ? "warn" : "info"
    });
    pushState();
  }
});

ipcMain.on("wa:sw-notification", (event, raw: unknown) => {
  const account = accountFromEvent(event);
  if (!account) return;
  const tag = typeof raw === "object" && raw !== null ? boundedString((raw as { tag?: unknown }).tag, 200) : null;
  log("sw-notification", { tag, note: "notification via ServiceWorkerRegistration : non interceptée" }, {
    account: account.label,
    level: "warn"
  });
});

ipcMain.on("wa:preload-error", (event, message: unknown) => {
  const id = accountByWebContentsId.get(event.sender.id);
  log("preload-error", boundedString(message, 500), { account: findAccount(id ?? null)?.label, level: "error" });
});

// ---------------------------------------------------------------------------
// Coque (UI du lab)
// ---------------------------------------------------------------------------

function isShell(event: { sender: WebContents }): boolean {
  return win !== null && event.sender === win.webContents;
}

ipcMain.handle("shell:get-state", (event) => (isShell(event) ? buildState() : null));
ipcMain.handle("shell:get-logs", (event) => (isShell(event) ? recentLogs : []));

ipcMain.on("shell:command", (event, raw: unknown) => {
  if (!isShell(event) || typeof raw !== "object" || raw === null) return;
  const command = raw as { type?: unknown; id?: unknown; label?: unknown };
  const id = typeof command.id === "string" ? command.id : null;
  const account = findAccount(id);
  switch (command.type) {
    case "add":
      addAccount(typeof command.label === "string" ? command.label : "");
      break;
    case "switch":
      if (account) switchTo(account.id);
      break;
    case "sleep":
      if (account) sleepAccount(account.id);
      break;
    case "wake":
      if (account) wakeAccount(account.id);
      break;
    case "reload":
      if (account) runtimes.get(account.id)?.view?.webContents.reload();
      break;
    case "crash":
      if (account) killRenderer(account.id);
      break;
    case "snooze":
      if (account) {
        account.snoozed = !account.snoozed;
        saveStore();
        log(account.snoozed ? "snooze-on" : "snooze-off", undefined, { account: account.label });
        pushState();
      }
      break;
    case "devtools":
      if (account) toggleDevTools(account.id);
      break;
    case "remove":
      if (account) void removeAccount(account.id);
      break;
    case "toggle-logs":
      logsVisible = !logsVisible;
      layoutViews();
      pushState();
      break;
    case "open-logs":
      void shell.openPath(logDir);
      break;
  }
});

function buildState(): ShellState {
  const accounts: AccountView[] = store.accounts.map((account) => {
    const runtime = runtimeOf(account.id);
    return {
      id: account.id,
      label: account.label,
      color: account.color,
      lifecycle: account.sleeping ? "sleeping" : runtime.lifecycle,
      visible: account.id === store.activeId,
      snoozed: account.snoozed,
      unread: runtime.unread,
      pageVisibility: runtime.pageVisibility,
      micActive: liveCount(runtime, "getUserMedia:audio") > 0,
      camActive: liveCount(runtime, "getUserMedia:video") > 0,
      screenShareActive: liveCount(runtime, "getDisplayMedia:video") > 0,
      audible: runtime.audible,
      memoryMB: runtime.memoryMB,
      cpuPercent: runtime.cpuPercent
    };
  });
  return {
    accounts,
    activeId: store.activeId,
    totalUnread: totalUnread(),
    totalMemoryMB,
    logsVisible,
    sidebarWidth: SIDEBAR_WIDTH,
    logHeight: LOG_HEIGHT,
    targetUrl,
    platform: [
      process.env.XDG_CURRENT_DESKTOP,
      process.env.XDG_SESSION_TYPE,
      `Electron ${process.versions.electron}`,
      `Chromium ${process.versions.chrome}`
    ]
      .filter(Boolean)
      .join(" · ")
  };
}

let statePushScheduled = false;
function pushState(): void {
  if (statePushScheduled) return;
  statePushScheduled = true;
  setTimeout(() => {
    statePushScheduled = false;
    sendToShell("lab:state", buildState());
  }, 50);
}

function sendToShell(channel: string, payload: unknown): void {
  if (win && !win.webContents.isDestroyed()) win.webContents.send(channel, payload);
}

function totalUnread(): number {
  let total = 0;
  for (const account of store.accounts) total += runtimeOf(account.id).unread ?? 0;
  return total;
}

function updateBadge(): void {
  const total = totalUnread();
  const supported = app.setBadgeCount(total);
  if (!badgeSupportLogged) {
    badgeSupportLogged = true;
    log("badge-support", { supported, note: "Linux : nécessite l’API Unity LauncherEntry" });
  }
  win?.setTitle(total > 0 ? `(${total}) Feasibility Lab` : "Feasibility Lab");
}

// ---------------------------------------------------------------------------
// Métriques (tests n°8, 11, 20) et événements système (n°18)
// ---------------------------------------------------------------------------

function csvField(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function collectMetrics(): void {
  const metrics = app.getAppMetrics();
  const byPid = new Map(metrics.map((metric) => [metric.pid, metric]));
  const now = new Date().toISOString();
  const totalKB = metrics.reduce((sum, metric) => sum + metric.memory.workingSetSize, 0);
  totalMemoryMB = Math.round(totalKB / 1024);

  const lines: string[] = [];
  for (const account of store.accounts) {
    const runtime = runtimeOf(account.id);
    let pid: number | null = null;
    const wc = runtime.view?.webContents;
    if (wc && !wc.isDestroyed()) {
      try {
        pid = wc.getOSProcessId();
      } catch {
        pid = null;
      }
    }
    const metric = pid ? byPid.get(pid) : undefined;
    runtime.memoryMB = metric ? Math.round(metric.memory.workingSetSize / 1024) : null;
    runtime.cpuPercent = metric ? Math.round(metric.cpu.percentCPUUsage * 10) / 10 : null;
    lines.push([now, account.id, csvField(account.label), pid ?? "", runtime.memoryMB ?? "", runtime.cpuPercent ?? ""].join(","));
  }
  lines.push([now, "TOTAL", "app", "", totalMemoryMB, ""].join(","));
  fs.appendFileSync(metricsFile, lines.join("\n") + "\n");

  const online = net.isOnline();
  if (online !== lastOnline) {
    lastOnline = online;
    log(online ? "network-online" : "network-offline", undefined, { level: online ? "info" : "warn" });
  }
  pushState();
}

function watchSystemEvents(): void {
  powerMonitor.on("suspend", () => log("system-suspend"));
  powerMonitor.on("resume", () => {
    log("system-resume", { online: net.isOnline() });
    // Test n°18 : état des comptes 30 s après le réveil.
    setTimeout(() => {
      log("post-resume-check", {
        online: net.isOnline(),
        accounts: store.accounts.map((account) => ({
          label: account.label,
          lifecycle: account.sleeping ? "sleeping" : runtimeOf(account.id).lifecycle,
          unread: runtimeOf(account.id).unread
        }))
      });
    }, 30_000);
  });
  powerMonitor.on("lock-screen", () => log("screen-locked"));
  powerMonitor.on("unlock-screen", () => log("screen-unlocked"));
}

// ---------------------------------------------------------------------------
// Fausse page WhatsApp (LAB_FAKE / smoke test)
// ---------------------------------------------------------------------------

async function startFakeServer(): Promise<void> {
  const html = fs.readFileSync(path.join(__dirname, "..", "fixtures", "fake-whatsapp.html"));
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end(html);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  targetUrl = `http://127.0.0.1:${port}/`;
  targetOrigin = new URL(targetUrl).origin;
}

// ---------------------------------------------------------------------------
// Fenêtre et démarrage
// ---------------------------------------------------------------------------

async function createWindow(): Promise<void> {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    title: "Feasibility Lab",
    backgroundColor: "#0b141a",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload-shell.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  });
  const shellContents = win.webContents;
  shellContents.setWindowOpenHandler(() => ({ action: "deny" }));
  shellContents.on("will-navigate", (event) => event.preventDefault());
  shellContents.on("before-input-event", handleShortcut);
  shellContents.on("console-message", (event) => {
    if (event.level === "error" || event.level === "warning") {
      log("shell-console", { message: event.message, source: `${event.sourceId}:${event.lineNumber}` }, { level: "error" });
    }
  });
  for (const event of ["resize", "maximize", "unmaximize", "enter-full-screen", "leave-full-screen"] as const) {
    win.on(event as "resize", layoutViews);
  }
  win.on("closed", () => {
    win = null;
  });
  await win.loadFile(path.join(__dirname, "..", "shell", "index.html"));
}

function startAccounts(): void {
  if (!findAccount(store.activeId)) store.activeId = store.accounts[0]?.id ?? null;
  const ordered = [...store.accounts].sort((a, b) => Number(b.id === store.activeId) - Number(a.id === store.activeId));
  let delay = 0;
  for (const account of ordered) {
    if (account.sleeping) {
      runtimeOf(account.id).lifecycle = "sleeping";
      continue;
    }
    // Démarrage échelonné, le dernier compte affiché d'abord.
    setTimeout(() => {
      const current = findAccount(account.id);
      if (current && !current.sleeping) createView(current);
    }, delay);
    delay += STAGGER_MS;
  }
  pushState();
}

const gotLock = ISOLATED || app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });
  app.on("window-all-closed", () => app.quit());

  void app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    if (FAKE) await startFakeServer();
    purgePendingPartitions();
    log("lab-start", {
      electron: process.versions.electron,
      chromium: process.versions.chrome,
      userAgent: UA_OVERRIDE ? chromeUserAgent() : app.userAgentFallback,
      targetUrl,
      userData: userDataDir,
      logFile,
      session: process.env.XDG_SESSION_TYPE ?? null,
      desktop: process.env.XDG_CURRENT_DESKTOP ?? null,
      ozonePlatform: app.commandLine.getSwitchValue("ozone-platform") || "(défaut)",
      permissive: PERMISSIVE,
      logContent: LOG_CONTENT
    });
    await createWindow();
    watchSystemEvents();
    startAccounts();
    setInterval(collectMetrics, METRICS_INTERVAL_MS);
    if (SMOKE) {
      const { runSmoke } = await import("./smoke");
      const ok = await runSmoke({
        addAccount,
        switchTo,
        sleepAccount,
        wakeAccount,
        killRenderer,
        runtimeOf,
        findAccount,
        partitionDir: (id) => path.join(userDataDir, "Partitions", `wa-${id}`),
        shellEval: (code) => (win ? win.webContents.executeJavaScript(code) : Promise.resolve(null)),
        shellErrors: () => recentLogs.filter((entry) => entry.event === "shell-console").length,
        logFile
      });
      // Le dossier temporaire est supprimé par scripts/run-isolated.mjs, après la sortie.
      app.exit(ok ? 0 : 1);
    }
    if (PROBE) {
      const { runProbe } = await import("./probe");
      await runProbe({
        addAccount,
        runtimeOf,
        serviceWorkers: (id) =>
          Object.values(session.fromPartition(partitionOf(id)).serviceWorkers.getAllRunning()).map((worker) => ({
            scope: worker.scope,
            scriptUrl: worker.scriptUrl
          })),
        permissionChecks: (id) => [...runtimeOf(id).permissionChecksSeen],
        recentLogs: () => recentLogs,
        outDir: process.env.LAB_PROBE_OUT ?? process.cwd(),
        uaOverride: UA_OVERRIDE
      });
      app.exit(0);
    }
  });
}

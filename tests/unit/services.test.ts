// Services du processus principal, avec Electron simulé : proxy, voile,
// rapport, menu contextuel, menus du tray.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const keyring = vi.hoisted(() => ({ backend: "gnome_libsecret" }));
vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => keyring.backend,
    // Chiffrement réversible de test : le texte n'apparaît jamais tel quel.
    encryptString: (text: string) => Buffer.from([...Buffer.from(text, "utf8")].map((byte) => byte ^ 0x5a)),
    decryptString: (buffer: Buffer) => Buffer.from([...buffer].map((byte) => byte ^ 0x5a)).toString("utf8")
  },
  app: {},
  clipboard: { writeText: async () => undefined },
  Menu: { buildFromTemplate: () => ({ popup: () => undefined }) }
}));

import { contextMenuTemplate, type ContextMenuTarget } from "../../src/main/desktop/desktop";
import { buildReport } from "../../src/main/diagnostic/report";
import { trayMenu, type MenuItemModel } from "../../src/main/core/menus";
import { trayIconName } from "../../src/main/core/tray";
import { VeilService } from "../../src/main/privacy/veil-service";
import { ProxyService } from "../../src/main/proxy/proxy-service";
import type { ShellState } from "../../src/shared/ipc";
import type { AccountConfig, Preferences, SecurityFile } from "../../src/shared/schemas";
import { defaultPreferences, securityDocument } from "../../src/main/storage/documents";

const A = "4f0c1d2e-3b4a-4c5d-8e6f-7a8b9c0d1e2f";
const B = "5a1b2c3d-4e5f-4a6b-9c7d-8e9f0a1b2c3d";
const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), dir: "/tmp" };
const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
  keyring.backend = "gnome_libsecret";
});

function fakeStore(preferences: Preferences = defaultPreferences()) {
  const data = { preferences, security: securityDocument.defaults() as SecurityFile };
  return {
    get: <K extends "preferences" | "security">(key: K): (typeof data)[K] => data[key],
    update: (key: "preferences" | "security", updater: (current: any) => any) => {
      (data as any)[key] = updater((data as any)[key]);
      return true;
    }
  };
}

function account(id: string, proxy: AccountConfig["proxy"], mode: AccountConfig["proxyMode"] = "manual"): AccountConfig {
  return { id, label: id === A ? "Travail" : "Perso", order: 0, partition: `persist:wa-${id}`, notifications: {} as any, sleeping: false, createdAt: "", lastOpenedAt: "", zoomPercent: 100, permissions: {} as any, proxyMode: mode, proxy, themeHintShown: true };
}

function fakeSession() {
  return { setProxy: vi.fn(async () => undefined), closeAllConnections: vi.fn(async () => undefined), clearAuthCache: vi.fn(async () => undefined) };
}

function service(store: ReturnType<typeof fakeStore>, accounts: AccountConfig[], sessions = new Map<string, ReturnType<typeof fakeSession>>()) {
  const notify = vi.fn();
  const proxy = new ProxyService({
    store: store as any,
    log,
    sessionFor: (id) => {
      if (!sessions.has(id)) sessions.set(id, fakeSession());
      return sessions.get(id) as any;
    },
    account: (id) => accounts.find((candidate) => candidate.id === id),
    accounts: () => accounts,
    pages: () => [],
    accountForPage: (contents: any) => contents?.accountId,
    notifyAuthProblem: notify,
    includeLoopback: false
  });
  cleanups.push(() => proxy.stop());
  return { proxy, notify, sessions };
}

describe("proxy : identifiants", () => {
  it("chiffre les identifiants dans security.json et les relit au démarrage suivant", () => {
    const store = fakeStore();
    const server = { type: "http" as const, host: "proxy.local", port: 3128, auth: true };
    const { proxy } = service(store, [account(A, server)]);
    expect(proxy.setCredentials(A, { username: "alice", password: "s3cr3t-tres-long" })).toBe("saved");
    const stored = JSON.stringify(store.get("security"));
    expect(stored).not.toContain("s3cr3t");
    expect(stored).not.toContain("alice");
    // Nouvelle instance (redémarrage) : rien en mémoire, tout vient du fichier.
    const again = service(store, [account(A, server)]).proxy;
    expect(again.credentials(A)).toEqual({ username: "alice", password: "s3cr3t-tres-long" });
  });

  it("n'écrit rien sans trousseau sécurisé (basic_text) : mémoire seulement", () => {
    keyring.backend = "basic_text";
    const store = fakeStore();
    const { proxy } = service(store, [account(A, { type: "http", host: "p", port: 1, auth: true })]);
    expect(proxy.setCredentials(A, { username: "u", password: "p" })).toBe("memory");
    expect(store.get("security").proxySecrets.accounts[A]).toBeUndefined();
    expect(proxy.credentials(A)).toEqual({ username: "u", password: "p" });
  });

  it("service worker : refuse si deux comptes partagent un proxy avec des identifiants différents", () => {
    const server = { type: "http" as const, host: "gw.example", port: 8080, auth: true };
    const { proxy } = service(fakeStore(), [account(A, server), account(B, server)]);
    proxy.setCredentials(A, { username: "a", password: "1" });
    proxy.setCredentials(B, { username: "b", password: "2" });
    const info = { isProxy: true, scheme: "basic", host: "gw.example", port: 8080, realm: "r" };
    expect(proxy.handleLogin(null, "https://web.whatsapp.com/sw.js", info)).toBeNull();
    // Une page connue reçoit les identifiants de son compte.
    expect(proxy.handleLogin({ accountId: B } as any, "https://web.whatsapp.com/", info)).toEqual({ username: "b", password: "2" });
    // Mêmes identifiants pour les deux : pas d'ambiguïté.
    proxy.setCredentials(B, { username: "a", password: "1" });
    expect(proxy.handleLogin(null, "https://web.whatsapp.com/other.js", info)).toEqual({ username: "a", password: "1" });
  });

  it("la même requête redemandée aussitôt = identifiants refusés ; des requêtes parallèles, non", () => {
    const server = { type: "http" as const, host: "gw.example", port: 8080, auth: true };
    const { proxy, notify } = service(fakeStore(), [account(A, server)]);
    proxy.setCredentials(A, { username: "a", password: "1" });
    const info = { isProxy: true, scheme: "basic", host: "gw.example", port: 8080, realm: "r" };
    const page = { accountId: A } as any;
    expect(proxy.handleLogin(page, "https://web.whatsapp.com/a.js", info)).not.toBeNull();
    expect(proxy.handleLogin(page, "https://web.whatsapp.com/b.js", info)).not.toBeNull();
    expect(notify).not.toHaveBeenCalled();
    expect(proxy.handleLogin(page, "https://web.whatsapp.com/a.js", info)).toBeNull();
    expect(notify).toHaveBeenCalledWith(A, "failed");
  });
});

describe("proxy : relais SOCKS5", () => {
  it("un seul relais pour deux applications simultanées, reconfiguré sur un mot de passe de même longueur", async () => {
    const socks = { type: "socks5" as const, host: "127.0.0.1", port: 1, auth: true };
    const store = fakeStore({ ...defaultPreferences(), proxy: { mode: "manual", server: socks } });
    const accounts = [account(A, null, "inherit"), account(B, null, "inherit")];
    const { proxy, sessions } = service(store, accounts);
    proxy.setCredentials("global", { username: "bob", password: "aaaa" });
    await Promise.all([proxy.apply(A), proxy.apply(B), proxy.apply(A)]);
    const relays = (proxy as any).relays as Map<string, { relay: { setUpstream: (u: unknown) => void } }>;
    expect(relays.size).toBe(1);
    const rules = [...sessions.values()].map((ses) => (ses.setProxy.mock.calls.at(-1) as any)?.[0].proxyRules);
    expect(new Set(rules).size).toBe(1);
    expect(rules[0]).toMatch(/^socks5:\/\/127\.0\.0\.1:\d+$/);

    const entry = relays.get("global");
    const setUpstream = vi.spyOn(entry!.relay, "setUpstream");
    const closed = sessions.get(A)!.closeAllConnections.mock.calls.length;
    proxy.setCredentials("global", { username: "bob", password: "bbbb" });
    await proxy.applyAll();
    expect(setUpstream).toHaveBeenCalledWith(expect.objectContaining({ password: "bbbb" }));
    // Les connexions déjà établies (la websocket de WhatsApp) sont fermées aussi.
    expect(sessions.get(A)!.closeAllConnections.mock.calls.length).toBeGreaterThan(closed);
  });
});

describe("voile : CSS inséré", () => {
  function fakePage() {
    const pending: Array<(key: string) => void> = [];
    const page = {
      id: 7,
      isDestroyed: () => false,
      insertCSS: vi.fn((_css: string) => new Promise<string>((resolve) => pending.push(resolve))),
      removeInsertedCSS: vi.fn(async (_key: string) => undefined),
      send: vi.fn()
    };
    return { page, pending };
  }

  it("une insertion en cours ne prend pas la place de celle d'une page rechargée", async () => {
    const { page, pending } = fakePage();
    const veil = new VeilService({ log, preferences: () => ({ onBlur: false, onScreenShare: false, blurMessages: false }), pages: () => [page as any] });
    veil.toggle();
    await Promise.resolve();
    expect(page.insertCSS).toHaveBeenCalledTimes(1);
    veil.pageLoaded(page as any);
    await Promise.resolve();
    expect(page.insertCSS).toHaveBeenCalledTimes(2);
    pending[0]?.("ancienne");
    await new Promise((resolve) => setTimeout(resolve, 0));
    pending[1]?.("nouvelle");
    await new Promise((resolve) => setTimeout(resolve, 0));
    // L'ancienne feuille (document disparu) est retirée, la nouvelle reste.
    expect(page.removeInsertedCSS.mock.calls.map((call) => call[0])).toEqual(["ancienne"]);
    veil.toggle();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(page.removeInsertedCSS.mock.calls.map((call) => call[0])).toEqual(["ancienne", "nouvelle"]);
  });
});

describe("rapport de diagnostic", () => {
  it("caviarde le journal : noms de comptes (mots entiers), dossier personnel, proxy, e-mails", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rapport-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const logFile = path.join(dir, "app.log");
    fs.writeFileSync(logFile, [`{"event":"x","label":"Travail"}`, `{"path":"${os.homedir()}/Documents/rapport.pdf"}`, `{"proxy":"proxy.corp.example:3128"}`, `{"mail":"marie@example.com"}`, `{"text":"Aujourd'hui avec A"}`].join("\n"));
    const report = buildReport({
      product: "WhatHush",
      versions: { app: "0.2.0" },
      build: null,
      system: {},
      accounts: [
        { label: "Travail", lifecycle: "ready", mode: "normal", sleeping: false, adapterDegraded: false, inCall: false, memoryMB: 200, proxy: "fixed" },
        { label: "A", lifecycle: "ready", mode: "normal", sleeping: false, adapterDegraded: false, inCall: false, memoryMB: 100, proxy: "system" }
      ],
      preferences: {},
      logFile,
      proxyHosts: ["proxy.corp.example"],
      directory: dir,
      now: new Date("2026-10-05T10:00:00Z")
    });
    expect(report).not.toContain("Travail");
    expect(report).toContain('"label":"Account 1"');
    expect(report).toContain('"~/Documents/rapport.pdf"');
    expect(report).not.toContain(os.homedir());
    expect(report).toContain('"[proxy]:3128"');
    expect(report).toContain('"[e-mail]"');
    // « A » ne remplace que le mot A, pas chaque lettre a ; les lignes du rapport restent intactes.
    expect(report).toContain("Aujourd'hui avec Account 2");
    expect(report).toContain("Account 1 : ready");
  });

  it("une seule passe : un compte nommé « Account » ou « Pro » ne réécrit ni le rapport ni les remplacements", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rapport-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const logFile = path.join(dir, "app.log");
    fs.writeFileSync(logFile, `{"a":"Pro","b":"proxy","c":"Account"}\n{"err":"ERR_FAILED loading 'http://127.0.0.1:4000/send?phone=33612345678&text=Rendez-vous'"}\n`);
    const report = buildReport({
      product: "WhatHush", versions: {}, build: null, system: {}, preferences: {}, proxyHosts: [], directory: dir, now: new Date(), logFile,
      accounts: ["Account", "Pro"].map((label) => ({ label, lifecycle: "ready", mode: "normal", sleeping: false, adapterDegraded: false, inCall: false, memoryMB: 1, proxy: "system" }))
    });
    expect(report).toContain('{"a":"Account 2","b":"proxy","c":"Account 1"}');
    expect(report).toContain("Account 1 : ready");
    expect(report).toContain("Account 2 : ready");
    // Lien de conversation : ni numéro ni texte prérempli.
    expect(report).not.toContain("33612345678");
    expect(report).not.toContain("Rendez-vous");
    expect(report).toContain("http://127.0.0.1:4000/send?[…]");
  });
});

describe("menu contextuel", () => {
  const target = (): ContextMenuTarget & Record<string, ReturnType<typeof vi.fn>> =>
    ({ replaceMisspelling: vi.fn(), addWordToDictionary: vi.fn(), pasteAndMatchStyle: vi.fn(), copyImageAt: vi.fn(), downloadURL: vi.fn(), inspectElement: vi.fn(), copyText: vi.fn() }) as any;
  const params = (overrides: object) => ({ misspelledWord: "", dictionarySuggestions: [], isEditable: false, editFlags: { canUndo: true, canRedo: true, canCut: true, canCopy: true, canPaste: true }, selectionText: "", mediaType: "none", srcURL: "", linkURL: "", x: 12, y: 34, ...overrides }) as any;
  const click = (items: any[], label: string) => items.find((item) => item.label === label)?.click();

  it("« Coller comme texte brut » colle sans mise en forme, dans un champ éditable", () => {
    const actions = target();
    const items = contextMenuTemplate(params({ isEditable: true }), actions, { devTools: false, openLink: vi.fn() });
    click(items, "Coller comme texte brut");
    expect(actions.pasteAndMatchStyle).toHaveBeenCalledTimes(1);
    expect(items.find((item) => item.label === "Coller comme texte brut")?.accelerator).toBe("CommandOrControl+Shift+V");
  });

  it("« Copier l'image » copie l'image sous le pointeur", () => {
    const actions = target();
    const items = contextMenuTemplate(params({ mediaType: "image", srcURL: "blob:x" }), actions, { devTools: false, openLink: vi.fn() });
    click(items, "Copier l’image");
    expect(actions.copyImageAt).toHaveBeenCalledWith(12, 34);
    expect(items.some((item) => item.label === "Coller comme texte brut")).toBe(false);
  });
});

describe("menus du tray", () => {
  const base: ShellState = {
    productName: "WhatHush",
    language: "fr",
    localeTag: "fr-FR",
    accounts: [],
    activeId: null,
    totalUnread: 0,
    focus: { profiles: [], activeProfileId: null, until: null },
    sidebarCollapsed: false,
    onboardingDone: true,
    pendingLink: null,
    notices: [],
    trayAvailable: true,
    lock: { enabled: true, locked: false, retryAt: null, failed: false },
    veiled: false,
    nowPlaying: null,
    downloads: { active: 0, progress: null },
    zoomToast: null
  };
  const labels = (items: MenuItemModel[]) => items.map((item) => (item.kind === "separator" ? "—" : item.label));

  it("verrouillé : ni comptes ni lecture, seulement Déverrouiller et Quitter", () => {
    const menu = trayMenu({ ...base, lock: { ...base.lock, locked: true }, nowPlaying: { accountId: A, label: "Travail", playing: true, kind: "audio", title: null } }, new Date());
    expect(labels(menu)).toEqual(["WhatHush", "—", "Déverrouiller", "Quitter"]);
  });

  it("lecture en cours : ligne d'état et Pause, puis Reprendre en pause ; « Verrouiller » si un code existe", () => {
    const playing = trayMenu({ ...base, nowPlaying: { accountId: A, label: "Travail", playing: true, kind: "audio", title: null } }, new Date());
    expect(playing[2]).toEqual({ kind: "label", label: "▶  En cours de lecture — Travail · Message vocal" });
    expect(playing[3]).toMatchObject({ kind: "action", label: "Pause", action: { type: "media", id: A, action: "pause" } });
    const paused = trayMenu({ ...base, nowPlaying: { accountId: A, label: "Travail", playing: false, kind: "audio", title: "Note" } }, new Date());
    expect(paused[3]).toMatchObject({ label: "Reprendre", action: { type: "media", id: A, action: "play" } });
    expect(labels(playing)).toContain("Verrouiller");
    expect(labels(trayMenu({ ...base, lock: { ...base.lock, enabled: false } }, new Date()))).not.toContain("Verrouiller");
  });

  it("chaque icône que le tray peut demander existe, en 1x et en @2x", () => {
    const assets = path.resolve(import.meta.dirname, "../../build/app-assets");
    const names = new Set<string>();
    for (const total of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 99]) for (const style of ["number", "dot", "none"] as const) names.add(trayIconName(total, style));
    for (const name of names) {
      expect(fs.existsSync(path.join(assets, `${name}.png`)), name).toBe(true);
      if (name.startsWith("tray-") && name !== "tray-unread") expect(fs.existsSync(path.join(assets, `${name}@2x.png`)), `${name}@2x`).toBe(true);
    }
  });
});

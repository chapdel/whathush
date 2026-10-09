// EconomyService avec un vrai AccountManager (store sur disque), de fausses vues et
// des minuteurs simulés : endormissement, relèves, notification de synthèse, barre système.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountManager } from "../../src/main/accounts/account-manager";
import { EconomyService } from "../../src/main/accounts/economy-service";
import { CallCoordinator } from "../../src/main/calls/call-coordinator";
import type { Logger } from "../../src/main/log";
import { AppStore } from "../../src/main/storage/app-store";
import type { Economy } from "../../src/shared/schemas";

const silent: Logger = { dir: "", debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };
const MIN = 60_000;

class FakeViews {
  readonly loaded = new Set<string>();
  shownId: string | null = null;
  has = (id: string) => this.loaded.has(id);
  create = (id: string) => void this.loaded.add(id);
  destroy = (id: string) => void this.loaded.delete(id);
  show = (id: string | null) => void (this.shownId = id);
  reload = () => undefined;
  requestLinkState = () => undefined;
  load = () => undefined;
}

let dir: string;
let store: AppStore;
let views: FakeViews;
let accounts: AccountManager;
let economy: EconomyService;
let preferences: Economy;
let windowVisible: boolean;
let digests: Array<{ id: string; unread: number }>;

beforeEach(() => {
  vi.useFakeTimers();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "economy-test-"));
  store = new AppStore(dir, silent);
  views = new FakeViews();
  preferences = { intervalMinutes: 15, inTray: false };
  windowVisible = true;
  digests = [];
  const calls = new CallCoordinator();
  accounts = new AccountManager({
    store,
    views: () => views as never,
    calls,
    sessionFor: () => ({}) as never,
    targetUrl: "https://web.whatsapp.com/",
    log: silent,
    notify: () => undefined,
    pageGone: () => undefined,
    accountGone: () => undefined
  });
  economy = new EconomyService({
    accounts,
    calls,
    playing: () => false,
    preferences: () => preferences,
    windowVisible: () => windowVisible,
    digest: (id, unread) => digests.push({ id, unread }),
    log: silent
  });
});

afterEach(() => {
  economy.stop();
  vi.useRealTimers();
  fs.rmSync(dir, { recursive: true, force: true });
});

function periodic(id: string): void {
  store.update("accounts", (file) => ({ ...file, accounts: file.accounts.map((account) => (account.id === id ? { ...account, delivery: "periodic" } : account)) }));
}

/** Page installée : ses conversations s'affichent. */
const ready = (id: string) => accounts.linkState(id, { linking: false, chats: true });

describe("EconomyService", () => {
  it("compte caché en relèves : endormi après 5 min, relevé toutes les 15 min, rendormi après la relève", () => {
    const a = accounts.add({ label: "A" });
    const b = accounts.add({ label: "B" });
    ready(b.id);
    accounts.switchTo(a.id);
    economy.start(windowVisible);
    // Passé en relèves pendant que l'application tourne.
    periodic(b.id);
    economy.refresh();
    vi.advanceTimersByTime(4 * MIN);
    expect(accounts.isDozing(b.id)).toBe(false);
    vi.advanceTimersByTime(2 * MIN);
    expect(accounts.isDozing(b.id)).toBe(true);
    expect(views.has(b.id)).toBe(false);
    expect(economy.status(b.id)).toMatchObject({ dozing: true, relaying: false });
    expect(economy.status(b.id)?.nextRelayAt).not.toBeNull();

    // Relève : rechargé en arrière-plan, sans être affiché.
    vi.advanceTimersByTime(15 * MIN);
    expect(views.has(b.id)).toBe(true);
    expect(views.shownId).toBe(a.id);
    expect(economy.status(b.id)).toMatchObject({ relaying: true });
    ready(b.id);
    vi.advanceTimersByTime(90_000);
    expect(accounts.isDozing(b.id)).toBe(true);
  });

  it("au démarrage, un compte caché en relèves relève ses messages puis s'endort", () => {
    const a = accounts.add({ label: "A" });
    const b = accounts.add({ label: "B" });
    ready(b.id);
    accounts.switchTo(a.id);
    periodic(b.id);
    economy.start(windowVisible);
    expect(economy.status(b.id)).toMatchObject({ relaying: true });
    vi.advanceTimersByTime(90_000);
    expect(accounts.isDozing(b.id)).toBe(true);
  });

  it("relève sans notification mais avec de nouveaux non-lus : notification de synthèse ; une notification la remplace", () => {
    const a = accounts.add({ label: "A" });
    const b = accounts.add({ label: "B" });
    ready(b.id);
    accounts.switchTo(a.id);
    accounts.titleUpdated(b.id, "(1) WhatsApp");
    periodic(b.id);
    economy.start(windowVisible);
    // Relève de démarrage : endormi une minute après.
    vi.advanceTimersByTime(MIN);
    expect(accounts.isDozing(b.id)).toBe(true);

    /** Jusqu'à la prochaine relève : rechargé en arrière-plan. */
    const nextRelay = () => {
      const next = Date.parse(economy.status(b.id)?.nextRelayAt ?? "");
      vi.advanceTimersByTime(next - Date.now() + 15_000);
      expect(views.has(b.id)).toBe(true);
    };

    nextRelay();
    ready(b.id);
    accounts.titleUpdated(b.id, "(4) WhatsApp");
    vi.advanceTimersByTime(90_000);
    expect(accounts.isDozing(b.id)).toBe(true);
    expect(digests).toEqual([{ id: b.id, unread: 4 }]);

    // Relève suivante : WhatsApp a notifié lui-même, pas de synthèse.
    nextRelay();
    ready(b.id);
    accounts.titleUpdated(b.id, "(6) WhatsApp");
    economy.noteNotification(b.id);
    vi.advanceTimersByTime(90_000);
    expect(accounts.isDozing(b.id)).toBe(true);
    expect(digests).toHaveLength(1);
  });

  it("le compte affiché ne s'endort jamais ; repassé en continu, il se réveille", () => {
    const a = accounts.add({ label: "A" });
    periodic(a.id);
    economy.start(windowVisible);
    vi.advanceTimersByTime(30 * MIN);
    expect(accounts.isDozing(a.id)).toBe(false);

    const b = accounts.add({ label: "B" });
    ready(b.id);
    accounts.switchTo(a.id);
    periodic(b.id);
    economy.refresh();
    vi.advanceTimersByTime(6 * MIN);
    expect(accounts.isDozing(b.id)).toBe(true);
    store.update("accounts", (file) => ({ ...file, accounts: file.accounts.map((account) => (account.id === b.id ? { ...account, delivery: "realtime" } : account)) }));
    economy.refresh();
    vi.advanceTimersByTime(2_000);
    expect(views.has(b.id)).toBe(true);
    expect(accounts.isDozing(b.id)).toBe(false);
  });

  it("compte affiché en relèves au lancement (fenêtre pas encore montrée) : pas de relève fantôme", () => {
    const a = accounts.add({ label: "A" });
    ready(a.id);
    periodic(a.id);
    // La fenêtre ne s'affiche qu'à « ready-to-show », après le démarrage des services.
    windowVisible = false;
    economy.start(true);
    windowVisible = true;
    economy.windowChanged(true);
    expect(economy.status(a.id)).toBeNull();
    vi.advanceTimersByTime(30 * MIN);
    expect(economy.status(a.id)).toBeNull();
    expect(accounts.isDozing(a.id)).toBe(false);
  });

  it("relève interrompue : affiché, le compte reste éveillé ; caché ensuite, il attend 5 min avant de s'endormir", () => {
    const a = accounts.add({ label: "A" });
    const b = accounts.add({ label: "B" });
    ready(b.id);
    accounts.switchTo(a.id);
    periodic(b.id);
    economy.start(windowVisible);
    expect(economy.status(b.id)).toMatchObject({ relaying: true });
    accounts.switchTo(b.id);
    economy.refresh();
    expect(economy.status(b.id)).toBeNull();
    // Affiché longtemps : la durée maximale d'une relève ne compte plus.
    vi.advanceTimersByTime(10 * MIN);
    accounts.switchTo(a.id);
    economy.refresh();
    vi.advanceTimersByTime(4 * MIN);
    expect(accounts.isDozing(b.id)).toBe(false);
    vi.advanceTimersByTime(2 * MIN);
    expect(accounts.isDozing(b.id)).toBe(true);
  });

  it("déconnexion pendant une relève : la relève s'arrête, le compte attend l'utilisateur (QR) sans s'endormir", () => {
    const a = accounts.add({ label: "A" });
    const b = accounts.add({ label: "B" });
    ready(b.id);
    accounts.switchTo(a.id);
    periodic(b.id);
    economy.start(windowVisible);
    vi.advanceTimersByTime(MIN);
    expect(accounts.isDozing(b.id)).toBe(true);
    const next = Date.parse(economy.status(b.id)?.nextRelayAt ?? "");
    vi.advanceTimersByTime(next - Date.now() + 15_000);
    expect(economy.status(b.id)).toMatchObject({ relaying: true });
    // Appareil délié depuis le téléphone : la page affiche le QR code.
    accounts.linkState(b.id, { linking: true, chats: false });
    expect(accounts.runtime(b.id)?.lifecycle).toBe("needs_qr");
    vi.advanceTimersByTime(15_000);
    expect(economy.status(b.id)).toBeNull();
    vi.advanceTimersByTime(30 * MIN);
    expect(accounts.isDozing(b.id)).toBe(false);
    expect(views.has(b.id)).toBe(true);
  });

  it("au démarrage, la relève d'un compte en attente dans la file compte à partir de son vrai chargement", () => {
    const a = accounts.add({ label: "A" });
    const b = accounts.add({ label: "B" });
    const c = accounts.add({ label: "C" });
    periodic(b.id);
    periodic(c.id);
    accounts.switchTo(a.id);
    accounts.flush();
    // Redémarrage : nouveaux gestionnaires sur le même profil ; aucun compte ne finit de
    // charger, la file passe au suivant toutes les 30 s (B à 30 s, C à 60 s).
    economy.stop();
    const fresh = new FakeViews();
    const calls = new CallCoordinator();
    const restarted = new AccountManager({ store, views: () => fresh as never, calls, sessionFor: () => ({}) as never, targetUrl: "https://web.whatsapp.com/", log: silent, notify: () => undefined, pageGone: () => undefined, accountGone: () => undefined });
    economy = new EconomyService({ accounts: restarted, calls, playing: () => false, preferences: () => preferences, windowVisible: () => windowVisible, digest: () => undefined, log: silent });
    restarted.start();
    economy.start(true);
    expect(fresh.has(c.id)).toBe(false);
    vi.advanceTimersByTime(61_000);
    expect(fresh.has(c.id)).toBe(true);
    // Durée maximale (4 min) comptée depuis le chargement de C, pas depuis le lancement.
    vi.advanceTimersByTime(250_000 - 61_000);
    expect(restarted.isDozing(c.id)).toBe(false);
    vi.advanceTimersByTime(305_000 - 250_000);
    expect(restarted.isDozing(c.id)).toBe(true);
  });

  it("économie maximale : 5 min dans la barre système, tous les comptes dorment ; fenêtre affichée, ils reviennent", () => {
    const a = accounts.add({ label: "A" });
    const b = accounts.add({ label: "B" });
    ready(a.id);
    ready(b.id);
    accounts.switchTo(a.id);
    preferences = { intervalMinutes: 60, inTray: true };
    economy.start(windowVisible);
    windowVisible = false;
    economy.windowChanged(false);
    vi.advanceTimersByTime(4 * MIN);
    expect(accounts.isDozing(a.id)).toBe(false);
    vi.advanceTimersByTime(7 * MIN);
    expect(accounts.isDozing(a.id)).toBe(true);
    expect(accounts.isDozing(b.id)).toBe(true);

    windowVisible = true;
    economy.windowChanged(true);
    // Le compte affiché tout de suite, l'autre à son tour.
    expect(views.has(a.id)).toBe(true);
    vi.advanceTimersByTime(2_000);
    expect(views.has(b.id)).toBe(true);
  });
});

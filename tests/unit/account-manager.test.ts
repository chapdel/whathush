// AccountManager avec un vrai store sur disque, de fausses vues et des minuteurs simulés.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountManager } from "../../src/main/accounts/account-manager";
import { CallCoordinator } from "../../src/main/calls/call-coordinator";
import { ADAPTER_TIMEOUT_MS } from "../../src/main/core/adapter";
import type { Logger } from "../../src/main/log";
import { AppStore } from "../../src/main/storage/app-store";
import type { Notice } from "../../src/shared/ipc";

const silent: Logger = { dir: "", debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };

class FakeViews {
  readonly loaded = new Set<string>();
  readonly reloads: string[] = [];
  shownId: string | null = null;
  has = (id: string) => this.loaded.has(id);
  create = (id: string) => void this.loaded.add(id);
  destroy = (id: string) => void this.loaded.delete(id);
  show = (id: string | null) => void (this.shownId = id);
  reload = (id: string) => void this.reloads.push(id);
  load = () => undefined;
}

let dir: string;
let store: AppStore;
let views: FakeViews;
let notices: Notice[];
let clearStorage: () => Promise<void>;
let manager: AccountManager;

beforeEach(() => {
  vi.useFakeTimers();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "account-manager-test-"));
  store = new AppStore(dir, silent);
  views = new FakeViews();
  notices = [];
  clearStorage = async () => undefined;
  manager = new AccountManager({
    store,
    views: () => views as never,
    calls: new CallCoordinator(),
    sessionFor: () => ({ clearStorageData: () => clearStorage(), clearCache: async () => undefined }) as never,
    targetUrl: "https://web.whatsapp.com/",
    log: silent,
    notify: (notice) => notices.push(notice),
    pageGone: () => undefined,
    accountGone: () => undefined
  });
});

afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(dir, { recursive: true, force: true });
});

const lifecycle = (id: string) => manager.runtime(id)?.lifecycle;

describe("AccountManager — correctifs de la revue", () => {
  it("n°2 : hors ligne avec un adaptateur muet, un rechargement réussi reconnecte le compte", () => {
    const { id } = manager.add({ label: "Travail" });
    manager.finishedLoad(id);
    vi.advanceTimersByTime(ADAPTER_TIMEOUT_MS);
    expect(lifecycle(id)).toBe("ready");

    manager.networkChanged(false);
    expect(lifecycle(id)).toBe("offline");
    manager.networkChanged(true);
    expect(views.reloads).toContain(id);
    manager.finishedLoad(id);
    vi.advanceTimersByTime(ADAPTER_TIMEOUT_MS);
    expect(lifecycle(id)).toBe("ready");
  });

  it("n°2 : un échec de chargement annule le délai de l'adaptateur", () => {
    const { id } = manager.add({ label: "Travail" });
    manager.finishedLoad(id);
    manager.failedLoad(id, -106, "ERR_INTERNET_DISCONNECTED");
    vi.advanceTimersByTime(ADAPTER_TIMEOUT_MS);
    expect(lifecycle(id)).toBe("offline");
  });

  it("n°5 : compte ajouté hors ligne puis QR affiché : pas d'avertissement de déconnexion", () => {
    const { id } = manager.add({ label: "Nouveau" });
    manager.failedLoad(id, -106, "ERR_INTERNET_DISCONNECTED");
    manager.linkState(id, { linking: true, chats: false });
    expect(lifecycle(id)).toBe("needs_qr");
    expect(notices.filter((notice) => notice.id.startsWith("logout-"))).toEqual([]);
  });

  it("n°5 : un compte connecté qui retombe sur le QR est bien signalé déconnecté", () => {
    const { id } = manager.add({ label: "Travail" });
    manager.linkState(id, { linking: false, chats: true });
    manager.linkState(id, { linking: true, chats: false });
    expect(lifecycle(id)).toBe("needs_qr");
    expect(notices.map((notice) => notice.id)).toContain(`logout-${id}`);
  });

  it("n°4 : réveiller un compte caché remet à zéro le compteur de veille automatique", () => {
    const a = manager.add({ label: "A" });
    const b = manager.add({ label: "B" });
    manager.switchTo(a.id);
    vi.advanceTimersByTime(2 * 60 * 60_000);
    manager.sleep(b.id);
    const before = Date.now();
    manager.wake(b.id);
    expect(manager.hiddenSince(b.id)).toBeGreaterThanOrEqual(before);
  });

  it("n°9 : une bascule n'écrit pas sur le disque ; l'écriture est regroupée", () => {
    const a = manager.add({ label: "A" });
    const b = manager.add({ label: "B" });
    vi.advanceTimersByTime(5000);
    const file = path.join(dir, "accounts.json");
    const before = fs.readFileSync(file, "utf8");
    vi.advanceTimersByTime(60_000);
    manager.switchTo(a.id);
    manager.switchTo(b.id);
    manager.switchTo(a.id);
    expect(fs.readFileSync(file, "utf8")).toBe(before);
    manager.flush();
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(saved.accounts.find((account: { id: string }) => account.id === a.id).lastOpenedAt).toBe(new Date(Date.now()).toISOString());
  });

  it("revue n°5 : pendant le nettoyage asynchrone, le compte supprimé n'existe déjà plus", async () => {
    const { id } = manager.add({ label: "Ancien" });
    let release: () => void = () => undefined;
    clearStorage = () => new Promise<void>((resolve) => (release = resolve));
    const removal = manager.remove(id);
    expect(manager.account(id)).toBeUndefined();
    manager.wake(id);
    manager.switchTo(id);
    expect(views.has(id)).toBe(false);
    release();
    await removal;
    expect(JSON.parse(fs.readFileSync(path.join(dir, "accounts.json"), "utf8")).pendingPartitionDeletion).toEqual([id]);
  });
});

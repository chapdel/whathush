// AccountManager avec un vrai store sur disque, de fausses vues et des minuteurs simulés.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountManager, QUEUE_MAX_WAIT_MS, RESTORE_FALLBACK_MS, UNREAD_HOLD_MS } from "../../src/main/accounts/account-manager";
import { CallCoordinator } from "../../src/main/calls/call-coordinator";
import { ADAPTER_TIMEOUT_MS } from "../../src/main/core/adapter";
import type { Logger } from "../../src/main/log";
import { AppStore } from "../../src/main/storage/app-store";
import type { Notice } from "../../src/shared/ipc";

const silent: Logger = { dir: "", debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };

class FakeViews {
  readonly loaded = new Set<string>();
  readonly created: string[] = [];
  readonly reloads: string[] = [];
  readonly linkRequests: string[] = [];
  shownId: string | null = null;
  has = (id: string) => this.loaded.has(id);
  create = (id: string) => {
    this.loaded.add(id);
    this.created.push(id);
  };
  destroy = (id: string) => void this.loaded.delete(id);
  show = (id: string | null) => void (this.shownId = id);
  reload = (id: string) => void this.reloads.push(id);
  requestLinkState = (id: string) => void this.linkRequests.push(id);
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
  it("n°2 : hors ligne avec un adaptateur muet, le retour du réseau reconnecte le compte sans le recharger", () => {
    const { id } = manager.add({ label: "Travail" });
    manager.finishedLoad(id);
    vi.advanceTimersByTime(ADAPTER_TIMEOUT_MS);
    expect(lifecycle(id)).toBe("ready");

    manager.networkChanged(false);
    expect(lifecycle(id)).toBe("offline");
    manager.networkChanged(true);
    expect(lifecycle(id)).toBe("ready");
    expect(views.reloads).toEqual([]);
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

describe("AccountManager — ressources", () => {
  const ids = () => manager.accounts().map((account) => account.id);

  /** Trois comptes enregistrés, puis un démarrage à froid de l'application. */
  function restart(options: { deferMs?: number } = {}): string[] {
    manager.add({ label: "A" });
    manager.add({ label: "B" });
    manager.add({ label: "C" });
    manager.flush();
    views = new FakeViews();
    manager = new AccountManager({
      store,
      views: () => views as never,
      calls: new CallCoordinator(),
      sessionFor: () => ({}) as never,
      targetUrl: "https://web.whatsapp.com/",
      log: silent,
      notify: (notice) => notices.push(notice),
      pageGone: () => undefined,
      accountGone: () => undefined
    });
    manager.start(options);
    return ids();
  }

  it("démarre les comptes un par un : le suivant quand le précédent est installé, au plus tard après 30 s", () => {
    const [a, b, c] = restart() as [string, string, string];
    const active = manager.active();
    expect(views.created).toEqual([active]);
    // Le compte affiché a affiché ses conversations : le suivant démarre peu après.
    manager.linkState(active!, { linking: false, chats: true });
    vi.advanceTimersByTime(2000);
    expect(views.created).toHaveLength(2);
    // Le deuxième ne répond pas : le troisième n'attend pas plus de 30 s.
    vi.advanceTimersByTime(QUEUE_MAX_WAIT_MS);
    expect(new Set(views.created)).toEqual(new Set([a, b, c]));
  });

  it("sessions effacées pendant un chargement de la file : le compte affiché est rechargé aussitôt", async () => {
    restart();
    const active = manager.active() as string;
    expect(views.created).toEqual([active]);
    await manager.resetAllSessions();
    expect(views.created.filter((id) => id === active)).toHaveLength(2);
    // Les autres attendent leur tour en « chargement », et se chargent si on les affiche.
    const waiting = ids().find((id) => id !== active && !views.has(id)) as string;
    expect(lifecycle(waiting)).toBe("loading");
    manager.switchTo(waiting);
    expect(views.has(waiting)).toBe(true);
  });

  it("un compte encore dans la file se charge dès qu'on l'affiche ou qu'on le recharge, sans attendre son tour", () => {
    restart();
    const active = manager.active() as string;
    const [first, second] = ids().filter((id) => id !== active) as [string, string];
    expect(views.created).toEqual([active]);
    manager.switchTo(first);
    expect(views.created).toEqual([active, first]);
    expect(views.shownId).toBe(first);
    manager.reload(second);
    expect(views.created).toEqual([active, first, second]);
    // La file ne les recharge pas une seconde fois.
    vi.advanceTimersByTime(3 * QUEUE_MAX_WAIT_MS);
    expect(views.created).toHaveLength(3);
  });

  it("lancement dans la barre système : rien n'est chargé avant le délai, sauf si la fenêtre s'affiche", () => {
    restart({ deferMs: 20_000 });
    expect(views.created).toEqual([]);
    manager.expedite();
    expect(views.created).toEqual([manager.active()]);
  });

  it("réseau revenu : une page chargée redonne son état sans rechargement, rechargée seulement si elle se tait", () => {
    const { id } = manager.add({ label: "Travail" });
    manager.linkState(id, { linking: false, chats: true });
    manager.networkChanged(false);
    expect(lifecycle(id)).toBe("offline");
    manager.networkChanged(true);
    expect(views.linkRequests).toEqual([id]);
    expect(views.reloads).toEqual([]);
    manager.linkState(id, { linking: false, chats: true });
    expect(lifecycle(id)).toBe("ready");
    vi.advanceTimersByTime(RESTORE_FALLBACK_MS);
    expect(views.reloads).toEqual([]);

    // Sans réponse de la page : rechargée après le délai de secours.
    manager.networkChanged(false);
    manager.networkChanged(true);
    vi.advanceTimersByTime(RESTORE_FALLBACK_MS);
    expect(views.reloads).toEqual([id]);
  });

  it("réseau revenu après un échec de chargement : la page est rechargée", () => {
    const { id } = manager.add({ label: "Travail" });
    manager.failedLoad(id, -106, "ERR_INTERNET_DISCONNECTED");
    manager.networkChanged(true);
    expect(views.reloads).toEqual([id]);
    expect(views.linkRequests).toEqual([]);
  });

  it("personne devant la fenêtre : la vue est masquée, puis réaffichée", () => {
    const { id } = manager.add({ label: "Travail" });
    expect(views.shownId).toBe(id);
    manager.setAttended(false);
    expect(views.shownId).toBeNull();
    manager.setAttended(true);
    expect(views.shownId).toBe(id);
  });

  it("mode économie : endormi sans perdre ses non-lus, rechargé à la relève, réveillé dès qu'on l'affiche", () => {
    const a = manager.add({ label: "A" });
    const b = manager.add({ label: "B" });
    manager.switchTo(a.id);
    manager.titleUpdated(b.id, "(3) WhatsApp");
    expect(manager.doze(b.id)).toBe(true);
    expect(views.has(b.id)).toBe(false);
    expect(manager.isDozing(b.id)).toBe(true);
    expect(manager.runtime(b.id)).toMatchObject({ lifecycle: "sleeping", unread: 3 });
    // Rien n'est écrit : le compte n'est pas « en veille » pour l'utilisateur.
    expect(manager.account(b.id)?.sleeping).toBe(false);

    manager.relay(b.id);
    expect(views.has(b.id)).toBe(true);
    expect(manager.isDozing(b.id)).toBe(false);
    expect(manager.runtime(b.id)?.unread).toBe(3);

    manager.doze(b.id);
    manager.switchTo(b.id);
    expect(views.has(b.id)).toBe(true);
    expect(views.shownId).toBe(b.id);
  });

  it("relève : les non-lus gardés ne passent pas par 0 pendant le chargement ; la page fait foi ensuite", () => {
    const a = manager.add({ label: "A" });
    const b = manager.add({ label: "B" });
    manager.switchTo(a.id);
    manager.titleUpdated(b.id, "(3) WhatsApp");
    manager.doze(b.id);
    manager.relay(b.id);
    // Premier titre de la page, sans compte : rien ne change (badge stable).
    manager.titleUpdated(b.id, "WhatsApp");
    expect(manager.runtime(b.id)?.unread).toBe(3);
    manager.titleUpdated(b.id, "(5) WhatsApp");
    expect(manager.runtime(b.id)?.unread).toBe(5);

    // Tout lu depuis le téléphone : la page installée ne montre plus de compte, et le dit.
    manager.doze(b.id);
    manager.relay(b.id);
    manager.titleUpdated(b.id, "WhatsApp");
    manager.linkState(b.id, { linking: false, chats: true });
    expect(manager.runtime(b.id)?.unread).toBe(5);
    vi.advanceTimersByTime(UNREAD_HOLD_MS);
    expect(manager.runtime(b.id)?.unread).toBe(0);
  });

  it("jamais d'économie pendant un appel ; une veille manuelle l'emporte", () => {
    const calls = new CallCoordinator();
    manager = new AccountManager({
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
    const a = manager.add({ label: "A" });
    calls.onMedia(a.id, 1, { source: "getUserMedia", event: "start", trackKind: "audio" });
    expect(manager.doze(a.id)).toBe(false);
    calls.resetAccount(a.id);
    manager.sleep(a.id);
    manager.relay(a.id);
    expect(views.has(a.id)).toBe(false);
  });

  it("recyclage : la page est recréée, non-lus conservés", () => {
    const { id } = manager.add({ label: "Travail" });
    manager.titleUpdated(id, "(2) WhatsApp");
    const before = views.created.length;
    manager.recycle(id);
    expect(views.created.length).toBe(before + 1);
    expect(manager.runtime(id)).toMatchObject({ lifecycle: "loading", unread: 2 });
    expect(manager.isDozing(id)).toBe(false);
  });
});

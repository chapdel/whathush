// AccountManager (§2, §7 à §9, §16, §32 à §34) : cycle de vie runtime des comptes.
// Il applique la machine à états pure, pilote les vues et réagit aux signaux
// des pages (titre, adaptateur, crash, échec de chargement).

import { EventEmitter } from "node:events";
import type { RenderProcessGoneDetails, Session } from "electron";
import type { LinkStatePayload, Notice } from "../../shared/ipc";
import type { AccountConfig } from "../../shared/schemas";
import { addAccount, accountsInOrder, removeAccount, type NewAccountInput } from "../core/accounts";
import { ADAPTER_TIMEOUT_MS, adapterTimeoutEvent, linkStateEvent } from "../core/adapter";
import { onRendererGone, transition, type Lifecycle, type LifecycleEvent } from "../core/lifecycle";
import type { Logger } from "../log";
import type { AppStore } from "../storage/app-store";
import type { CallCoordinator } from "../calls/call-coordinator";
import type { ViewEvents, ViewManager } from "../views/view-manager";

const STAGGER_MS = 1500;
/** lastOpenedAt est regroupé : une bascule ne doit pas écrire sur le disque. */
const LAST_OPENED_FLUSH_MS = 3000;
/** §34 : nouvelle tentative de chargement d'un compte hors ligne. */
const OFFLINE_RETRY_MS = [5_000, 15_000, 30_000, 60_000];

interface Runtime {
  lifecycle: Lifecycle;
  unread: number | null;
  audible: boolean;
  crashTimes: number[];
  hiddenSince: number | null;
  adapterTimer: NodeJS.Timeout | null;
  recreateTimer: NodeJS.Timeout | null;
  offlineTimer: NodeJS.Timeout | null;
  offlineAttempts: number;
  adapterDegraded: boolean;
  /** Connecté au moins une fois pendant cette session (§2.1, déconnexion à distance). */
  wasLinked: boolean;
}

export interface AccountManagerDeps {
  store: AppStore;
  views: () => ViewManager;
  calls: CallCoordinator;
  sessionFor(accountId: string): Session;
  targetUrl: string;
  log: Logger;
  notify(notice: Notice): void;
  /** Une page a navigué ou disparu : ses notifications et ses pistes média aussi. */
  pageGone(accountId: string, webContentsId: number): void;
  /** Toutes les pages du compte ont disparu (veille, suppression, crash). */
  accountGone(accountId: string): void;
  now?: () => number;
}

export class AccountManager extends EventEmitter<{ changed: [] }> implements ViewEvents {
  private readonly runtimes = new Map<string, Runtime>();
  private activeId: string | null = null;
  private modalOpen = false;
  private readonly now: () => number;
  private readonly lastOpened = new Map<string, string>();
  private lastOpenedTimer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: AccountManagerDeps) {
    super();
    this.now = deps.now ?? Date.now;
  }

  // --- Lecture -------------------------------------------------------------------

  accounts(): AccountConfig[] {
    return accountsInOrder(this.deps.store.get("accounts"));
  }

  account(id: string): AccountConfig | undefined {
    return this.deps.store.get("accounts").accounts.find((account) => account.id === id);
  }

  runtime(id: string): Readonly<Runtime> | undefined {
    return this.runtimes.get(id);
  }

  active(): string | null {
    return this.activeId;
  }

  private runtimeOf(id: string): Runtime {
    let runtime = this.runtimes.get(id);
    if (!runtime) {
      runtime = {
        lifecycle: "sleeping",
        unread: null,
        audible: false,
        crashTimes: [],
        hiddenSince: this.now(),
        adapterTimer: null,
        recreateTimer: null,
        offlineTimer: null,
        offlineAttempts: 0,
        adapterDegraded: false,
        wasLinked: false
      };
      this.runtimes.set(id, runtime);
    }
    return runtime;
  }

  private clearTimers(runtime: Runtime): void {
    for (const key of ["adapterTimer", "recreateTimer", "offlineTimer"] as const) {
      const timer = runtime[key];
      if (timer) clearTimeout(timer);
      runtime[key] = null;
    }
  }

  // --- Démarrage (§33) ----------------------------------------------------------------

  start(): void {
    const accounts = this.accounts();
    const lastOpened = [...accounts].sort((a, b) => b.lastOpenedAt.localeCompare(a.lastOpenedAt))[0];
    this.activeId = lastOpened?.id ?? null;

    // Le dernier compte affiché d'abord, puis les autres, échelonnés (§17).
    const ordered = [...accounts].sort((a, b) => Number(b.id === this.activeId) - Number(a.id === this.activeId));
    let delay = 0;
    for (const account of ordered) {
      const runtime = this.runtimeOf(account.id);
      if (account.sleeping) continue;
      // En attente de son tour : « chargement », pas « en veille ».
      runtime.lifecycle = "loading";
      const create = () => {
        const current = this.account(account.id);
        if (current && !current.sleeping) this.load(current.id);
      };
      if (delay === 0) create();
      else setTimeout(create, delay);
      delay += STAGGER_MS;
    }
    this.refreshVisibility();
    this.emit("changed");
  }

  // --- Événements de cycle de vie -------------------------------------------------------

  private apply(id: string, event: LifecycleEvent): void {
    const runtime = this.runtimeOf(id);
    const next = transition(runtime.lifecycle, event);
    if (!next) {
      this.deps.log.debug("lifecycle-ignored", { id, from: runtime.lifecycle, event });
      return;
    }
    this.deps.log.info("lifecycle", { id, from: runtime.lifecycle, event, to: next });
    runtime.lifecycle = next;
    if (next === "ready") runtime.wasLinked = true;
    if (next !== "loading" && runtime.adapterTimer) {
      clearTimeout(runtime.adapterTimer);
      runtime.adapterTimer = null;
    }
    if (next !== "offline") {
      if (runtime.offlineTimer) clearTimeout(runtime.offlineTimer);
      runtime.offlineTimer = null;
      runtime.offlineAttempts = 0;
    }
    if (event === "remote-logout") {
      runtime.wasLinked = false;
      const label = this.account(id)?.label ?? "Un compte";
      this.deps.notify({ id: `logout-${id}`, level: "warning", message: `« ${label} » a été déconnecté. Scannez de nouveau le QR code pour le relier.` });
    }
    this.refreshVisibility();
    this.emit("changed");
  }

  private load(id: string): void {
    if (!this.account(id)) return;
    const runtime = this.runtimeOf(id);
    const views = this.deps.views();
    if (views.has(id)) return;
    if (runtime.lifecycle === "sleeping") this.apply(id, "wake");
    else if (runtime.lifecycle === "crashed") this.apply(id, "recreate");
    runtime.unread = null;
    runtime.audible = false;
    this.deps.accountGone(id);
    views.create(id, this.deps.targetUrl);
    this.refreshVisibility();
  }

  /** §34 : recharger un compte hors ligne, avec un délai croissant. */
  private scheduleOfflineRetry(id: string): void {
    const runtime = this.runtimeOf(id);
    if (runtime.offlineTimer || runtime.lifecycle !== "offline") return;
    const delay = OFFLINE_RETRY_MS[Math.min(runtime.offlineAttempts, OFFLINE_RETRY_MS.length - 1)] ?? 60_000;
    runtime.offlineTimer = setTimeout(() => {
      runtime.offlineTimer = null;
      if (runtime.lifecycle !== "offline" || !this.account(id)) return;
      runtime.offlineAttempts += 1;
      this.deps.log.info("offline-retry", { id, attempt: runtime.offlineAttempts });
      this.deps.views().reload(id);
    }, delay);
  }

  // --- ViewEvents ---------------------------------------------------------------------

  titleUpdated(id: string, title: string): void {
    const match = /^\((\d+)\)/.exec(title);
    const unread = match ? Number(match[1]) : 0;
    const runtime = this.runtimeOf(id);
    if (runtime.unread !== unread) {
      runtime.unread = unread;
      this.emit("changed");
    }
  }

  finishedLoad(id: string): void {
    const runtime = this.runtimeOf(id);
    if (runtime.adapterTimer) clearTimeout(runtime.adapterTimer);
    // §35 : si l'adaptateur ne dit rien après un chargement réussi, on considère le
    // compte connecté, ou de nouveau en ligne (mode dégradé). Un échec de chargement
    // annule ce délai.
    runtime.adapterTimer = setTimeout(() => {
      runtime.adapterTimer = null;
      const event = adapterTimeoutEvent(runtime.lifecycle);
      if (event) {
        runtime.adapterDegraded = true;
        this.deps.log.warn("adapter-timeout", { id, event });
        this.apply(id, event);
      }
    }, ADAPTER_TIMEOUT_MS);
  }

  failedLoad(id: string, errorCode: number, description: string): void {
    this.deps.log.warn("load-failed", { id, errorCode, description });
    const runtime = this.runtimeOf(id);
    if (runtime.adapterTimer) clearTimeout(runtime.adapterTimer);
    runtime.adapterTimer = null;
    if (runtime.lifecycle === "loading" || runtime.lifecycle === "ready") this.apply(id, "network-lost");
    this.scheduleOfflineRetry(id);
  }

  rendererGone(id: string, details: RenderProcessGoneDetails): void {
    const runtime = this.runtimeOf(id);
    this.deps.log.error("renderer-gone", { id, reason: details.reason, exitCode: details.exitCode });
    this.deps.views().destroy(id);
    this.deps.accountGone(id);
    this.apply(id, "renderer-gone");

    const { crashTimes, decision } = onRendererGone(runtime.crashTimes, this.now());
    runtime.crashTimes = crashTimes;
    if (decision.action === "give-up") {
      const label = this.account(id)?.label ?? "Un compte";
      this.deps.notify({ id: `crash-${id}`, level: "error", message: `« ${label} » a planté plusieurs fois de suite. Utilisez « Recharger » pour réessayer.` });
      return;
    }
    runtime.recreateTimer = setTimeout(() => {
      runtime.recreateTimer = null;
      const account = this.account(id);
      if (account && !account.sleeping && runtime.lifecycle === "crashed") this.load(id);
    }, decision.delayMs);
  }

  audioChanged(id: string, audible: boolean): void {
    this.runtimeOf(id).audible = audible;
    this.emit("changed");
  }

  unresponsive(id: string, unresponsive: boolean): void {
    this.deps.log.warn(unresponsive ? "unresponsive" : "responsive", { id });
  }

  pageGone(id: string, webContentsId: number): void {
    this.deps.pageGone(id, webContentsId);
  }

  linkState(id: string, signal: LinkStatePayload): void {
    const runtime = this.runtimeOf(id);
    const event = linkStateEvent(runtime.lifecycle, signal, runtime.wasLinked);
    if (event) this.apply(id, event);
  }

  networkChanged(online: boolean): void {
    for (const [id, runtime] of this.runtimes) {
      if (online && runtime.lifecycle === "offline") {
        // Recharger : WhatsApp revient plus vite qu'en attendant sa propre reconnexion.
        this.deps.views().reload(id);
      } else if (!online && runtime.lifecycle === "ready") {
        this.apply(id, "network-lost");
      }
    }
  }

  /** §34 : au réveil du PC, recharger les comptes restés hors ligne. */
  resumed(): void {
    for (const [id, runtime] of this.runtimes) {
      if (runtime.lifecycle === "offline") this.deps.views().reload(id);
    }
  }

  // --- Actions -----------------------------------------------------------------------------

  add(input: NewAccountInput): AccountConfig {
    let created: AccountConfig | undefined;
    const saved = this.deps.store.update("accounts", (file) => {
      const result = addAccount(file, input, new Date(this.now()));
      created = result.account;
      return result.file;
    });
    if (!saved || !created) throw new Error("configuration en lecture seule : compte non créé");
    this.deps.log.info("account-added", { id: created.id });
    this.runtimeOf(created.id);
    this.load(created.id);
    this.switchTo(created.id);
    return created;
  }

  async remove(id: string): Promise<void> {
    if (!this.account(id)) return;
    // D'abord le store : pendant le nettoyage asynchrone, le compte n'existe plus
    // pour personne (clic, démarrage échelonné, lien en attente).
    if (!this.deps.store.update("accounts", (file) => removeAccount(file, id))) return;
    const runtime = this.runtimes.get(id);
    if (runtime) this.clearTimers(runtime);
    this.runtimes.delete(id);
    this.deps.views().destroy(id);
    this.deps.accountGone(id);
    if (this.activeId === id) this.activeId = this.accounts()[0]?.id ?? null;
    this.refreshVisibility();
    this.emit("changed");
    this.deps.log.info("account-removed", { id });

    // §8 : vider la session maintenant, supprimer le dossier au prochain démarrage.
    const ses = this.deps.sessionFor(id);
    try {
      await ses.clearStorageData();
      await ses.clearCache();
    } catch (error) {
      this.deps.log.warn("clear-storage-failed", { id, error: String(error) });
    }
  }

  switchTo(id: string): void {
    if (!this.account(id)) return;
    const previous = this.activeId;
    if (previous && previous !== id) this.runtimeOf(previous).hiddenSince = this.now();
    this.activeId = id;
    this.runtimeOf(id).hiddenSince = null;
    this.lastOpened.set(id, new Date(this.now()).toISOString());
    if (!this.lastOpenedTimer) this.lastOpenedTimer = setTimeout(() => this.flush(), LAST_OPENED_FLUSH_MS);
    this.refreshVisibility();
    this.emit("changed");
  }

  /** Enregistre les lastOpenedAt en attente (aussi appelé à la fermeture). */
  flush(): void {
    if (this.lastOpenedTimer) clearTimeout(this.lastOpenedTimer);
    this.lastOpenedTimer = null;
    if (this.lastOpened.size === 0) return;
    const pending = new Map(this.lastOpened);
    this.lastOpened.clear();
    this.deps.store.update("accounts", (file) => ({
      ...file,
      accounts: file.accounts.map((account) => {
        const openedAt = pending.get(account.id);
        return openedAt ? { ...account, lastOpenedAt: openedAt } : account;
      })
    }));
  }

  cycle(step: number): void {
    const accounts = this.accounts();
    if (accounts.length === 0) return;
    const index = accounts.findIndex((account) => account.id === this.activeId);
    const next = accounts[(index + step + accounts.length) % accounts.length];
    if (next) this.switchTo(next.id);
  }

  switchToShortcut(position: number): void {
    const account = this.accounts()[position - 1];
    if (account) this.switchTo(account.id);
  }

  /** §16 : refusé pendant un appel. */
  sleep(id: string): boolean {
    const account = this.account(id);
    if (!account || account.sleeping) return false;
    if (this.deps.calls.inCall(id)) {
      this.deps.log.warn("sleep-refused-in-call", { id });
      return false;
    }
    const runtime = this.runtimeOf(id);
    this.clearTimers(runtime);
    this.deps.views().destroy(id);
    this.deps.accountGone(id);
    this.deps.store.update("accounts", (file) => ({
      ...file,
      accounts: file.accounts.map((candidate) => (candidate.id === id ? { ...candidate, sleeping: true } : candidate))
    }));
    this.apply(id, "sleep");
    runtime.unread = null;
    runtime.audible = false;
    this.emit("changed");
    return true;
  }

  wake(id: string): void {
    const account = this.account(id);
    if (!account) return;
    if (account.sleeping) {
      this.deps.store.update("accounts", (file) => ({
        ...file,
        accounts: file.accounts.map((candidate) => (candidate.id === id ? { ...candidate, sleeping: false } : candidate))
      }));
    }
    // La veille automatique compte à partir du réveil, pas de la dernière fois
    // où le compte a été affiché (il se rendormirait aussitôt).
    this.runtimeOf(id).hiddenSince = id === this.activeId ? null : this.now();
    this.load(id);
    this.emit("changed");
  }

  /** Recharger WhatsApp, ou recréer la vue après un crash abandonné. */
  reload(id: string): void {
    const runtime = this.runtimeOf(id);
    if (runtime.lifecycle === "crashed") {
      runtime.crashTimes = [];
      this.load(id);
    } else if (this.deps.views().has(id)) {
      this.deps.views().reload(id);
    }
  }

  /**
   * Ouvre une URL WhatsApp (lien de conversation, §23) dans un compte. Refusé
   * pendant un appel : recharger la page couperait l'appel.
   */
  openUrl(id: string, url: string): boolean {
    const account = this.account(id);
    if (!account) return false;
    if (this.deps.calls.inCall(id)) {
      this.deps.notify({ id: `link-in-call-${id}`, level: "info", message: `Un appel est en cours sur « ${account.label} » : terminez-le avant d’ouvrir ce lien.` });
      return false;
    }
    if (account.sleeping || !this.deps.views().has(id)) this.wake(id);
    this.deps.views().load(id, url);
    this.switchTo(id);
    return true;
  }

  setModal(open: boolean): void {
    this.modalOpen = open;
    this.refreshVisibility();
  }

  /** La vue du compte actif est affichée s'il en a une et qu'aucune modale n'est ouverte. */
  refreshVisibility(): void {
    const id = this.activeId;
    const views = this.deps.views();
    views.show(id && !this.modalOpen && views.has(id) ? id : null);
  }

  /** Comptes cachés et depuis quand, pour la veille automatique (§17). */
  hiddenSince(id: string): number | null {
    return id === this.activeId ? null : this.runtimeOf(id).hiddenSince;
  }
}

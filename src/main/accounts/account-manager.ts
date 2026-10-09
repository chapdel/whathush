// AccountManager : cycle de vie runtime des comptes.
// Il applique la machine à états pure, pilote les vues et réagit aux signaux
// des pages (titre, adaptateur, crash, échec de chargement).
// Les chargements en arrière-plan (démarrage, relèves du mode économie, réveil groupé)
// passent par une file : un compte à la fois, le suivant quand le précédent est installé.

import { EventEmitter } from "node:events";
import type { RenderProcessGoneDetails, Session } from "electron";
import { t } from "../../shared/i18n";
import type { LinkStatePayload, Notice } from "../../shared/ipc";
import type { AccountConfig } from "../../shared/schemas";
import { addAccount, accountsInOrder, removeAccount, type NewAccountInput } from "../core/accounts";
import { ADAPTER_TIMEOUT_MS, adapterTimeoutEvent, linkStateEvent } from "../core/adapter";
import { onRendererGone, transition, type Lifecycle, type LifecycleEvent } from "../core/lifecycle";
import type { Logger } from "../log";
import type { AppStore } from "../storage/app-store";
import type { CallCoordinator } from "../calls/call-coordinator";
import type { ViewEvents, ViewManager } from "../views/view-manager";

/** lastOpenedAt est regroupé : une bascule ne doit pas écrire sur le disque. */
const LAST_OPENED_FLUSH_MS = 3000;
/** Nouvelle tentative de chargement d'un compte hors ligne. */
const OFFLINE_RETRY_MS = [5_000, 15_000, 30_000, 60_000];
/**
 * File de chargement : le compte suivant démarre quand le précédent est installé
 * (connecté, QR, hors ligne ou en erreur), au plus tard après ce délai. Mesuré sur
 * quatre comptes : même processeur au total, pic divisé par deux (1,2 cœur au lieu de 2,5).
 */
export const QUEUE_MAX_WAIT_MS = 30_000;
const QUEUE_GAP_MS = 1_500;
/** Retour du réseau : WhatsApp se reconnecte seul ; rechargé seulement s'il ne répond pas. */
export const RESTORE_FALLBACK_MS = 20_000;
/**
 * Relève ou recyclage : les non-lus conservés restent affichés jusqu'à ce que la page
 * donne les siens (son premier titre, « WhatsApp », n'en porte pas encore), au plus ce
 * délai après son installation.
 */
export const UNREAD_HOLD_MS = 10_000;

interface Runtime {
  lifecycle: Lifecycle;
  unread: number | null;
  audible: boolean;
  crashTimes: number[];
  hiddenSince: number | null;
  adapterTimer: NodeJS.Timeout | null;
  recreateTimer: NodeJS.Timeout | null;
  offlineTimer: NodeJS.Timeout | null;
  restoreTimer: NodeJS.Timeout | null;
  offlineAttempts: number;
  /** Hors ligne parce que la page n'a pas chargé (à recharger) ou parce que le réseau est tombé (WhatsApp se reconnecte). */
  offlineCause: "load" | "network" | null;
  adapterDegraded: boolean;
  /** Connecté au moins une fois pendant cette session (déconnexion à distance). */
  wasLinked: boolean;
  /** Endormi par le mode économie (pas par l'utilisateur) : non-lus gardés, relèves planifiées. */
  dozing: boolean;
  /** Page rechargée en gardant les non-lus (relève, recyclage) : un titre sans compte n'y touche pas. */
  holdUnread: boolean;
  holdTimer: NodeJS.Timeout | null;
  /** Non-lus du dernier titre de la page. */
  titleUnread: number | null;
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
  /**
   * Toutes les pages du compte ont disparu (veille, suppression, crash). keepNotifications :
   * mode économie et recyclage — les notifications déjà affichées restent (un clic affiche le compte).
   */
  accountGone(accountId: string, options?: { keepNotifications?: boolean }): void;
  /** Le compte vient d'être connecté (aide du thème, une fois par compte). */
  linked?(accountId: string): void;
  now?: () => number;
}

export class AccountManager extends EventEmitter<{ changed: []; lifecycle: [string, Lifecycle]; load: [string] }> implements ViewEvents {
  private readonly runtimes = new Map<string, Runtime>();
  private activeId: string | null = null;
  private modalOpen = false;
  /** Verrouillé, aucune vue n'est affichée. */
  private locked = false;
  /** Personne ne peut voir la fenêtre (absence, fenêtre réduite) : vues masquées. */
  private attended = true;
  private readonly now: () => number;
  private readonly lastOpened = new Map<string, string>();
  private lastOpenedTimer: NodeJS.Timeout | null = null;
  /** File des chargements en arrière-plan. */
  private readonly queue: string[] = [];
  private queued: string | null = null;
  private queueTimer: NodeJS.Timeout | null = null;
  private queuePaused = false;
  private deferTimer: NodeJS.Timeout | null = null;

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

  isDozing(id: string): boolean {
    return this.runtimes.get(id)?.dozing ?? false;
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
        restoreTimer: null,
        offlineAttempts: 0,
        offlineCause: null,
        adapterDegraded: false,
        wasLinked: false,
        dozing: false,
        holdUnread: false,
        holdTimer: null,
        titleUnread: null
      };
      this.runtimes.set(id, runtime);
    }
    return runtime;
  }

  private clearTimers(runtime: Runtime): void {
    for (const key of ["adapterTimer", "recreateTimer", "offlineTimer", "restoreTimer", "holdTimer"] as const) {
      const timer = runtime[key];
      if (timer) clearTimeout(timer);
      runtime[key] = null;
    }
  }

  // --- Démarrage ----------------------------------------------------------------------

  /**
   * Le dernier compte affiché d'abord, puis les autres un par un. deferMs : lancement
   * dans la barre système (session qui démarre) — rien n'est affiché, on laisse le
   * bureau s'installer avant de charger WhatsApp.
   */
  start(options: { deferMs?: number } = {}): void {
    const accounts = this.accounts();
    const lastOpened = [...accounts].sort((a, b) => b.lastOpenedAt.localeCompare(a.lastOpenedAt))[0];
    this.activeId = lastOpened?.id ?? null;

    const ordered = [...accounts].sort((a, b) => Number(b.id === this.activeId) - Number(a.id === this.activeId));
    for (const account of ordered) {
      const runtime = this.runtimeOf(account.id);
      if (account.sleeping) continue;
      // En attente de son tour : « chargement », pas « en veille ».
      runtime.lifecycle = "loading";
      this.queue.push(account.id);
    }
    if (options.deferMs && options.deferMs > 0) {
      this.queuePaused = true;
      this.deferTimer = setTimeout(() => this.expedite(), options.deferMs);
    } else {
      this.loadNextQueued();
    }
    this.refreshVisibility();
    this.emit("changed");
  }

  // --- File de chargement --------------------------------------------------------------

  /** Chargement en arrière-plan, à son tour. front : avant les autres (compte affiché). */
  private enqueue(id: string, front = false): void {
    const index = this.queue.indexOf(id);
    if (index >= 0) this.queue.splice(index, 1);
    if (front) this.queue.unshift(id);
    else this.queue.push(id);
    if (!this.queueBusy()) this.loadNextQueued();
  }

  /** Un compte de la file charge encore (sa page a pu être détruite entre-temps : supprimé, sessions effacées). */
  private queueBusy(): boolean {
    if (!this.queued) return false;
    return this.runtimes.get(this.queued)?.lifecycle === "loading" && this.deps.views().has(this.queued);
  }

  private loadNextQueued(): void {
    if (this.queueTimer) clearTimeout(this.queueTimer);
    this.queueTimer = null;
    this.queued = null;
    if (this.queuePaused) return;
    let id = this.queue.shift();
    while (id && (!this.account(id) || this.account(id)?.sleeping || this.deps.views().has(id))) id = this.queue.shift();
    if (!id) return;
    this.queued = id;
    this.load(id);
    this.queueTimer = setTimeout(() => this.loadNextQueued(), QUEUE_MAX_WAIT_MS);
  }

  /** Le compte en tête de file est installé : le suivant peut démarrer. */
  private queueProgress(id: string, lifecycle: Lifecycle): void {
    if (id !== this.queued || lifecycle === "loading") return;
    this.queued = null;
    if (this.queueTimer) clearTimeout(this.queueTimer);
    this.queueTimer = setTimeout(() => this.loadNextQueued(), QUEUE_GAP_MS);
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
    if (next === "ready") {
      runtime.wasLinked = true;
      this.deps.linked?.(id);
    }
    if (next !== "loading" && runtime.adapterTimer) {
      clearTimeout(runtime.adapterTimer);
      runtime.adapterTimer = null;
    }
    if (next !== "offline") {
      if (runtime.offlineTimer) clearTimeout(runtime.offlineTimer);
      if (runtime.restoreTimer) clearTimeout(runtime.restoreTimer);
      runtime.offlineTimer = null;
      runtime.restoreTimer = null;
      runtime.offlineAttempts = 0;
      runtime.offlineCause = null;
    }
    if (event === "remote-logout") {
      runtime.wasLinked = false;
      const label = this.account(id)?.label ?? t("common.anAccount");
      this.deps.notify({ id: `logout-${id}`, level: "warning", message: t("notice.loggedOut", { label }) });
    }
    if (runtime.holdUnread && next !== "loading" && next !== "sleeping" && !runtime.holdTimer) {
      runtime.holdTimer = setTimeout(() => this.releaseUnread(id), UNREAD_HOLD_MS);
    }
    this.queueProgress(id, next);
    this.refreshVisibility();
    this.emit("lifecycle", id, next);
    this.emit("changed");
  }

  /** Fin de la conservation des non-lus : le dernier titre de la page fait foi. */
  private releaseUnread(id: string): void {
    const runtime = this.runtimeOf(id);
    runtime.holdTimer = null;
    if (!runtime.holdUnread) return;
    runtime.holdUnread = false;
    if (runtime.titleUnread !== null && runtime.titleUnread !== runtime.unread) {
      runtime.unread = runtime.titleUnread;
      this.emit("changed");
    }
  }

  private load(id: string, url: string = this.deps.targetUrl): void {
    if (!this.account(id)) return;
    const runtime = this.runtimeOf(id);
    const views = this.deps.views();
    if (views.has(id)) return;
    if (runtime.lifecycle === "sleeping") this.apply(id, "wake");
    else if (runtime.lifecycle === "crashed") this.apply(id, "recreate");
    // Relève d'un compte endormi : ses non-lus restent affichés jusqu'à ce que la page les donne,
    // ses notifications aussi.
    const relay = runtime.dozing;
    if (!relay) runtime.unread = null;
    runtime.holdUnread = relay && runtime.unread !== null;
    runtime.titleUnread = null;
    if (runtime.holdTimer) clearTimeout(runtime.holdTimer);
    runtime.holdTimer = null;
    runtime.dozing = false;
    runtime.audible = false;
    this.deps.accountGone(id, { keepNotifications: relay });
    views.create(id, url);
    this.emit("load", id);
    this.refreshVisibility();
  }

  /** Recharger un compte hors ligne, avec un délai croissant. */
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
    runtime.titleUnread = unread;
    // Relève, recyclage : pas de « 0 » le temps que la page affiche son compte (le badge clignoterait).
    if (runtime.holdUnread && !match) return;
    runtime.holdUnread = false;
    if (runtime.holdTimer) clearTimeout(runtime.holdTimer);
    runtime.holdTimer = null;
    if (runtime.unread !== unread) {
      runtime.unread = unread;
      this.emit("changed");
    }
  }

  finishedLoad(id: string): void {
    const runtime = this.runtimeOf(id);
    if (runtime.adapterTimer) clearTimeout(runtime.adapterTimer);
    // Si l'adaptateur ne dit rien après un chargement réussi, on considère le
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
    // La page n'a pas chargé : il faudra la recharger.
    runtime.offlineCause = "load";
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
      const label = this.account(id)?.label ?? t("common.anAccount");
      this.deps.notify({ id: `crash-${id}`, level: "error", message: t("notice.crashedRepeatedly", { label }) });
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
      if (online && runtime.lifecycle === "offline") this.restore(id);
      else if (!online && runtime.lifecycle === "ready") {
        this.apply(id, "network-lost");
        runtime.offlineCause = "network";
      }
    }
  }

  /** Au réveil du PC, les comptes restés hors ligne. */
  resumed(): void {
    for (const [id, runtime] of this.runtimes) {
      if (runtime.lifecycle === "offline") this.restore(id);
    }
  }

  /**
   * Réseau revenu. Une page qui n'avait pas chargé est rechargée ; une page chargée,
   * elle, se reconnecte seule (un rechargement coûterait tout le démarrage de WhatsApp) :
   * on lui redemande son état, et on ne recharge que si elle ne répond pas.
   */
  private restore(id: string): void {
    const runtime = this.runtimeOf(id);
    if (runtime.offlineCause !== "network") {
      this.deps.views().reload(id);
      return;
    }
    if (runtime.adapterDegraded) {
      // Adaptateur muet : rien à attendre de la page.
      this.apply(id, "network-restored");
      return;
    }
    this.deps.views().requestLinkState(id);
    if (runtime.restoreTimer) clearTimeout(runtime.restoreTimer);
    runtime.restoreTimer = setTimeout(() => {
      runtime.restoreTimer = null;
      if (runtime.lifecycle !== "offline" || !this.account(id)) return;
      this.deps.log.info("restore-fallback-reload", { id });
      this.deps.views().reload(id);
    }, RESTORE_FALLBACK_MS);
  }

  // --- Actions -----------------------------------------------------------------------------

  add(input: NewAccountInput): AccountConfig {
    let created: AccountConfig | undefined;
    const saved = this.deps.store.update("accounts", (file) => {
      const result = addAccount(file, input, new Date(this.now()));
      created = result.account;
      return result.file;
    });
    if (!saved || !created) throw new Error(t("error.readOnlyConfig"));
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

    // Vider la session maintenant, supprimer le dossier au prochain démarrage.
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
    const runtime = this.runtimeOf(id);
    runtime.hiddenSince = null;
    // Endormi par le mode économie, ou encore dans la file du démarrage : chargé dès qu'on
    // l'affiche, sans attendre son tour.
    if (runtime.dozing || (runtime.lifecycle === "loading" && !this.account(id)?.sleeping && !this.deps.views().has(id))) this.load(id);
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

  /** Refusé pendant un appel. */
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
    runtime.dozing = false;
    runtime.unread = null;
    runtime.audible = false;
    this.emit("changed");
    return true;
  }

  wake(id: string, url?: string): void {
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
    this.load(id, url);
    this.emit("changed");
  }

  // --- Mode économie et recyclage -----------------------------------------------------------

  /**
   * Endort un compte caché (mode économie) : sa page et son service worker disparaissent,
   * ses non-lus restent affichés. Rien n'est écrit : il n'est pas « en veille » pour l'utilisateur.
   */
  doze(id: string): boolean {
    const account = this.account(id);
    if (!account || account.sleeping || this.deps.calls.inCall(id) || !this.deps.views().has(id)) return false;
    const runtime = this.runtimeOf(id);
    const unread = runtime.unread;
    this.clearTimers(runtime);
    this.deps.views().destroy(id);
    this.deps.accountGone(id, { keepNotifications: true });
    // Marqué avant la transition : ceux qui l'observent voient un compte endormi, pas en veille.
    runtime.dozing = true;
    this.apply(id, "sleep");
    runtime.unread = unread;
    runtime.audible = false;
    this.deps.log.info("account-dozing", { id });
    this.emit("changed");
    return true;
  }

  /** Relève : le compte endormi se recharge en arrière-plan, à son tour dans la file. */
  relay(id: string): void {
    const runtime = this.runtimes.get(id);
    if (!runtime?.dozing || this.account(id)?.sleeping) return;
    this.deps.log.info("account-relay", { id });
    this.enqueue(id);
  }

  /** Fin du mode économie pour ce compte (réglage, fenêtre réaffichée) : le compte affiché tout de suite, les autres à leur tour. */
  wakeFromDoze(id: string): void {
    const runtime = this.runtimes.get(id);
    if (!runtime?.dozing || this.account(id)?.sleeping) return;
    if (id === this.activeId) this.load(id);
    else this.enqueue(id);
  }

  /** Fenêtre affichée pendant le démarrage différé : on n'attend plus. */
  expedite(): void {
    if (this.deferTimer) clearTimeout(this.deferTimer);
    this.deferTimer = null;
    if (!this.queuePaused) return;
    this.queuePaused = false;
    this.loadNextQueued();
  }

  /** Recharge une page qui a trop gonflé, sans rien changer d'autre (nouveau processus). */
  recycle(id: string): void {
    const account = this.account(id);
    if (!account || account.sleeping || !this.deps.views().has(id) || this.deps.calls.inCall(id)) return;
    const runtime = this.runtimeOf(id);
    const unread = runtime.unread;
    this.clearTimers(runtime);
    this.deps.views().destroy(id);
    this.deps.accountGone(id, { keepNotifications: true });
    this.apply(id, "sleep");
    // Rechargé comme une relève : non-lus et notifications conservés.
    runtime.dozing = true;
    runtime.unread = unread;
    this.load(id);
    this.deps.log.info("account-recycled", { id });
  }

  /** Recharger WhatsApp ; sans page (crash abandonné, mode économie, file du démarrage), la créer. */
  reload(id: string): void {
    const runtime = this.runtimeOf(id);
    if (runtime.lifecycle === "crashed") runtime.crashTimes = [];
    if (this.deps.views().has(id)) this.deps.views().reload(id);
    else if (this.account(id) && !this.account(id)?.sleeping) this.load(id);
  }

  /**
   * Ouvre une URL WhatsApp (lien de conversation) dans un compte. Refusé
   * pendant un appel : recharger la page couperait l'appel.
   */
  openUrl(id: string, url: string): boolean {
    const account = this.account(id);
    if (!account) return false;
    if (this.deps.calls.inCall(id)) {
      this.deps.notify({ id: `link-in-call-${id}`, level: "info", message: t("notice.linkInCall", { label: account.label }) });
      return false;
    }
    // Compte endormi : le lien est la première page chargée, après son proxy.
    if (account.sleeping || !this.deps.views().has(id)) this.wake(id, url);
    else this.deps.views().load(id, url);
    this.switchTo(id);
    return true;
  }

  setModal(open: boolean): void {
    this.modalOpen = open;
    this.refreshVisibility();
  }

  setLocked(locked: boolean): void {
    this.locked = locked;
    this.refreshVisibility();
  }

  /** Quelqu'un peut voir la fenêtre ; sinon les vues sont masquées (bridées, rien n'est lu). Renvoie true si cela change. */
  setAttended(attended: boolean): boolean {
    if (attended === this.attended) return false;
    this.attended = attended;
    this.refreshVisibility();
    return true;
  }

  /** La vue du compte actif est affichée s'il en a une, sans modale ouverte ni verrou, et si quelqu'un regarde. */
  refreshVisibility(): void {
    const id = this.activeId;
    const views = this.deps.views();
    views.show(id && !this.modalOpen && !this.locked && this.attended && views.has(id) ? id : null);
  }

  /**
   * « Code oublié » : efface la session de chaque compte (il faudra rescanner les QR
   * codes). Les vues sont détruites avant l'effacement : rien ne reste lisible. Renvoie
   * false si un effacement a échoué : le verrou doit alors rester en place.
   */
  async resetAllSessions(): Promise<boolean> {
    let wiped = true;
    const ids = this.accounts().map((account) => account.id);
    for (const id of ids) {
      const runtime = this.runtimeOf(id);
      this.clearTimers(runtime);
      this.deps.views().destroy(id);
      this.deps.accountGone(id);
      runtime.lifecycle = "sleeping";
      runtime.wasLinked = false;
      runtime.dozing = false;
      runtime.unread = null;
    }
    for (const id of ids) {
      const ses = this.deps.sessionFor(id);
      try {
        await ses.clearStorageData();
        await ses.clearCache();
      } catch (error) {
        wiped = false;
        this.deps.log.error("clear-storage-failed", { id, error: String(error) });
      }
    }
    // Les pages ont disparu : la file repart de zéro (en attente : « chargement », comme au démarrage).
    this.queued = null;
    for (const id of ids) {
      const account = this.account(id);
      if (!account || account.sleeping) continue;
      this.runtimeOf(id).lifecycle = "loading";
      this.enqueue(id, id === this.activeId);
    }
    this.deps.log.info("sessions-reset", { count: ids.length, wiped });
    this.refreshVisibility();
    this.emit("changed");
    return wiped;
  }

  /** Comptes cachés et depuis quand, pour la veille automatique. */
  hiddenSince(id: string): number | null {
    return id === this.activeId ? null : this.runtimeOf(id).hiddenSince;
  }
}

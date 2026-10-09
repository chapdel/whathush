// EconomyService : relèves du mode économie (décisions dans core/economy.ts).
// Un compte en relèves dort quand il est caché ; à intervalle régulier il se recharge
// en arrière-plan (à son tour dans la file de l'AccountManager), reçoit ses messages et
// ses notifications, puis se rendort. Si la relève n'a montré aucune notification alors
// que les non-lus ont augmenté, une notification « nouveaux messages » le signale.

import { EventEmitter } from "node:events";
import type { Lifecycle } from "../../shared/ipc";
import type { Economy } from "../../shared/schemas";
import { ECONOMY_TIMING, economyActions, nextRelayAt, type EconomyAccount, type EconomyTiming, type RelayState } from "../core/economy";
import type { CallCoordinator } from "../calls/call-coordinator";
import type { Logger } from "../log";
import type { AccountManager } from "./account-manager";

const TICK_MS = 15_000;

interface Plan {
  nextRelayAt: number | null;
  relay: RelayState | null;
  /** Non-lus à l'endormissement, comparés à la fin de la relève suivante. */
  unreadBefore: number | null;
  /** Une notification a été montrée pendant la relève. */
  notified: boolean;
}

export interface EconomyDeps {
  accounts: AccountManager;
  calls: CallCoordinator;
  /** Lecture d'un média en cours dans le compte. */
  playing(accountId: string): boolean;
  preferences(): Economy;
  /** Fenêtre affichée (un compte n'est « affiché » que si elle l'est). */
  windowVisible(): boolean;
  /** Notification de synthèse : la relève n'a montré aucune notification. */
  digest(accountId: string, unread: number): void;
  log: Logger;
  now?: () => number;
  /** Tests : délais raccourcis. */
  timing?: Partial<EconomyTiming>;
  tickMs?: number;
  /** Tests : intervalle des relèves en millisecondes (sinon celui des préférences). */
  intervalMs?: number;
}

export class EconomyService extends EventEmitter<{ changed: [] }> {
  private readonly plans = new Map<string, Plan>();
  private timer: NodeJS.Timeout | null = null;
  private windowHiddenSince: number | null = null;
  private readonly timing: EconomyTiming;
  private readonly now: () => number;
  private started = false;

  constructor(private readonly deps: EconomyDeps) {
    super();
    this.timing = { ...ECONOMY_TIMING, ...deps.timing };
    this.now = deps.now ?? Date.now;
    deps.accounts.on("lifecycle", (id, lifecycle) => this.onLifecycle(id, lifecycle));
    deps.accounts.on("load", (id) => this.onLoad(id));
  }

  /** windowVisible : la fenêtre s'affichera au démarrage (elle ne l'est pas encore à cet instant). */
  start(windowVisible: boolean): void {
    this.started = true;
    if (!windowVisible) this.windowHiddenSince = this.now();
    // Au démarrage, le chargement d'un compte caché en relèves compte comme une relève.
    const now = this.now();
    for (const account of this.deps.accounts.accounts()) {
      if (account.delivery !== "periodic" || account.sleeping || (account.id === this.deps.accounts.active() && windowVisible)) continue;
      const lifecycle = this.deps.accounts.runtime(account.id)?.lifecycle;
      const installed = lifecycle !== undefined && lifecycle !== "loading" && lifecycle !== "sleeping";
      this.planOf(account.id).relay = { startedAt: now, readyAt: installed ? now : null, lastActivityAt: now };
    }
    this.reschedule();
  }

  stop(): void {
    this.started = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Fenêtre affichée ou masquée (barre système). */
  windowChanged(visible: boolean): void {
    this.windowHiddenSince = visible ? null : (this.windowHiddenSince ?? this.now());
    this.tick();
  }

  /** Réglages, comptes ou appels modifiés. */
  refresh(): void {
    this.tick();
  }

  /** Notification montrée pour ce compte : la relève se prolonge (messages en rafale). */
  noteNotification(accountId: string): void {
    const plan = this.plans.get(accountId);
    if (!plan?.relay) return;
    plan.relay.lastActivityAt = this.now();
    plan.notified = true;
  }

  /** État affiché : endormi (prochaine relève) ou relève en cours ; null hors du mode économie. */
  status(accountId: string): { dozing: boolean; nextRelayAt: string | null; relaying: boolean } | null {
    const dozing = this.deps.accounts.isDozing(accountId);
    const plan = this.plans.get(accountId);
    const relaying = Boolean(plan?.relay);
    if (!dozing && !relaying) return null;
    const next = dozing && !relaying && plan?.nextRelayAt ? new Date(plan.nextRelayAt).toISOString() : null;
    return { dozing, nextRelayAt: next, relaying };
  }

  private planOf(accountId: string): Plan {
    let plan = this.plans.get(accountId);
    if (!plan) {
      plan = { nextRelayAt: null, relay: null, unreadBefore: null, notified: false };
      this.plans.set(accountId, plan);
    }
    return plan;
  }

  /** La relève commence vraiment quand la page se crée (elle a pu attendre son tour dans la file). */
  private onLoad(accountId: string): void {
    const relay = this.plans.get(accountId)?.relay;
    if (!relay) return;
    const now = this.now();
    relay.startedAt = now;
    relay.readyAt = null;
    relay.lastActivityAt = now;
  }

  private onLifecycle(accountId: string, lifecycle: Lifecycle): void {
    const relay = this.plans.get(accountId)?.relay;
    if (!relay) return;
    // Page rechargée pendant la relève : de nouveau en cours d'installation.
    if (lifecycle === "loading") relay.readyAt = null;
    else if (lifecycle !== "sleeping" && relay.readyAt === null) relay.readyAt = this.now();
  }

  private needed(): boolean {
    if (this.deps.preferences().inTray && this.windowHiddenSince !== null) return true;
    if (this.deps.accounts.accounts().some((account) => account.delivery === "periodic" && !account.sleeping)) return true;
    return [...this.plans.keys()].some((id) => this.deps.accounts.isDozing(id) || this.plans.get(id)?.relay);
  }

  private reschedule(): void {
    const needed = this.started && this.needed();
    if (needed && !this.timer) this.timer = setInterval(() => this.tick(), this.deps.tickMs ?? TICK_MS);
    if (!needed && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  tick(): void {
    if (!this.started) return;
    const now = this.now();
    const preferences = this.deps.preferences();
    const accounts = this.deps.accounts.accounts();
    const activeId = this.deps.accounts.active();
    const windowVisible = this.deps.windowVisible();
    // Comptes supprimés : leur plan aussi.
    for (const id of [...this.plans.keys()]) if (!accounts.some((account) => account.id === id)) this.plans.delete(id);

    const states: EconomyAccount[] = accounts.map((account) => {
      const runtime = this.deps.accounts.runtime(account.id);
      const plan = this.plans.get(account.id);
      const shown = windowVisible && account.id === activeId;
      const ownHidden = this.deps.accounts.hiddenSince(account.id);
      // Le compte actif est caché depuis que la fenêtre l'est.
      const hiddenSince = shown ? null : account.id === activeId ? this.windowHiddenSince : ownHidden;
      return {
        id: account.id,
        delivery: account.delivery,
        sleeping: account.sleeping,
        shown,
        inCall: this.deps.calls.inCall(account.id),
        playing: this.deps.playing(account.id),
        lifecycle: account.sleeping ? "sleeping" : (runtime?.lifecycle ?? "loading"),
        hiddenSince,
        dozing: runtime?.dozing ?? false,
        nextRelayAt: plan?.nextRelayAt ?? null,
        relay: plan?.relay ?? null
      };
    });

    let changed = false;
    for (const action of economyActions(states, { now, intervalMinutes: preferences.intervalMinutes, inTray: preferences.inTray, windowHiddenSince: this.windowHiddenSince, timing: this.timing })) {
      const plan = this.planOf(action.id);
      const unread = this.deps.accounts.runtime(action.id)?.unread ?? null;
      if (action.type === "doze") {
        // Fin de relève : les non-lus ont augmenté sans aucune notification.
        if (plan.relay && !plan.notified && unread !== null && plan.unreadBefore !== null && unread > plan.unreadBefore) this.deps.digest(action.id, unread);
        if (!this.deps.accounts.doze(action.id)) continue;
        plan.relay = null;
        plan.notified = false;
        plan.unreadBefore = unread;
        plan.nextRelayAt = this.deps.intervalMs !== undefined ? now + this.deps.intervalMs : nextRelayAt(now, preferences.intervalMinutes);
        this.deps.log.info("economy-doze", { id: action.id, next: new Date(plan.nextRelayAt).toISOString() });
      } else if (action.type === "relay") {
        plan.relay = { startedAt: now, readyAt: null, lastActivityAt: now };
        plan.notified = false;
        plan.nextRelayAt = null;
        this.deps.accounts.relay(action.id);
      } else if (action.type === "end") {
        plan.relay = null;
        plan.notified = false;
        this.deps.log.info("economy-relay-ended", { id: action.id });
      } else {
        plan.relay = null;
        plan.nextRelayAt = null;
        this.deps.log.info("economy-wake", { id: action.id });
        this.deps.accounts.wakeFromDoze(action.id);
      }
      changed = true;
    }
    this.reschedule();
    if (changed) this.emit("changed");
  }
}

// ResourceMonitor : mémoire et processeur par compte, veille automatique, suggestion du
// mode économie, recyclage des pages qui gonflent, journal de performance.
// Une mesure par minute ; toutes les 10 s seulement quand les paramètres affichent la
// mémoire de chaque compte. La coque n'affiche pas la mémoire : elle n'est jamais
// rafraîchie pour elle (événement « memory », réservé aux paramètres).

import { app, type ProcessMetric } from "electron";
import { EventEmitter } from "node:events";
import { formatNumber, t } from "../../shared/i18n";
import type { Notice } from "../../shared/ipc";
import { accountsToAutoSleep, RECYCLE, recycleCandidate, sleepSuggestion, type RecycleThresholds } from "../core/resources";
import type { AccountManager } from "../accounts/account-manager";
import type { CallCoordinator } from "../calls/call-coordinator";
import type { Logger } from "../log";
import type { ViewManager } from "../views/view-manager";

export const MONITOR_INTERVAL_MS = { normal: 60_000, settings: 10_000 } as const;
/** Une suggestion de mode économie au plus toutes les 6 heures. */
const SUGGESTION_INTERVAL_MS = 6 * 60 * 60_000;
/** Journal de performance : une ligne toutes les 5 minutes. */
const PERF_LOG_MS = 5 * 60_000;

export interface ResourceMonitorDeps {
  accounts: AccountManager;
  views: () => ViewManager;
  calls: CallCoordinator;
  suggest(notice: Notice): void;
  /** Lecture d'un média en cours dans le compte (jamais recyclé pendant une lecture). */
  playing(accountId: string): boolean;
  /** Fenêtre et présence, pour le recyclage et le journal. */
  presence(): { windowVisible: boolean; presented: boolean; away: boolean };
  economyInterval(): number;
  log: Logger;
  now?: () => number;
  /** Tests : seuils de recyclage raccourcis. */
  recycleThresholds?: RecycleThresholds;
  intervalMs?: { normal: number; settings: number };
}

interface Baseline {
  pid: number;
  since: number;
  mb: number | null;
}

export class ResourceMonitor extends EventEmitter<{ memory: [] }> {
  private memory = new Map<string, number>();
  private totalMB: number | null = null;
  private timer: NodeJS.Timeout | null = null;
  private fast = false;
  private lastSuggestion = 0;
  private readonly baselines = new Map<string, Baseline>();
  private readonly lastRecycled = new Map<string, number>();
  /** Temps processeur cumulé par processus (secondes), au début de la période du journal. */
  private perfStart: { at: number; cpu: Map<string, number> } | null = null;
  private readonly now: () => number;

  constructor(private readonly deps: ResourceMonitorDeps) {
    super();
    this.now = deps.now ?? Date.now;
  }

  start(): void {
    this.schedule();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Paramètres ouverts : mesure toutes les 10 s pour afficher la mémoire de chaque compte. */
  setFast(fast: boolean): void {
    if (fast === this.fast) return;
    this.fast = fast;
    this.schedule();
    if (fast) this.tick();
  }

  private schedule(): void {
    if (this.timer) clearInterval(this.timer);
    const intervals = this.deps.intervalMs ?? MONITOR_INTERVAL_MS;
    this.timer = setInterval(() => this.tick(), this.fast ? intervals.settings : intervals.normal);
  }

  memoryMB(accountId: string): number | null {
    return this.memory.get(accountId) ?? null;
  }

  total(): number | null {
    return this.totalMB;
  }

  tick(): void {
    const now = this.now();
    const metrics = app.getAppMetrics();
    const byPid = new Map(metrics.map((metric) => [metric.pid, metric]));
    this.totalMB = Math.round(metrics.reduce((sum, metric) => sum + metric.memory.workingSetSize, 0) / 1024);
    const views = this.deps.views();
    const next = new Map<string, number>();
    const pids = new Map<string, number>();
    for (const id of views.ids()) {
      const pid = views.processId(id);
      const metric = pid ? byPid.get(pid) : undefined;
      if (metric && pid) {
        next.set(id, Math.round(metric.memory.workingSetSize / 1024));
        pids.set(id, pid);
      }
    }
    // N'avertir que d'un changement visible (≥ 5 Mo ou compte apparu/disparu).
    const changed = next.size !== this.memory.size || [...next].some(([id, value]) => Math.abs(value - (this.memory.get(id) ?? -100)) >= 5);
    this.memory = next;

    const accounts = this.deps.accounts.accounts();
    const activeId = this.deps.accounts.active();
    const due = accountsToAutoSleep(
      accounts.map((account) => ({
        id: account.id,
        ...(account.autoSleepAfterMinutes !== undefined ? { autoSleepAfterMinutes: account.autoSleepAfterMinutes } : {}),
        delivery: account.delivery,
        sleeping: account.sleeping,
        active: account.id === activeId,
        inCall: this.deps.calls.inCall(account.id),
        hiddenSince: this.deps.accounts.hiddenSince(account.id)
      })),
      now
    );
    for (const id of due) this.deps.accounts.sleep(id);

    this.recycle(now, pids);
    this.suggestEconomy(now);
    this.perfLog(now, metrics, pids);
    if (changed) this.emit("memory");
  }

  /** Mémoire de référence (quelques minutes après le chargement), puis recyclage d'une page qui a doublé. */
  private recycle(now: number, pids: Map<string, number>): void {
    for (const id of [...this.baselines.keys()]) if (!pids.has(id)) this.baselines.delete(id);
    for (const [id, pid] of pids) {
      const baseline = this.baselines.get(id);
      if (!baseline || baseline.pid !== pid) this.baselines.set(id, { pid, since: now, mb: null });
      else if (baseline.mb === null && now - baseline.since >= (this.deps.recycleThresholds ?? RECYCLE).baselineAfterMs && this.deps.accounts.runtime(id)?.lifecycle === "ready") baseline.mb = this.memory.get(id) ?? null;
    }
    const presence = this.deps.presence();
    const activeId = this.deps.accounts.active();
    const candidate = recycleCandidate(
      [...pids.keys()].map((id) => ({
        id,
        lifecycle: this.deps.accounts.runtime(id)?.lifecycle ?? "loading",
        rssMB: this.memory.get(id) ?? null,
        baselineMB: this.baselines.get(id)?.mb ?? null,
        active: id === activeId,
        inCall: this.deps.calls.inCall(id),
        playing: this.deps.playing(id),
        hiddenSince: this.deps.accounts.hiddenSince(id),
        lastRecycledAt: this.lastRecycled.get(id) ?? null
      })),
      { now, userAway: presence.away || !presence.presented, windowHidden: !presence.windowVisible, ...(this.deps.recycleThresholds ? { thresholds: this.deps.recycleThresholds } : {}) }
    );
    if (!candidate) return;
    this.deps.log.info("recycle", { id: candidate, mb: this.memory.get(candidate), baselineMB: this.baselines.get(candidate)?.mb });
    this.lastRecycled.set(candidate, now);
    this.baselines.delete(candidate);
    this.deps.accounts.recycle(candidate);
  }

  /** Au-delà du seuil de mémoire, propose le mode économie pour le compte caché depuis le plus longtemps. */
  private suggestEconomy(now: number): void {
    if (now - this.lastSuggestion < SUGGESTION_INTERVAL_MS) return;
    const activeId = this.deps.accounts.active();
    const candidate = sleepSuggestion(
      this.totalMB,
      this.deps.accounts.accounts().map((account) => ({
        id: account.id,
        label: account.label,
        delivery: account.delivery,
        sleeping: account.sleeping,
        active: account.id === activeId,
        inCall: this.deps.calls.inCall(account.id),
        hiddenSince: this.deps.accounts.hiddenSince(account.id),
        memoryMB: this.memory.get(account.id) ?? null
      })),
      now
    );
    if (!candidate) return;
    this.lastSuggestion = now;
    const total = formatNumber((this.totalMB ?? 0) / 1024, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
    const minutes = this.deps.economyInterval();
    const message = candidate.memoryMB
      ? t("notice.ramSuggestionFreed", { total, label: candidate.label, freed: candidate.memoryMB, minutes })
      : t("notice.ramSuggestion", { total, label: candidate.label, minutes });
    this.deps.suggest({
      id: "ram-suggestion",
      level: "info",
      sticky: true,
      message,
      action: { label: t("notice.ramSuggestionAction"), command: { type: "update-account", id: candidate.id, patch: { delivery: "periodic" } } }
    });
  }

  /**
   * Journal local de performance (jamais envoyé) : mémoire et processeur par compte et
   * pour le socle, état de la fenêtre. Sert à mesurer l'application sur de vrais comptes.
   */
  private perfLog(now: number, metrics: ProcessMetric[], pids: Map<string, number>): void {
    const key = (metric: ProcessMetric) => `${metric.pid}:${metric.creationTime}`;
    const cpu = new Map(metrics.map((metric) => [key(metric), metric.cpu.cumulativeCPUUsage ?? 0]));
    if (!this.perfStart) {
      this.perfStart = { at: now, cpu };
      return;
    }
    const elapsed = (now - this.perfStart.at) / 1000;
    if (elapsed * 1000 < PERF_LOG_MS) return;
    const start = this.perfStart.cpu;
    const usage = (metric: ProcessMetric) => {
      const before = start.get(key(metric));
      return before === undefined ? null : Math.max(0, ((cpu.get(key(metric)) ?? 0) - before) / elapsed) * 100;
    };
    const round = (value: number) => Math.round(value * 100) / 100;
    const accountPid = new Map([...pids].map(([id, pid]) => [pid, id]));
    const groups = { main: { mb: 0, cpu: 0 }, gpu: { mb: 0, cpu: 0 }, other: { mb: 0, cpu: 0 } };
    const accounts = new Map<string, { mb: number; cpu: number }>();
    for (const metric of metrics) {
      const mb = metric.memory.workingSetSize / 1024;
      const used = usage(metric) ?? 0;
      const accountId = accountPid.get(metric.pid);
      const target = accountId ? (accounts.get(accountId) ?? { mb: 0, cpu: 0 }) : metric.type === "Browser" ? groups.main : metric.type === "GPU" ? groups.gpu : groups.other;
      target.mb += mb;
      target.cpu += used;
      if (accountId) accounts.set(accountId, target);
    }
    const presence = this.deps.presence();
    const window = !presence.windowVisible ? "hidden" : !presence.presented ? "not-presented" : presence.away ? "away" : "visible";
    const states = this.deps.accounts.accounts().map((account) => {
      const runtime = this.deps.accounts.runtime(account.id);
      const measured = accounts.get(account.id);
      const state = account.sleeping ? "sleeping" : runtime?.dozing ? "dozing" : (runtime?.lifecycle ?? "loading");
      return { id: account.id, state, delivery: account.delivery, mb: measured ? Math.round(measured.mb) : 0, cpu: measured ? round(measured.cpu) : 0 };
    });
    const totalCpu = [...metrics].reduce((sum, metric) => sum + (usage(metric) ?? 0), 0);
    this.deps.log.info("perf", {
      minutes: round(elapsed / 60),
      processes: metrics.length,
      totalMB: this.totalMB,
      cpu: round(totalCpu),
      window,
      accounts: states,
      main: { mb: Math.round(groups.main.mb), cpu: round(groups.main.cpu) },
      gpu: { mb: Math.round(groups.gpu.mb), cpu: round(groups.gpu.cpu) },
      other: { mb: Math.round(groups.other.mb), cpu: round(groups.other.cpu) }
    });
    this.perfStart = { at: now, cpu };
  }
}

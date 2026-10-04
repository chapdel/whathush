// ResourceMonitor (§17) : RAM et CPU par compte, veille automatique.

import { app } from "electron";
import { EventEmitter } from "node:events";
import { formatNumber, t } from "../../shared/i18n";
import type { Notice } from "../../shared/ipc";
import { accountsToAutoSleep, sleepSuggestion } from "../core/resources";
import type { AccountManager } from "../accounts/account-manager";
import type { CallCoordinator } from "../calls/call-coordinator";
import type { ViewManager } from "../views/view-manager";

const INTERVAL_MS = 10_000;
/** Une suggestion de mise en veille au plus toutes les 6 heures. */
const SUGGESTION_INTERVAL_MS = 6 * 60 * 60_000;

export class ResourceMonitor extends EventEmitter<{ changed: [] }> {
  private memory = new Map<string, number>();
  private totalMB: number | null = null;
  private timer: NodeJS.Timeout | null = null;

  private lastSuggestion = 0;

  constructor(
    private readonly accounts: AccountManager,
    private readonly views: () => ViewManager,
    private readonly calls: CallCoordinator,
    private readonly suggest: (notice: Notice) => void = () => undefined
  ) {
    super();
  }

  start(): void {
    this.timer = setInterval(() => this.tick(), INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  memoryMB(accountId: string): number | null {
    return this.memory.get(accountId) ?? null;
  }

  total(): number | null {
    return this.totalMB;
  }

  tick(): void {
    const metrics = app.getAppMetrics();
    const byPid = new Map(metrics.map((metric) => [metric.pid, metric]));
    this.totalMB = Math.round(metrics.reduce((sum, metric) => sum + metric.memory.workingSetSize, 0) / 1024);
    const next = new Map<string, number>();
    for (const id of this.views().ids()) {
      const pid = this.views().processId(id);
      const metric = pid ? byPid.get(pid) : undefined;
      if (metric) next.set(id, Math.round(metric.memory.workingSetSize / 1024));
    }
    // N'avertir que d'un changement visible (≥ 5 Mo ou compte apparu/disparu).
    const changed =
      next.size !== this.memory.size || [...next].some(([id, value]) => Math.abs(value - (this.memory.get(id) ?? -100)) >= 5);
    this.memory = next;

    const due = accountsToAutoSleep(
      this.accounts.accounts().map((account) => ({
        id: account.id,
        ...(account.autoSleepAfterMinutes !== undefined ? { autoSleepAfterMinutes: account.autoSleepAfterMinutes } : {}),
        sleeping: account.sleeping,
        active: account.id === this.accounts.active(),
        inCall: this.calls.inCall(account.id),
        hiddenSince: this.accounts.hiddenSince(account.id)
      })),
      Date.now()
    );
    for (const id of due) this.accounts.sleep(id);

    const now = Date.now();
    if (now - this.lastSuggestion >= SUGGESTION_INTERVAL_MS) {
      const candidate = sleepSuggestion(
        this.totalMB,
        this.accounts.accounts().map((account) => ({
          id: account.id,
          label: account.label,
          sleeping: account.sleeping,
          active: account.id === this.accounts.active(),
          inCall: this.calls.inCall(account.id),
          hiddenSince: this.accounts.hiddenSince(account.id),
          memoryMB: this.memory.get(account.id) ?? null
        })),
        now
      );
      if (candidate) {
        this.lastSuggestion = now;
        const total = formatNumber((this.totalMB ?? 0) / 1024, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
        const message = candidate.memoryMB
          ? t("notice.ramSuggestionFreed", { total, label: candidate.label, freed: candidate.memoryMB })
          : t("notice.ramSuggestion", { total, label: candidate.label });
        this.suggest({
          id: "ram-suggestion",
          level: "info",
          sticky: true,
          message,
          action: { label: t("notice.ramSuggestionAction"), command: { type: "sleep-account", id: candidate.id } }
        });
      }
    }
    if (changed) this.emit("changed");
  }
}

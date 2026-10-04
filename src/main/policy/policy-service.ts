// Service de politique (§12 à §15) : applique le PolicyEngine pur à tous les
// comptes, à chaque tick, au retour de veille et à chaque changement de réglage.

import { EventEmitter } from "node:events";
import type { SnoozePresetInput } from "../../shared/ipc";
import type { AccountConfig, Schedule } from "../../shared/schemas";
import {
  effectivePolicy,
  pruneExpiredOverride,
  resumeOverride,
  snoozeOverride,
  type ActiveFocus,
  type EffectivePolicy,
  type PolicyContext,
  type SnoozePreset
} from "../core/policy";
import type { AppStore } from "../storage/app-store";

const TICK_MS = 30_000;

function toPreset(input: SnoozePresetInput): SnoozePreset {
  return input.kind === "until" ? { kind: "until", until: new Date(input.until) } : input;
}

function signature(policy: EffectivePolicy): string {
  return `${policy.mode}|${policy.source}|${policy.until?.toISOString() ?? ""}|${policy.notifyMessages}|${policy.badge}`;
}

export class PolicyService extends EventEmitter<{ changed: [] }> {
  private policies = new Map<string, EffectivePolicy>();
  private timer: NodeJS.Timeout | null = null;

  private timeZone: string | undefined;

  constructor(
    private readonly store: AppStore,
    private readonly now: () => Date = () => new Date(),
    /** Relu à chaque calcul : un changement de fuseau est pris en compte au tick suivant. */
    private readonly currentTimeZone: () => string | undefined = () => undefined
  ) {
    super();
    this.timeZone = currentTimeZone();
  }

  start(): void {
    this.recompute();
    this.timer = setInterval(() => this.recompute(), TICK_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  policy(accountId: string): EffectivePolicy | undefined {
    return this.policies.get(accountId);
  }

  private activeFocus(now: Date): ActiveFocus | null {
    const focus = this.store.get("focus");
    if (!focus.active) return null;
    const profile = focus.profiles.find((candidate) => candidate.id === focus.active?.profileId);
    if (!profile) return null;
    if (focus.active.until && new Date(focus.active.until).getTime() <= now.getTime()) return null;
    return { profile, until: focus.active.until };
  }

  private contextFor(account: AccountConfig, now: Date, schedules: Schedule[], focus: ActiveFocus | null): PolicyContext {
    const schedule = account.scheduleId ? (schedules.find((candidate) => candidate.id === account.scheduleId) ?? null) : null;
    return { focus, schedule, now, ...(this.timeZone ? { timeZone: this.timeZone } : {}) };
  }

  recompute(): void {
    const now = this.now();
    this.timeZone = this.currentTimeZone();

    // §13 : un override expiré est ignoré, puis nettoyé ; un Focus expiré est désactivé.
    const accounts = this.store.get("accounts").accounts;
    if (accounts.some((account) => pruneExpiredOverride(account, now) !== account)) {
      this.store.update("accounts", (file) => ({ ...file, accounts: file.accounts.map((account) => pruneExpiredOverride(account, now)) }));
    }
    const focusFile = this.store.get("focus");
    if (focusFile.active?.until && new Date(focusFile.active.until).getTime() <= now.getTime()) {
      this.store.update("focus", (file) => ({ ...file, active: null }));
    }

    const schedules = this.store.get("schedules").schedules;
    const focus = this.activeFocus(now);
    const next = new Map<string, EffectivePolicy>();
    let changed = false;
    for (const account of this.store.get("accounts").accounts) {
      const policy = effectivePolicy(account, this.contextFor(account, now, schedules, focus));
      next.set(account.id, policy);
      const previous = this.policies.get(account.id);
      if (!previous || signature(previous) !== signature(policy)) changed = true;
    }
    if (next.size !== this.policies.size) changed = true;
    this.policies = next;
    if (changed) this.emit("changed");
  }

  snooze(accountId: string, preset: SnoozePresetInput): void {
    const override = snoozeOverride(toPreset(preset), this.now(), this.timeZone ? { timeZone: this.timeZone } : {});
    this.store.update("accounts", (file) => ({
      ...file,
      accounts: file.accounts.map((account) => (account.id === accountId ? { ...account, manualOverride: override } : account))
    }));
    this.recompute();
  }

  resume(accountId: string): void {
    const now = this.now();
    const account = this.store.get("accounts").accounts.find((candidate) => candidate.id === accountId);
    if (!account) return;
    const override = resumeOverride(
      { ...account, manualOverride: undefined },
      this.contextFor(account, now, this.store.get("schedules").schedules, this.activeFocus(now))
    );
    this.store.update("accounts", (file) => ({
      ...file,
      accounts: file.accounts.map((candidate) => {
        if (candidate.id !== accountId) return candidate;
        const { manualOverride: _previous, ...rest } = candidate;
        return override ? { ...rest, manualOverride: override } : rest;
      })
    }));
    this.recompute();
  }

  activateFocus(profileId: string | null, minutes: number | null): void {
    const until = minutes ? new Date(this.now().getTime() + minutes * 60_000).toISOString() : null;
    this.store.update("focus", (file) => ({ ...file, active: profileId ? { profileId, until } : null }));
    this.recompute();
  }
}

// PolicyEngine (§12 à §15) : politique de notification effective d'un compte.
// Fonctions pures de l'heure courante : aucun minuteur n'a besoin d'expirer au
// bon moment, un recalcul suffit (tick, retour de veille, changement d'heure).

import type { PolicySource } from "../../shared/ipc";
import type { AccountConfig, FocusProfile, ManualOverride, Mode, Schedule, ScheduleRule } from "../../shared/schemas";
import { addDays, fromLocal, isoWeekday, parseClock, toLocal, type LocalDate, type Weekday } from "./time";

const RESTRICTIVENESS: Record<Mode, number> = { normal: 0, "calls-only": 1, snoozed: 2 };
/** Horizon de recherche de la prochaine transition d'un horaire. */
const TRANSITION_HORIZON_DAYS = 8;

export type { PolicySource };

export interface ActiveFocus {
  profile: FocusProfile;
  /** ISO 8601 ; null = jusqu'à désactivation. */
  until: string | null;
}

export interface PolicyContext {
  focus: ActiveFocus | null;
  schedule: Schedule | null;
  now: Date;
  /** Fuseau IANA ; absent = fuseau du système. */
  timeZone?: string;
}

export interface EffectivePolicy {
  mode: Mode;
  source: PolicySource;
  /** Prochain changement possible de la politique (affichage « 🔕 1h42 »). */
  until: Date | null;
  notifyMessages: boolean;
  notifyCalls: boolean;
  /** Son de nos notifications de messages. */
  sound: boolean;
  showPreview: boolean;
  badge: boolean;
  /** Couper le son de la page quand le compte est caché (§12). */
  muteAudioWhenHidden: boolean;
}

export type PolicyAccount = Pick<AccountConfig, "id" | "notifications" | "manualOverride">;

// --- Horaires -------------------------------------------------------------------

function previousWeekday(day: Weekday): Weekday {
  return (day === 1 ? 7 : day - 1) as Weekday;
}

function ruleMatches(rule: ScheduleRule, weekday: Weekday, minuteOfDay: number): boolean {
  const start = parseClock(rule.start);
  const end = parseClock(rule.end);
  const days = rule.days as Weekday[];
  if (start < end) return days.includes(weekday) && minuteOfDay >= start && minuteOfDay < end;
  // Plage qui passe minuit (ou 24 h si fin = début) : elle commence le jour listé
  // et se termine le lendemain.
  return (days.includes(weekday) && minuteOfDay >= start) || (days.includes(previousWeekday(weekday)) && minuteOfDay < end);
}

function mostRestrictive(modes: Mode[]): Mode | null {
  let result: Mode | null = null;
  for (const mode of modes) {
    if (result === null || RESTRICTIVENESS[mode] > RESTRICTIVENESS[result]) result = mode;
  }
  return result;
}

/** Mode d'un horaire à un instant. Plusieurs plages actives : la plus restrictive gagne. */
export function scheduleModeAt(schedule: Schedule, instant: Date, timeZone?: string): Mode {
  const local = toLocal(instant, timeZone);
  const minuteOfDay = local.hour * 60 + local.minute;
  const matching = schedule.rules.filter((rule) => ruleMatches(rule, local.weekday, minuteOfDay)).map((rule) => rule.mode);
  return mostRestrictive(matching) ?? schedule.defaultMode;
}

/** Prochain instant où le mode de l'horaire change ; null s'il ne change pas sur 8 jours. */
export function nextScheduleTransition(schedule: Schedule, now: Date, timeZone?: string): Date | null {
  const boundaries = new Set<number>([0]);
  for (const rule of schedule.rules) {
    boundaries.add(parseClock(rule.start));
    boundaries.add(parseClock(rule.end));
  }

  const today: LocalDate = toLocal(now, timeZone);
  const candidates: number[] = [];
  for (let offset = 0; offset <= TRANSITION_HORIZON_DAYS; offset++) {
    const date = addDays(today, offset);
    for (const minuteOfDay of boundaries) {
      const instant = fromLocal({ ...date, hour: Math.floor(minuteOfDay / 60), minute: minuteOfDay % 60 }, timeZone).getTime();
      if (instant > now.getTime()) candidates.push(instant);
    }
  }
  candidates.sort((a, b) => a - b);

  const current = scheduleModeAt(schedule, now, timeZone);
  for (const candidate of candidates) {
    if (scheduleModeAt(schedule, new Date(candidate), timeZone) !== current) return new Date(candidate);
  }
  return null;
}

// --- Focus et Snooze manuel -------------------------------------------------------

function isActive(until: string | null, now: Date): boolean {
  return until === null || new Date(until).getTime() > now.getTime();
}

export function isOverrideActive(override: ManualOverride | undefined, now: Date): override is ManualOverride {
  return override !== undefined && isActive(override.until, now);
}

export function focusModeFor(profile: FocusProfile, accountId: string): Mode | null {
  return profile.modes[accountId] ?? profile.othersMode ?? null;
}

// --- Politique effective (§13) -----------------------------------------------------

/**
 * Priorité : Snooze manuel > Focus > horaire > normal.
 */
export function effectivePolicy(account: PolicyAccount, context: PolicyContext): EffectivePolicy {
  const { focus, schedule, now, timeZone } = context;

  let mode: Mode = "normal";
  let source: PolicySource = "default";
  let until: Date | null = null;

  if (schedule) {
    mode = scheduleModeAt(schedule, now, timeZone);
    source = "schedule";
    until = nextScheduleTransition(schedule, now, timeZone);
  }

  if (focus && isActive(focus.until, now)) {
    const focusMode = focusModeFor(focus.profile, account.id);
    if (focusMode) {
      mode = focusMode;
      source = "focus";
      until = focus.until ? new Date(focus.until) : null;
    }
  }

  if (isOverrideActive(account.manualOverride, now)) {
    mode = account.manualOverride.mode;
    source = "manual";
    until = account.manualOverride.until ? new Date(account.manualOverride.until) : null;
  }

  const settings = account.notifications;
  const notifyMessages = settings.enabled && mode === "normal";
  return {
    mode,
    source,
    until,
    notifyMessages,
    notifyCalls: settings.enabled && mode !== "snoozed",
    sound: settings.sound && notifyMessages,
    showPreview: settings.showPreview,
    badge: settings.badge && (mode === "normal" || settings.badgeWhileSnoozed),
    muteAudioWhenHidden: mode === "snoozed"
  };
}

// --- Actions de l'utilisateur ----------------------------------------------------------

export type SnoozePreset =
  | { kind: "minutes"; minutes: number }
  | { kind: "tomorrow-morning" }
  | { kind: "next-monday" }
  | { kind: "until"; until: Date }
  | { kind: "indefinitely" };

export interface SnoozeOptions {
  timeZone?: string;
  /** Heure du « matin » pour les durées « demain matin » et « lundi ». */
  morning?: { hour: number; minute: number };
}

const DEFAULT_MORNING = { hour: 8, minute: 0 };

/**
 * Fin d'un Snooze selon le préréglage choisi (§12) ; null = jusqu'à réactivation.
 * « Demain matin » avant l'heure du matin (ex. 1 h du matin) vise le matin même.
 * « Lundi » un lundi avant l'heure du matin vise ce lundi-là.
 */
export function snoozeUntil(preset: SnoozePreset, now: Date, options: SnoozeOptions = {}): Date | null {
  const { timeZone } = options;
  const morning = options.morning ?? DEFAULT_MORNING;
  const local = toLocal(now, timeZone);
  const beforeMorning = local.hour * 60 + local.minute < morning.hour * 60 + morning.minute;
  const at = (date: LocalDate) => fromLocal({ ...date, ...morning }, timeZone);

  switch (preset.kind) {
    case "minutes":
      return new Date(now.getTime() + preset.minutes * 60_000);
    case "tomorrow-morning":
      return at(beforeMorning ? local : addDays(local, 1));
    case "next-monday": {
      if (local.weekday === 1 && beforeMorning) return at(local);
      const daysUntilMonday = ((8 - isoWeekday(local)) % 7) || 7;
      return at(addDays(local, daysUntilMonday));
    }
    case "until":
      return preset.until;
    case "indefinitely":
      return null;
  }
}

export function snoozeOverride(preset: SnoozePreset, now: Date, options: SnoozeOptions = {}): ManualOverride {
  const until = snoozeUntil(preset, now, options);
  return { mode: "snoozed", until: until ? until.toISOString() : null };
}

/**
 * Réactivation manuelle (§13) : si Focus ou horaire imposent un Snooze, crée un
 * override « normal » jusqu'à leur prochaine transition ; sinon supprime l'override.
 */
export function resumeOverride(account: PolicyAccount, context: PolicyContext): ManualOverride | undefined {
  const withoutManual = effectivePolicy({ ...account, manualOverride: undefined }, context);
  if (withoutManual.mode === "normal") return undefined;
  return { mode: "normal", until: withoutManual.until ? withoutManual.until.toISOString() : null };
}

/** Retire un override expiré (§13 : « ignoré, puis nettoyé »). */
export function pruneExpiredOverride<T extends PolicyAccount>(account: T, now: Date): T {
  if (account.manualOverride && !isOverrideActive(account.manualOverride, now)) {
    const { manualOverride: _expired, ...rest } = account;
    return rest as T;
  }
  return account;
}

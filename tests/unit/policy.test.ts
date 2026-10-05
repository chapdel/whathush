import { describe, expect, it } from "vitest";
import { DEFAULT_NOTIFICATIONS } from "../../src/main/core/accounts";
import {
  effectivePolicy,
  nextScheduleTransition,
  pruneExpiredOverride,
  resumeOverride,
  scheduleModeAt,
  snoozeOverride,
  snoozeUntil,
  type ActiveFocus,
  type PolicyAccount,
  type PolicyContext
} from "../../src/main/core/policy";
import type { Schedule } from "../../src/shared/schemas";

const TZ = "Europe/Paris";
const ACCOUNT_ID = "3e6d9227-1b2c-4d3e-8f40-1a2b3c4d5e6f";
const OTHER_ID = "c41f7751-2c3d-4e4f-9a51-2b3c4d5e6f70";

// Octobre 2026 à Paris : UTC+2 jusqu'au dimanche 25, UTC+1 ensuite.
const at = (iso: string) => new Date(iso);

const account = (overrides: Partial<PolicyAccount> = {}): PolicyAccount => ({
  id: ACCOUNT_ID,
  notifications: { ...DEFAULT_NOTIFICATIONS },
  ...overrides
});

const context = (now: Date, overrides: Partial<PolicyContext> = {}): PolicyContext => ({
  focus: null,
  schedule: null,
  now,
  timeZone: TZ,
  ...overrides
});

// « Travail » : actif en semaine de 8 h à 18 h, en Snooze le reste du temps.
const travail: Schedule = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Travail",
  defaultMode: "snoozed",
  rules: [{ days: [1, 2, 3, 4, 5], start: "08:00", end: "18:00", mode: "normal" }]
};

// « Support » : appels uniquement de 22 h à 8 h, tous les jours.
const support: Schedule = {
  id: "22222222-2222-4222-8222-222222222222",
  name: "Support",
  defaultMode: "normal",
  rules: [{ days: [1, 2, 3, 4, 5, 6, 7], start: "22:00", end: "08:00", mode: "calls-only" }]
};

describe("scheduleModeAt", () => {
  it("applique les plages en semaine et le mode par défaut ailleurs", () => {
    expect(scheduleModeAt(travail, at("2026-10-05T07:00:00Z"), TZ)).toBe("normal"); // lundi 09:00
    expect(scheduleModeAt(travail, at("2026-10-05T17:00:00Z"), TZ)).toBe("snoozed"); // lundi 19:00
    expect(scheduleModeAt(travail, at("2026-10-10T10:00:00Z"), TZ)).toBe("snoozed"); // samedi midi
  });

  it("traite le début comme inclus et la fin comme exclue", () => {
    expect(scheduleModeAt(travail, at("2026-10-05T06:00:00Z"), TZ)).toBe("normal"); // lundi 08:00
    expect(scheduleModeAt(travail, at("2026-10-05T16:00:00Z"), TZ)).toBe("snoozed"); // lundi 18:00
  });

  it("prolonge une plage qui passe minuit sur le lendemain", () => {
    expect(scheduleModeAt(support, at("2026-10-05T21:00:00Z"), TZ)).toBe("calls-only"); // lundi 23:00
    expect(scheduleModeAt(support, at("2026-10-06T05:59:00Z"), TZ)).toBe("calls-only"); // mardi 07:59
    expect(scheduleModeAt(support, at("2026-10-06T06:00:00Z"), TZ)).toBe("normal"); // mardi 08:00
  });

  it("couvre 24 h quand le début et la fin sont égaux", () => {
    const weekend: Schedule = { ...travail, defaultMode: "normal", rules: [{ days: [6, 7], start: "00:00", end: "00:00", mode: "snoozed" }] };
    expect(scheduleModeAt(weekend, at("2026-10-10T00:00:00Z"), TZ)).toBe("snoozed"); // samedi 02:00
    expect(scheduleModeAt(weekend, at("2026-10-11T21:59:00Z"), TZ)).toBe("snoozed"); // dimanche 23:59
    expect(scheduleModeAt(weekend, at("2026-10-11T22:00:00Z"), TZ)).toBe("normal"); // lundi 00:00
  });

  it("retient la plage la plus restrictive en cas de chevauchement", () => {
    const lunch: Schedule = {
      ...travail,
      rules: [...travail.rules, { days: [1, 2, 3, 4, 5], start: "12:00", end: "14:00", mode: "calls-only" }]
    };
    expect(scheduleModeAt(lunch, at("2026-10-05T11:00:00Z"), TZ)).toBe("calls-only"); // lundi 13:00
  });
});

describe("nextScheduleTransition", () => {
  it("trouve la fin de la plage en cours", () => {
    expect(nextScheduleTransition(travail, at("2026-10-05T07:00:00Z"), TZ)?.toISOString()).toBe("2026-10-05T16:00:00.000Z");
  });

  it("saute le week-end", () => {
    // vendredi 19:00 → lundi 08:00
    expect(nextScheduleTransition(travail, at("2026-10-09T17:00:00Z"), TZ)?.toISOString()).toBe("2026-10-12T06:00:00.000Z");
  });

  it("tient compte du retour à l'heure d'hiver", () => {
    // vendredi 23 octobre 19:00 (UTC+2) → lundi 26 octobre 08:00 (UTC+1)
    expect(nextScheduleTransition(travail, at("2026-10-23T17:00:00Z"), TZ)?.toISOString()).toBe("2026-10-26T07:00:00.000Z");
    // samedi 24 octobre 23:00 (UTC+2) → dimanche 25 octobre 08:00 (UTC+1)
    expect(nextScheduleTransition(support, at("2026-10-24T21:00:00Z"), TZ)?.toISOString()).toBe("2026-10-25T07:00:00.000Z");
  });

  it("renvoie null pour un horaire constant", () => {
    expect(nextScheduleTransition({ ...travail, rules: [] }, at("2026-10-05T07:00:00Z"), TZ)).toBeNull();
  });
});

describe("effectivePolicy : priorités", () => {
  const evening = at("2026-10-05T17:00:00Z"); // lundi 19:00, Travail en Snooze
  const morning = at("2026-10-05T07:00:00Z"); // lundi 09:00, Travail actif
  const focus = (modes: Record<string, "normal" | "snoozed" | "calls-only">, until: string | null = null, othersMode?: "normal" | "snoozed" | "calls-only"): ActiveFocus => ({
    profile: { id: "33333333-3333-4333-8333-333333333333", name: "Réunion", modes, ...(othersMode ? { othersMode } : {}) },
    until
  });

  it("est normal sans horaire, Focus ni Snooze", () => {
    expect(effectivePolicy(account(), context(morning))).toMatchObject({ mode: "normal", source: "default", until: null });
  });

  it("suit l'horaire et annonce sa prochaine transition", () => {
    const policy = effectivePolicy(account(), context(evening, { schedule: travail }));
    expect(policy).toMatchObject({ mode: "snoozed", source: "schedule" });
    expect(policy.until?.toISOString()).toBe("2026-10-06T06:00:00.000Z");
  });

  it("fait passer le Focus avant l'horaire", () => {
    const policy = effectivePolicy(account(), context(morning, { schedule: travail, focus: focus({ [ACCOUNT_ID]: "snoozed" }) }));
    expect(policy).toMatchObject({ mode: "snoozed", source: "focus", until: null });
  });

  it("fait passer le Snooze manuel avant le Focus", () => {
    const manual = { mode: "normal" as const, until: "2026-10-05T09:00:00Z" };
    const policy = effectivePolicy(account({ manualOverride: manual }), context(morning, { focus: focus({ [ACCOUNT_ID]: "snoozed" }) }));
    expect(policy).toMatchObject({ mode: "normal", source: "manual" });
    expect(policy.until?.toISOString()).toBe("2026-10-05T09:00:00.000Z");
  });

  it("ignore un Snooze manuel expiré", () => {
    const manual = { mode: "snoozed" as const, until: "2026-10-05T06:00:00Z" };
    expect(effectivePolicy(account({ manualOverride: manual }), context(morning, { schedule: travail }))).toMatchObject({ mode: "normal", source: "schedule" });
  });

  it("ignore un Focus expiré", () => {
    const expired = focus({ [ACCOUNT_ID]: "snoozed" }, "2026-10-05T06:00:00Z");
    expect(effectivePolicy(account(), context(morning, { focus: expired }))).toMatchObject({ mode: "normal", source: "default" });
  });

  it("applique othersMode aux comptes non listés, et seulement à eux", () => {
    const active = focus({ [OTHER_ID]: "normal" }, null, "snoozed");
    expect(effectivePolicy(account(), context(morning, { focus: active }))).toMatchObject({ mode: "snoozed", source: "focus" });
    const withoutOthers = focus({ [OTHER_ID]: "normal" });
    expect(effectivePolicy(account(), context(evening, { schedule: travail, focus: withoutOthers }))).toMatchObject({ source: "schedule" });
  });
});

describe("effectivePolicy : effets", () => {
  const now = at("2026-10-05T07:00:00Z");
  const withMode = (mode: "normal" | "snoozed" | "calls-only", notifications = DEFAULT_NOTIFICATIONS) =>
    effectivePolicy(account({ notifications, manualOverride: { mode, until: null } }), context(now));

  it("normal : tout passe", () => {
    expect(withMode("normal")).toMatchObject({ notifyMessages: true, notifyCalls: true, sound: true, badge: true, muteAudioWhenHidden: false });
  });

  it("calls-only : appels seulement, pas de mute (sinon la sonnerie serait coupée)", () => {
    expect(withMode("calls-only")).toMatchObject({ notifyMessages: false, notifyCalls: true, sound: false, muteAudioWhenHidden: false });
  });

  it("snoozed : rien ne passe, la page est coupée quand elle est cachée", () => {
    expect(withMode("snoozed")).toMatchObject({ notifyMessages: false, notifyCalls: false, sound: false, muteAudioWhenHidden: true });
  });

  it("garde ou masque le badge pendant le Snooze selon le réglage", () => {
    expect(withMode("snoozed").badge).toBe(true);
    expect(withMode("snoozed", { ...DEFAULT_NOTIFICATIONS, badgeWhileSnoozed: false }).badge).toBe(false);
  });

  it("notifications désactivées : ni messages ni appels", () => {
    expect(withMode("normal", { ...DEFAULT_NOTIFICATIONS, enabled: false })).toMatchObject({ notifyMessages: false, notifyCalls: false, sound: false });
  });
});

describe("snoozeUntil", () => {
  const options = { timeZone: TZ };

  it("ajoute une durée", () => {
    expect(snoozeUntil({ kind: "minutes", minutes: 30 }, at("2026-10-05T07:00:00Z"), options)?.toISOString()).toBe("2026-10-05T07:30:00.000Z");
  });

  it("vise demain 8 h, ou ce matin s'il est avant 8 h", () => {
    expect(snoozeUntil({ kind: "tomorrow-morning" }, at("2026-10-10T21:30:00Z"), options)?.toISOString()).toBe("2026-10-11T06:00:00.000Z"); // sam. 23:30
    expect(snoozeUntil({ kind: "tomorrow-morning" }, at("2026-10-10T23:00:00Z"), options)?.toISOString()).toBe("2026-10-11T06:00:00.000Z"); // dim. 01:00
  });

  it("vise lundi 8 h", () => {
    expect(snoozeUntil({ kind: "next-monday" }, at("2026-10-11T18:00:00Z"), options)?.toISOString()).toBe("2026-10-12T06:00:00.000Z"); // dim. 20:00
    expect(snoozeUntil({ kind: "next-monday" }, at("2026-10-12T08:00:00Z"), options)?.toISOString()).toBe("2026-10-19T06:00:00.000Z"); // lun. 10:00
    expect(snoozeUntil({ kind: "next-monday" }, at("2026-10-12T05:00:00Z"), options)?.toISOString()).toBe("2026-10-12T06:00:00.000Z"); // lun. 07:00
  });

  it("garde 8 h locale de l'autre côté d'un changement d'heure", () => {
    expect(snoozeUntil({ kind: "next-monday" }, at("2026-10-24T10:00:00Z"), options)?.toISOString()).toBe("2026-10-26T07:00:00.000Z");
  });

  it("jusqu'à réactivation : pas de fin", () => {
    expect(snoozeUntil({ kind: "indefinitely" }, at("2026-10-05T07:00:00Z"), options)).toBeNull();
    expect(snoozeOverride({ kind: "indefinitely" }, at("2026-10-05T07:00:00Z"), options)).toEqual({ mode: "snoozed", until: null });
  });
});

describe("resumeOverride et pruneExpiredOverride", () => {
  it("réactive jusqu'à la prochaine transition de l'horaire", () => {
    const override = resumeOverride(account(), context(at("2026-10-05T17:00:00Z"), { schedule: travail }));
    expect(override).toEqual({ mode: "normal", until: "2026-10-06T06:00:00.000Z" });
  });

  it("n'a rien à créer quand rien n'impose de Snooze", () => {
    expect(resumeOverride(account(), context(at("2026-10-05T07:00:00Z"), { schedule: travail }))).toBeUndefined();
  });

  it("retire un override expiré et garde un override actif", () => {
    const now = at("2026-10-05T07:00:00Z");
    const expired = account({ manualOverride: { mode: "snoozed", until: "2026-10-05T06:59:00Z" } });
    const active = account({ manualOverride: { mode: "snoozed", until: null } });
    expect(pruneExpiredOverride(expired, now)).not.toHaveProperty("manualOverride");
    expect(pruneExpiredOverride(active, now)).toBe(active);
  });
});

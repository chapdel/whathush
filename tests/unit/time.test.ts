import { describe, expect, it } from "vitest";
import { addDays, fromLocal, isoWeekday, parseClock, toLocal } from "../../src/main/core/time";

const PARIS = "Europe/Paris";

describe("toLocal", () => {
  it("donne l'heure locale et le jour ISO", () => {
    expect(toLocal(new Date("2026-01-12T07:00:00Z"), PARIS)).toEqual({
      year: 2026,
      month: 1,
      day: 12,
      hour: 8,
      minute: 0,
      weekday: 1
    });
  });

  it("passe minuit en heure locale", () => {
    expect(toLocal(new Date("2026-10-04T22:30:00Z"), PARIS)).toMatchObject({ day: 5, hour: 0, minute: 30, weekday: 1 });
  });
});

describe("fromLocal", () => {
  it("fait l'aller-retour en heure d'été et d'hiver", () => {
    expect(fromLocal({ year: 2026, month: 7, day: 1, hour: 8, minute: 0 }, PARIS).toISOString()).toBe("2026-07-01T06:00:00.000Z");
    expect(fromLocal({ year: 2026, month: 12, day: 1, hour: 8, minute: 0 }, PARIS).toISOString()).toBe("2026-12-01T07:00:00.000Z");
  });

  it("décale une heure inexistante après le saut (passage à l'heure d'été)", () => {
    // 2026-03-29 : 02:00 → 03:00 à Paris ; 02:30 n'existe pas.
    expect(fromLocal({ year: 2026, month: 3, day: 29, hour: 2, minute: 30 }, PARIS).toISOString()).toBe("2026-03-29T01:30:00.000Z");
  });

  it("choisit la première occurrence d'une heure ambiguë (retour à l'heure d'hiver)", () => {
    // 2026-10-25 : 03:00 → 02:00 à Paris ; 02:30 existe deux fois.
    expect(fromLocal({ year: 2026, month: 10, day: 25, hour: 2, minute: 30 }, PARIS).toISOString()).toBe("2026-10-25T00:30:00.000Z");
  });

  it("fonctionne dans un autre fuseau", () => {
    // New York, 2026-03-08 : 02:00 → 03:00.
    expect(fromLocal({ year: 2026, month: 3, day: 8, hour: 9, minute: 0 }, "America/New_York").toISOString()).toBe("2026-03-08T13:00:00.000Z");
  });
});

describe("calendrier", () => {
  it("calcule le jour ISO", () => {
    expect(isoWeekday({ year: 2026, month: 10, day: 4 })).toBe(7);
    expect(isoWeekday({ year: 2026, month: 10, day: 5 })).toBe(1);
  });

  it("ajoute des jours en traversant mois et années", () => {
    expect(addDays({ year: 2026, month: 12, day: 30 }, 3)).toEqual({ year: 2027, month: 1, day: 2 });
    expect(addDays({ year: 2028, month: 2, day: 28 }, 1)).toEqual({ year: 2028, month: 2, day: 29 });
  });

  it("lit les heures HH:MM et refuse le reste", () => {
    expect(parseClock("00:00")).toBe(0);
    expect(parseClock("23:59")).toBe(1439);
    expect(() => parseClock("24:00")).toThrow();
    expect(() => parseClock("8:00")).toThrow();
  });
});

import { afterEach, describe, expect, it } from "vitest";
import { formatRemaining } from "../../src/shared/format";
import { catalogs, formatBytes, resolveLocale, setLocale, t, tIn, weekdayName, type MessageKey } from "../../src/shared/i18n";

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
const texts = (message: string | { one: string; other: string }) => (typeof message === "string" ? [message] : [message.one, message.other]);

afterEach(() => setLocale("fr"));

describe("catalogues (F12)", () => {
  it("ont les mêmes clés en français et en anglais (doublé d'un test d'exécution)", () => {
    expect(Object.keys(catalogs.en).sort()).toEqual(Object.keys(catalogs.fr).sort());
  });

  it("ont les mêmes paramètres et la même forme (pluriel ou non) pour chaque clé", () => {
    for (const key of Object.keys(catalogs.fr) as MessageKey[]) {
      const fr = catalogs.fr[key];
      const en = catalogs.en[key];
      expect(typeof en, key).toBe(typeof fr);
      for (const [a, b] of [[texts(fr), texts(en)]] as const) {
        expect(new Set(b.flatMap(placeholders)), key).toEqual(new Set(a.flatMap(placeholders)));
      }
    }
  });

  it("n'ont aucun texte vide", () => {
    for (const [language, catalog] of Object.entries(catalogs)) {
      for (const [key, message] of Object.entries(catalog)) {
        for (const text of texts(message)) if (!key.startsWith("source.")) expect(text.trim().length, `${language}:${key}`).toBeGreaterThan(0);
      }
    }
  });
});

describe("t()", () => {
  it("remplace les paramètres et choisit le pluriel", () => {
    // Espaces fines insécables (U+202F) dans les guillemets français.
    expect(t("stage.loading", { label: "Travail" })).toBe("Connexion à «\u202fTravail\u202f»…");
    expect(t("shell.zoom", { percent: 110 })).toBe("Zoom\u202f: 110\u202f%");
    expect(t("stage.loading", { label: "Projet : A" })).toContain("Projet : A");
    expect(t("shell.unreadSuffix", { count: 1 })).toBe(", 1 non lu");
    expect(t("shell.unreadSuffix", { count: 2 })).toBe(", 2 non lus");
    // En français, 0 se met au singulier ; en anglais, au pluriel.
    expect(t("shell.noticesCount", { count: 0 })).toBe("0 information à consulter");
    setLocale("en");
    expect(t("shell.noticesCount", { count: 0 })).toBe("0 items to review");
    expect(t("shell.noticesCount", { count: 1 })).toBe("1 item to review");
  });

  it("traduit dans une autre langue sans changer la langue courante", () => {
    expect(tIn("en", "welcome.title")).toBe("Connect WhatsApp");
    expect(t("welcome.title")).toBe("Connecter WhatsApp");
  });

  it("formate durées, tailles et jours selon la langue", () => {
    const now = new Date("2026-10-05T10:00:00Z");
    expect(formatRemaining(new Date(now.getTime() + 102 * 60_000), now)).toBe("1h42");
    expect(formatBytes(1536)).toBe("1,5 Ko");
    expect(weekdayName(1, "long")).toBe("Lundi");
    setLocale("en", "en-GB");
    expect(formatRemaining(new Date(now.getTime() + 102 * 60_000), now)).toBe("1h 42m");
    expect(formatRemaining(new Date(now.getTime() + 3 * 24 * 60 * 60_000), now)).toBe("3d");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(weekdayName(1, "narrow")).toBe("M");
  });
});

describe("resolveLocale()", () => {
  it("suit la première langue du système qu'on sait afficher, sinon l'anglais", () => {
    expect(resolveLocale("system", ["fr-CA", "en-US"])).toEqual({ locale: "fr", tag: "fr-CA" });
    expect(resolveLocale("system", ["de-DE", "en-GB"])).toEqual({ locale: "en", tag: "en-GB" });
    expect(resolveLocale("system", ["de-DE", "fr"])).toEqual({ locale: "fr", tag: "fr" });
    expect(resolveLocale("system", ["de-DE"])).toEqual({ locale: "en", tag: "en-US" });
    expect(resolveLocale("system", [])).toEqual({ locale: "en", tag: "en-US" });
  });

  it("nettoie les langues système à modificateur ou encodage (sinon Intl lève une erreur)", () => {
    // Revue : LANG=fr_FR@euro → ["fr-FR@euro", …] ; Intl.PluralRules("fr-FR@euro") lève RangeError.
    expect(resolveLocale("system", ["fr-FR@euro", "fr@euro", "fr-FR", "fr"])).toEqual({ locale: "fr", tag: "fr-FR" });
    expect(resolveLocale("system", ["en_GB.UTF-8"])).toEqual({ locale: "en", tag: "en-GB" });
    expect(resolveLocale("fr", ["fr_CA.UTF-8@euro"])).toEqual({ locale: "fr", tag: "fr-CA" });
    setLocale("fr", "fr-FR@euro");
    expect(t("shell.unreadSuffix", { count: 2 })).toBe(", 2 non lus");
    expect(formatBytes(2048)).toBe("2 Ko");
  });

  it("respecte un choix explicite et garde la variante régionale du système", () => {
    expect(resolveLocale("fr", ["en-US", "fr-BE"])).toEqual({ locale: "fr", tag: "fr-BE" });
    expect(resolveLocale("en", ["fr-FR"])).toEqual({ locale: "en", tag: "en-US" });
  });
});

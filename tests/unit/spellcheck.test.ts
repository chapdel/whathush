import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BUNDLED_DICTIONARIES, bundledDictionaryFor, spellcheckPlan, systemDictionary } from "../../src/main/core/spellcheck";

const AVAILABLE = ["de", "de-DE", "en-AU", "en-GB", "en-US", "es", "es-ES", "fr", "fr-FR", "it", "pt-BR"];

describe("correcteur (F5)", () => {
  it("associe la langue du système à un dictionnaire embarqué", () => {
    expect(bundledDictionaryFor("fr-CA")).toBe("fr");
    expect(bundledDictionaryFor("fr")).toBe("fr");
    expect(bundledDictionaryFor("en")).toBe("en-US");
    expect(bundledDictionaryFor("en-US")).toBe("en-US");
    expect(bundledDictionaryFor("en-AU")).toBe("en-GB");
    expect(bundledDictionaryFor("en_GB")).toBe("en-GB");
    expect(bundledDictionaryFor("de-DE")).toBeNull();
    expect(systemDictionary(["de-DE", "fr-BE", "en-US"])).toBe("fr");
    expect(systemDictionary(["de-DE"])).toBeNull();
  });

  it("n'autorise jamais Google en mode « système » ni « désactivé »", () => {
    expect(spellcheckPlan("off", ["de"], ["fr-FR"], AVAILABLE)).toEqual({ languages: [], allowGoogle: false });
    expect(spellcheckPlan("system", [], ["fr-FR"], AVAILABLE)).toEqual({ languages: ["fr"], allowGoogle: false });
    // Langue du système sans dictionnaire embarqué : rien n'est activé, rien n'est téléchargé.
    expect(spellcheckPlan("system", [], ["de-DE"], AVAILABLE)).toEqual({ languages: [], allowGoogle: false });
  });

  it("autorise Google seulement pour une langue non embarquée choisie explicitement", () => {
    expect(spellcheckPlan("custom", ["fr", "en-GB"], [], AVAILABLE)).toEqual({ languages: ["fr", "en-GB"], allowGoogle: false });
    expect(spellcheckPlan("custom", ["fr", "de"], [], AVAILABLE)).toEqual({ languages: ["fr", "de"], allowGoogle: true });
    // Langues inconnues de Chromium écartées, doublons retirés, 5 au plus.
    expect(spellcheckPlan("custom", ["xx", "fr", "fr", "de", "es", "it", "pt-BR", "en-US"], [], AVAILABLE).languages).toEqual(["fr", "de", "es", "it", "pt-BR"]);
  });

  it("embarque bien chaque dictionnaire annoncé, avec sa notice de licence", () => {
    const dir = path.resolve(import.meta.dirname, "../../build/dictionaries");
    for (const file of Object.values(BUNDLED_DICTIONARIES)) expect(fs.statSync(path.join(dir, file)).size).toBeGreaterThan(100_000);
    const notice = fs.readFileSync(path.join(dir, "NOTICE.txt"), "utf8");
    expect(notice).toContain("Mozilla Public License Version 2.0");
    expect(notice).toContain("Kevin Atkinson");
  });
});

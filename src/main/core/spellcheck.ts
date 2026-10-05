// Correcteur orthographique. Sous Linux, Electron télécharge les
// dictionnaires depuis les serveurs de Google. Exploration du 2026-10-05 : un fichier
// .bdic déposé dans <userData>/Dictionaries est chargé sans aucun téléchargement
// (les adresses file://, app:// et http://127.0.0.1 sont refusées par Chromium).
// On embarque donc les dictionnaires sous licence compatible (français MPL 2.0,
// anglais SCOWL) ; les autres langues restent possibles par téléchargement
// explicite depuis Google, annoncé comme tel.

/** Langue Chromium → fichier .bdic embarqué (noms attendus par Electron 44). */
export const BUNDLED_DICTIONARIES: Readonly<Record<string, string>> = {
  fr: "fr-FR-3-0.bdic",
  "en-US": "en-US-10-1.bdic",
  "en-GB": "en-GB-10-1.bdic"
};

/** Adresse par défaut de Chromium, utilisée seulement après un choix explicite. */
export const GOOGLE_DICTIONARY_URL = "https://redirector.gvt1.com/edgedl/chrome/dict/";
/** Port fermé : toute tentative de téléchargement échoue sans sortir de la machine. */
export const BLOCKED_DICTIONARY_URL = "http://127.0.0.1:9/";

export type SpellcheckMode = "off" | "system" | "custom";

export function isBundled(language: string): boolean {
  return language in BUNDLED_DICTIONARIES;
}

/**
 * Dictionnaire embarqué pour une langue du système (« fr-CA » → « fr »,
 * « en-AU » → « en-GB », « en » → « en-US ») ; null s'il n'y en a pas.
 */
export function bundledDictionaryFor(systemLanguage: string): string | null {
  const [base, region] = systemLanguage.replace("_", "-").split("-");
  if (base?.toLowerCase() === "fr") return "fr";
  if (base?.toLowerCase() === "en") return !region || region.toUpperCase() === "US" ? "en-US" : "en-GB";
  return null;
}

/** Première langue du système qui a un dictionnaire embarqué. */
export function systemDictionary(systemLanguages: readonly string[]): string | null {
  for (const language of systemLanguages) {
    const dictionary = bundledDictionaryFor(language);
    if (dictionary) return dictionary;
  }
  return null;
}

export interface SpellcheckPlan {
  languages: string[];
  /** Au moins une langue n'est pas embarquée : le téléchargement depuis Google est permis. */
  allowGoogle: boolean;
}

/** Langues à activer selon le mode ; seules les langues connues de Chromium sont gardées. */
export function spellcheckPlan(mode: SpellcheckMode, custom: readonly string[], systemLanguages: readonly string[], available: readonly string[]): SpellcheckPlan {
  const known = new Set(available);
  if (mode === "off") return { languages: [], allowGoogle: false };
  if (mode === "system") {
    const dictionary = systemDictionary(systemLanguages);
    return { languages: dictionary && known.has(dictionary) ? [dictionary] : [], allowGoogle: false };
  }
  const languages = [...new Set(custom)].filter((language) => known.has(language)).slice(0, 5);
  return { languages, allowGoogle: languages.some((language) => !isBundled(language)) };
}

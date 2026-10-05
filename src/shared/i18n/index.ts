// Traduction de l'interface. Catalogue typé, sans dépendance : le français est
// la référence, chaque autre langue a exactement les mêmes clés (vérifié par
// TypeScript). Le processus principal et l'interface lisent le même catalogue ;
// WhatsApp Web garde la langue de ses propres réglages.

import { en } from "./en";
import { fr, type Catalog, type Message, type MessageKey } from "./fr";

export type { MessageKey } from "./fr";
export type Locale = "fr" | "en";
export const LOCALES: readonly Locale[] = ["fr", "en"];
export type Params = Record<string, string | number>;

const CATALOGS: Record<Locale, Catalog> = { fr, en };
const DEFAULT_TAGS: Record<Locale, string> = { fr: "fr-FR", en: "en-US" };

let current: Locale = "fr";
let currentTag = DEFAULT_TAGS.fr;
const pluralRules = new Map<string, Intl.PluralRules>();

/** Langue courante du processus (ou de la page) et étiquette BCP 47 pour Intl. */
export function setLocale(locale: Locale, tag: string = DEFAULT_TAGS[locale]): void {
  current = locale;
  currentTag = cleanTag(tag) ?? DEFAULT_TAGS[locale];
}

export function locale(): Locale {
  return current;
}

export function localeTag(): string {
  return currentTag;
}

/**
 * Langue effective : choix explicite, sinon première langue du système qu'on sait
 * afficher, sinon l'anglais. L'étiquette garde la variante régionale du système
 * (fr-CA, en-GB…) pour les dates et les nombres.
 */
export function resolveLocale(preference: "system" | Locale, systemLanguages: readonly string[]): { locale: Locale; tag: string } {
  const base = (tag: string) => tag.toLowerCase().split(/[-_.@]/)[0];
  const tagFor = (target: Locale, tag: string | undefined) => (tag ? (cleanTag(tag) ?? DEFAULT_TAGS[target]) : DEFAULT_TAGS[target]);
  if (preference !== "system") return { locale: preference, tag: tagFor(preference, systemLanguages.find((tag) => base(tag) === preference)) };
  for (const tag of systemLanguages) {
    const candidate = base(tag);
    if (candidate === "fr" || candidate === "en") return { locale: candidate, tag: tagFor(candidate, tag) };
  }
  return { locale: "en", tag: DEFAULT_TAGS.en };
}

/**
 * Étiquette BCP 47 utilisable par Intl : « fr_FR.UTF-8 » → « fr-FR », « fr_FR@euro » →
 * « fr-FR » (sinon Intl lève une RangeError et l'interface ne s'affiche plus).
 */
export function cleanTag(tag: string): string | null {
  const stripped = tag.split(/[.@]/)[0]?.replace(/_/g, "-") ?? "";
  try {
    return Intl.getCanonicalLocales(stripped)[0] ?? null;
  } catch {
    return null;
  }
}

function plural(count: number): Intl.LDMLPluralRule {
  let rules = pluralRules.get(currentTag);
  if (!rules) {
    rules = new Intl.PluralRules(currentTag);
    pluralRules.set(currentTag, rules);
  }
  return rules.select(count);
}

function pick(message: Message, params: Params | undefined): string {
  if (typeof message === "string") return message;
  const count = Number(params?.count ?? 0);
  return plural(count) === "one" ? message.one : message.other;
}

/**
 * Typographie française : espace fine insécable dans les guillemets et avant : ; ? ! %,
 * pour qu'une ligne ne se coupe jamais entre « et le mot qui suit. Appliquée au texte
 * du catalogue seulement, pas aux valeurs (noms de comptes…).
 */
function typography(text: string): string {
  if (current !== "fr") return text;
  return text.replace(/« /g, "«\u202f").replace(/ »/g, "\u202f»").replace(/ ([:;?!%])/g, "\u202f$1");
}

/** Texte traduit ; {nom} est remplacé par params.nom, {count} choisit le pluriel. */
export function t(key: MessageKey, params?: Params): string {
  const message = CATALOGS[current][key] ?? fr[key];
  const text = typography(pick(message, params));
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (whole, name: string) => (name in params ? String(params[name]) : whole));
}

/** Même texte dans une langue donnée, sans changer la langue courante. */
export function tIn(target: Locale, key: MessageKey, params?: Params): string {
  const saved = { locale: current, tag: currentTag };
  setLocale(target);
  try {
    return t(key, params);
  } finally {
    setLocale(saved.locale, saved.tag);
  }
}

export function formatDateTime(date: Date, options: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat(currentTag, options).format(date);
}

export function formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
  return new Intl.NumberFormat(currentTag, options).format(value);
}

/** Taille lisible : « 1,2 Mo » en français, « 1.2 MB » en anglais. */
export function formatBytes(bytes: number): string {
  const units = current === "fr" ? ["o", "Ko", "Mo", "Go"] : ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${formatNumber(value, { maximumFractionDigits: unit === 0 ? 0 : 1 })} ${units[unit]}`;
}

/** Jours de la semaine ISO (1 = lundi) : « L », « Lundi »… selon la langue. */
export function weekdayName(isoDay: number, style: "narrow" | "long"): string {
  // 2024-01-01 était un lundi.
  const date = new Date(Date.UTC(2024, 0, isoDay, 12));
  const name = new Intl.DateTimeFormat(currentTag, { weekday: style, timeZone: "UTC" }).format(date);
  return name.charAt(0).toLocaleUpperCase(currentTag) + name.slice(1);
}

/** Nom d'une langue dans la langue courante : « français », « English »… */
export function languageName(tag: string): string {
  try {
    const name = new Intl.DisplayNames([currentTag], { type: "language" }).of(tag) ?? tag;
    return name.charAt(0).toLocaleUpperCase(currentTag) + name.slice(1);
  } catch {
    return tag;
  }
}

/** Les clés et paramètres de chaque langue, pour les tests. */
export const catalogs: Readonly<Record<Locale, Catalog>> = CATALOGS;

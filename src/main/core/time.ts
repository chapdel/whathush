// Conversions entre instants et heure locale d'un fuseau, sans dépendance.
// Tout passe par Intl, qui connaît les changements d'heure.

/** Jour ISO : 1 = lundi … 7 = dimanche. */
export type Weekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export interface LocalDate {
  year: number;
  month: number;
  day: number;
}

export interface LocalDateTime extends LocalDate {
  hour: number;
  minute: number;
  weekday: Weekday;
}

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string | undefined): Intl.DateTimeFormat {
  const key = timeZone ?? "";
  let formatter = formatters.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      hourCycle: "h23"
    });
    formatters.set(key, formatter);
  }
  return formatter;
}

export function isoWeekday(date: LocalDate): Weekday {
  const day = new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
  return (day === 0 ? 7 : day) as Weekday;
}

export function addDays(date: LocalDate, days: number): LocalDate {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() };
}

/** Heure locale d'un instant dans un fuseau (fuseau du système si absent). */
export function toLocal(instant: Date, timeZone?: string): LocalDateTime {
  const parts = formatterFor(timeZone).formatToParts(instant);
  const read = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((part) => part.type === type)?.value);
  const date = { year: read("year"), month: read("month"), day: read("day") };
  return { ...date, hour: read("hour"), minute: read("minute"), weekday: isoWeekday(date) };
}

function sameLocalTime(a: LocalDateTime, b: LocalDate & { hour: number; minute: number }): boolean {
  return a.year === b.year && a.month === b.month && a.day === b.day && a.hour === b.hour && a.minute === b.minute;
}

/** Décalage du fuseau par rapport à UTC, en minutes, à un instant donné. */
function offsetMinutes(instantMs: number, timeZone?: string): number {
  const flooredMs = Math.floor(instantMs / MINUTE_MS) * MINUTE_MS;
  const local = toLocal(new Date(flooredMs), timeZone);
  const localAsUtc = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);
  return Math.round((localAsUtc - flooredMs) / MINUTE_MS);
}

/**
 * Instant correspondant à une heure locale.
 * - Heure ambiguë (retour à l'heure d'hiver) : la première occurrence.
 * - Heure inexistante (passage à l'heure d'été) : décalée après le saut
 *   (02:30 un jour de passage devient 03:30).
 */
export function fromLocal(local: LocalDate & { hour: number; minute: number }, timeZone?: string): Date {
  const naive = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);
  const offsetBefore = offsetMinutes(naive - DAY_MS, timeZone);
  const offsets = new Set([offsetBefore, offsetMinutes(naive, timeZone), offsetMinutes(naive + DAY_MS, timeZone)]);
  const matches = [...offsets]
    .map((offset) => naive - offset * MINUTE_MS)
    .filter((candidate) => sameLocalTime(toLocal(new Date(candidate), timeZone), local))
    .sort((a, b) => a - b);
  const first = matches[0];
  return new Date(first ?? naive - offsetBefore * MINUTE_MS);
}

/** "HH:MM" → minutes depuis minuit. */
export function parseClock(value: string): number {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!match) throw new Error(`heure invalide : ${value}`);
  return Number(match[1]) * 60 + Number(match[2]);
}

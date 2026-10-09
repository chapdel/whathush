// Les fichiers de configuration de l'application et leurs valeurs par défaut.
// Les schémas sont stricts : un nouveau réglage passe par une nouvelle version et
// une migration qui remplit sa valeur par défaut.

import {
  AccountsFileSchema,
  DownloadsFileSchema,
  FocusFileSchema,
  PreferencesSchema,
  SchedulesFileSchema,
  SecurityFileSchema,
  type AccountsFile,
  type DownloadsFile,
  type FocusFile,
  type Preferences,
  type SchedulesFile,
  type SecurityFile
} from "../../shared/schemas";
import { DEFAULT_PERMISSIONS, emptyAccountsFile } from "../core/accounts";
import type { JsonDocument } from "./json-store";

export const FILE_NAMES = {
  accounts: "accounts.json",
  preferences: "preferences.json",
  schedules: "schedules.json",
  focus: "focus-profiles.json",
  security: "security.json",
  downloads: "downloads.json"
} as const;

export const accountsDocument: JsonDocument<AccountsFile> = {
  schema: AccountsFileSchema,
  currentVersion: 3,
  migrations: {
    // v1 → v2 : zoom, permissions, proxy et aide du thème, par compte.
    1: (data) => ({
      ...data,
      schemaVersion: 2,
      accounts: Array.isArray(data.accounts)
        ? data.accounts.map((account: Record<string, unknown>) => ({
            ...account,
            zoomPercent: 100,
            permissions: { ...DEFAULT_PERMISSIONS },
            proxyMode: "inherit",
            proxy: null,
            // Un compte déjà relié a déjà eu l'occasion de régler son thème.
            themeHintShown: true
          }))
        : data.accounts
    }),
    // v2 → v3 : réception des messages (en continu, ou par relèves en mode économie).
    2: (data) => ({
      ...data,
      schemaVersion: 3,
      accounts: Array.isArray(data.accounts) ? data.accounts.map((account: Record<string, unknown>) => ({ ...account, delivery: "realtime" })) : data.accounts
    })
  },
  defaults: emptyAccountsFile
};

/** Absence au-delà de laquelle WhatsApp est masqué (minutes). */
export const DEFAULT_AWAY_HIDE_MINUTES = 5;

export function defaultPreferences(): Preferences {
  return {
    schemaVersion: 3,
    launchAtLogin: false,
    closeToTray: true,
    startMinimized: false,
    theme: "system",
    spellcheckLanguages: [],
    handleWhatsappLinks: false,
    sidebarCollapsed: false,
    askDownloadLocation: false,
    onboardingDone: false,
    language: "system",
    interfaceScale: 100,
    // Dictionnaires embarqués : aucun téléchargement, le correcteur suit le système.
    spellcheckMode: "system",
    downloadsHistoryDays: 30,
    privacyVeil: { onBlur: false, onScreenShare: false, blurMessages: false },
    proxy: { mode: "system", server: null },
    trayCountStyle: "number",
    exclusivePlayback: false,
    awayHideMinutes: DEFAULT_AWAY_HIDE_MINUTES,
    economy: { intervalMinutes: 30, inTray: false }
  };
}

export const preferencesDocument: JsonDocument<Preferences> = {
  schema: PreferencesSchema,
  currentVersion: 3,
  migrations: {
    // v1 → v2 : langue, échelle, correcteur, historique, voile, proxy, tray, lecture.
    1: (data) => {
      const defaults = defaultPreferences();
      const languages = Array.isArray(data.spellcheckLanguages) ? data.spellcheckLanguages : [];
      return {
        ...data,
        schemaVersion: 2,
        // La v1 n'existait qu'en français : la langue d'une installation existante ne
        // change pas sans que l'utilisateur la choisisse.
        language: "fr",
        interfaceScale: defaults.interfaceScale,
        // Un correcteur déjà choisi en v1 reste actif, avec les mêmes langues.
        spellcheckMode: languages.length > 0 ? "custom" : "off",
        downloadsHistoryDays: defaults.downloadsHistoryDays,
        privacyVeil: defaults.privacyVeil,
        proxy: defaults.proxy,
        trayCountStyle: defaults.trayCountStyle,
        exclusivePlayback: defaults.exclusivePlayback
      };
    },
    // v2 → v3 : WhatsApp masqué pendant une absence (activé), mode économie (relèves).
    2: (data) => {
      const defaults = defaultPreferences();
      return { ...data, schemaVersion: 3, awayHideMinutes: defaults.awayHideMinutes, economy: defaults.economy };
    }
  },
  defaults: defaultPreferences
};

export const schedulesDocument: JsonDocument<SchedulesFile> = {
  schema: SchedulesFileSchema,
  currentVersion: 1,
  migrations: {},
  defaults: () => ({ schemaVersion: 1, schedules: [] })
};

export const focusDocument: JsonDocument<FocusFile> = {
  schema: FocusFileSchema,
  currentVersion: 1,
  migrations: {},
  defaults: () => ({ schemaVersion: 1, profiles: [], active: null })
};

/** Paramètres scrypt : environ 50 ms par vérification sur un portable récent. */
export const SCRYPT_PARAMS = { N: 2 ** 15, r: 8, p: 1 } as const;

export const securityDocument: JsonDocument<SecurityFile> = {
  schema: SecurityFileSchema,
  currentVersion: 1,
  migrations: {},
  defaults: () => ({
    schemaVersion: 1,
    lock: { enabled: false, hash: "", salt: "", params: { ...SCRYPT_PARAMS }, onStart: true, onHide: false, idleMinutes: 0, onScreenLock: true },
    failures: { count: 0, lastAt: null },
    proxySecrets: { global: null, accounts: {} }
  })
};

export const downloadsDocument: JsonDocument<DownloadsFile> = {
  schema: DownloadsFileSchema,
  currentVersion: 1,
  migrations: {},
  defaults: () => ({ schemaVersion: 1, records: [] })
};

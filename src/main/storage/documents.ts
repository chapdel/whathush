// Les fichiers de configuration de l'application (§6) et leurs valeurs par défaut.

import {
  AccountsFileSchema,
  FocusFileSchema,
  PreferencesSchema,
  SchedulesFileSchema,
  type AccountsFile,
  type FocusFile,
  type Preferences,
  type SchedulesFile
} from "../../shared/schemas";
import { emptyAccountsFile } from "../core/accounts";
import type { JsonDocument } from "./json-store";

export const FILE_NAMES = {
  accounts: "accounts.json",
  preferences: "preferences.json",
  schedules: "schedules.json",
  focus: "focus-profiles.json"
} as const;

export const accountsDocument: JsonDocument<AccountsFile> = {
  schema: AccountsFileSchema,
  currentVersion: 1,
  migrations: {},
  defaults: emptyAccountsFile
};

export const preferencesDocument: JsonDocument<Preferences> = {
  schema: PreferencesSchema,
  currentVersion: 1,
  migrations: {},
  defaults: () => ({
    schemaVersion: 1,
    launchAtLogin: false,
    closeToTray: true,
    startMinimized: false,
    theme: "system",
    spellcheckLanguages: [],
    handleWhatsappLinks: false,
    sidebarCollapsed: false,
    askDownloadLocation: false,
    onboardingDone: false
  })
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

// Schémas des fichiers de configuration (§6) et types qui en dérivent.
// Toute donnée lue sur disque ou reçue par IPC passe par ces schémas.

import { z } from "zod";
import { LABEL_MAX_LENGTH, MAX_ACCOUNTS, partitionFor } from "./constants";

export const ModeSchema = z.enum(["normal", "snoozed", "calls-only"]);
export type Mode = z.infer<typeof ModeSchema>;

const IsoDateTime = z.iso.datetime({ offset: true });
const Clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "heure attendue au format HH:MM");

// --- Horaires (§15) ---------------------------------------------------------

export const ScheduleRuleSchema = z.strictObject({
  /** Jours ISO de début de la plage : 1 = lundi … 7 = dimanche. */
  days: z.array(z.int().min(1).max(7)).min(1).max(7),
  /** Début inclus. */
  start: Clock,
  /** Fin exclue. Si fin ≤ début, la plage passe minuit ; si fin = début, elle dure 24 h. */
  end: Clock,
  mode: ModeSchema
});
export type ScheduleRule = z.infer<typeof ScheduleRuleSchema>;

export const ScheduleSchema = z.strictObject({
  id: z.uuid(),
  name: z.string().trim().min(1).max(60),
  /** Mode appliqué hors de toute plage. */
  defaultMode: ModeSchema,
  rules: z.array(ScheduleRuleSchema).max(50)
});
export type Schedule = z.infer<typeof ScheduleSchema>;

export const SchedulesFileSchema = z.strictObject({
  schemaVersion: z.literal(1),
  schedules: z.array(ScheduleSchema).max(100)
});
export type SchedulesFile = z.infer<typeof SchedulesFileSchema>;

// --- Focus (§14) --------------------------------------------------------------

export const FocusProfileSchema = z.strictObject({
  id: z.uuid(),
  name: z.string().trim().min(1).max(60),
  /** Mode imposé par compte. */
  modes: z.record(z.uuid(), ModeSchema),
  /** Mode des comptes non listés ; absent = ils gardent leur politique. */
  othersMode: ModeSchema.optional()
});
export type FocusProfile = z.infer<typeof FocusProfileSchema>;

export const FocusFileSchema = z.strictObject({
  schemaVersion: z.literal(1),
  profiles: z.array(FocusProfileSchema).max(50),
  active: z
    .strictObject({
      profileId: z.uuid(),
      until: IsoDateTime.nullable()
    })
    .nullable()
});
export type FocusFile = z.infer<typeof FocusFileSchema>;

// --- Comptes (§6) ---------------------------------------------------------------

export const NotificationSettingsSchema = z.strictObject({
  enabled: z.boolean(),
  sound: z.boolean(),
  showPreview: z.boolean(),
  badge: z.boolean(),
  includeInTotal: z.boolean(),
  badgeWhileSnoozed: z.boolean()
});
export type NotificationSettings = z.infer<typeof NotificationSettingsSchema>;

export const ManualOverrideSchema = z.strictObject({
  mode: ModeSchema,
  /** null = jusqu'à réactivation. */
  until: IsoDateTime.nullable()
});
export type ManualOverride = z.infer<typeof ManualOverrideSchema>;

export const AccountConfigSchema = z
  .strictObject({
    id: z.uuid(),
    label: z.string().trim().min(1).max(LABEL_MAX_LENGTH),
    color: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .optional(),
    icon: z.string().max(16).optional(),
    order: z.int().min(0),
    partition: z.string(),
    notifications: NotificationSettingsSchema,
    manualOverride: ManualOverrideSchema.optional(),
    scheduleId: z.uuid().optional(),
    autoSleepAfterMinutes: z.int().min(1).max(7 * 24 * 60).optional(),
    /** Seule intention de cycle de vie persistée (§2.1). */
    sleeping: z.boolean(),
    createdAt: IsoDateTime,
    lastOpenedAt: IsoDateTime
  })
  .refine((account) => account.partition === partitionFor(account.id), {
    message: "partition incohérente avec l'identifiant du compte",
    path: ["partition"]
  });
export type AccountConfig = z.infer<typeof AccountConfigSchema>;

export const AccountsFileSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    accounts: z.array(AccountConfigSchema).max(MAX_ACCOUNTS),
    /** Partitions à supprimer au prochain démarrage (§8). */
    pendingPartitionDeletion: z.array(z.uuid())
  })
  .refine((file) => new Set(file.accounts.map((account) => account.id)).size === file.accounts.length, {
    message: "identifiants de comptes en double",
    path: ["accounts"]
  });
export type AccountsFile = z.infer<typeof AccountsFileSchema>;

// --- Préférences globales (§31) -----------------------------------------------

export const ThemeSchema = z.enum(["system", "light", "dark"]);

export const PreferencesSchema = z.strictObject({
  schemaVersion: z.literal(1),
  launchAtLogin: z.boolean(),
  closeToTray: z.boolean(),
  startMinimized: z.boolean(),
  theme: ThemeSchema,
  /** Vide = correcteur désactivé (les dictionnaires viennent des serveurs de Google, §24). */
  spellcheckLanguages: z.array(z.string().max(16)).max(5),
  handleWhatsappLinks: z.boolean(),
  sidebarCollapsed: z.boolean(),
  askDownloadLocation: z.boolean(),
  onboardingDone: z.boolean()
});
export type Preferences = z.infer<typeof PreferencesSchema>;

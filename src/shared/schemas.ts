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

// --- Permissions par compte (F8) ----------------------------------------------------

export const PermissionChoiceSchema = z.enum(["allow", "ask", "deny"]);
export type PermissionChoice = z.infer<typeof PermissionChoiceSchema>;

export const AccountPermissionsSchema = z.strictObject({
  microphone: PermissionChoiceSchema,
  camera: PermissionChoiceSchema,
  location: PermissionChoiceSchema,
  /** Le choix de l'écran est toujours demandé (portail ou dialogue, §20) : pas de « allow ». */
  screenShare: z.enum(["ask", "deny"])
});
export type AccountPermissions = z.infer<typeof AccountPermissionsSchema>;

// --- Proxy (F9) : jamais de secret ici, les identifiants vont dans security.json ---------

/** Nom d'hôte, IPv4 ou IPv6 entre crochets ; rien qui puisse casser une règle de proxy. */
const ProxyHost = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .regex(/^(\[[0-9a-fA-F:.]+\]|[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?)$/, "hôte invalide");

export const ProxyServerSchema = z.strictObject({
  type: z.enum(["http", "https", "socks5"]),
  host: ProxyHost,
  port: z.int().min(1).max(65535),
  /** Des identifiants sont enregistrés pour ce serveur (dans security.json). */
  auth: z.boolean()
});
export type ProxyServer = z.infer<typeof ProxyServerSchema>;

export const GlobalProxySchema = z
  .strictObject({
    mode: z.enum(["system", "none", "manual"]),
    /** Gardé quand on repasse en « système » : l'utilisateur ne retape rien. */
    server: ProxyServerSchema.nullable()
  })
  .refine((proxy) => proxy.mode !== "manual" || proxy.server !== null, { message: "serveur requis en mode manuel", path: ["server"] });
export type GlobalProxy = z.infer<typeof GlobalProxySchema>;

export const AccountProxyModeSchema = z.enum(["inherit", "none", "manual"]);
export type AccountProxyMode = z.infer<typeof AccountProxyModeSchema>;

/** Zoom par compte (F1), en pourcentage, par paliers de 10. */
export const ZoomPercentSchema = z.int().min(50).max(200).refine((value) => value % 10 === 0, "palier de 10 %");

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
    lastOpenedAt: IsoDateTime,
    zoomPercent: ZoomPercentSchema,
    permissions: AccountPermissionsSchema,
    proxyMode: AccountProxyModeSchema,
    proxy: ProxyServerSchema.nullable(),
    /** F11 : l'aide « thème de WhatsApp » a été montrée pour ce compte. */
    themeHintShown: z.boolean()
  })
  .refine((account) => account.partition === partitionFor(account.id), {
    message: "partition incohérente avec l'identifiant du compte",
    path: ["partition"]
  })
  .refine((account) => account.proxyMode !== "manual" || account.proxy !== null, { message: "serveur requis en mode manuel", path: ["proxy"] });
export type AccountConfig = z.infer<typeof AccountConfigSchema>;

export const AccountsFileSchema = z
  .strictObject({
    schemaVersion: z.literal(2),
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
export const LanguagePreferenceSchema = z.enum(["system", "fr", "en"]);
export type LanguagePreference = z.infer<typeof LanguagePreferenceSchema>;
/** F5 : « off » par défaut, les dictionnaires venant des serveurs de Google (§24). */
export const SpellcheckModeSchema = z.enum(["off", "system", "custom"]);
export const TrayCountStyleSchema = z.enum(["number", "dot", "none"]);
export type TrayCountStyle = z.infer<typeof TrayCountStyleSchema>;
/** F1 : échelle de la coque et des paramètres, en pourcentage. */
export const InterfaceScaleSchema = z.int().min(90).max(150).refine((value) => value % 10 === 0, "palier de 10 %");

export const PrivacyVeilSchema = z.strictObject({
  /** F7a : voiler les vues quand la fenêtre perd le focus. */
  onBlur: z.boolean(),
  /** F7a : voiler les vues pendant un partage d'écran. */
  onScreenShare: z.boolean(),
  /** F7b, expérimental (niveau 3) : flou message par message. */
  blurMessages: z.boolean()
});
export type PrivacyVeil = z.infer<typeof PrivacyVeilSchema>;

export const PreferencesSchema = z.strictObject({
  schemaVersion: z.literal(2),
  launchAtLogin: z.boolean(),
  closeToTray: z.boolean(),
  startMinimized: z.boolean(),
  theme: ThemeSchema,
  /** Langues choisies, utilisées en mode « custom ». */
  spellcheckLanguages: z.array(z.string().max(16)).max(5),
  handleWhatsappLinks: z.boolean(),
  sidebarCollapsed: z.boolean(),
  askDownloadLocation: z.boolean(),
  onboardingDone: z.boolean(),
  language: LanguagePreferenceSchema,
  interfaceScale: InterfaceScaleSchema,
  spellcheckMode: SpellcheckModeSchema,
  /** 0 = ne pas garder d'historique. */
  downloadsHistoryDays: z.int().min(0).max(365),
  privacyVeil: PrivacyVeilSchema,
  proxy: GlobalProxySchema,
  trayCountStyle: TrayCountStyleSchema,
  /** F14 : démarrer un média met en pause ceux des autres comptes. */
  exclusivePlayback: z.boolean()
});
export type Preferences = z.infer<typeof PreferencesSchema>;

// --- Sécurité (F6, F9) : security.json, 0600 ------------------------------------------

const Base64 = z.string().max(4096).regex(/^[A-Za-z0-9+/]*={0,2}$/);

export const LockSettingsSchema = z.strictObject({
  enabled: z.boolean(),
  /** Empreinte scrypt du code ; jamais le code lui-même. */
  hash: Base64,
  salt: Base64,
  params: z.strictObject({ N: z.int().min(1024).max(2 ** 20), r: z.int().min(1).max(32), p: z.int().min(1).max(16) }),
  onStart: z.boolean(),
  onHide: z.boolean(),
  /** 0 = pas de verrouillage à l'inactivité. */
  idleMinutes: z.int().min(0).max(24 * 60),
  onScreenLock: z.boolean()
});
export type LockSettings = z.infer<typeof LockSettingsSchema>;

export const SecurityFileSchema = z.strictObject({
  schemaVersion: z.literal(1),
  lock: LockSettingsSchema,
  /** Échecs consécutifs : le délai croissant survit au redémarrage. */
  failures: z.strictObject({ count: z.int().min(0).max(1000), lastAt: IsoDateTime.nullable() }),
  /** Identifiants de proxy chiffrés par safeStorage (base64), par portée. */
  proxySecrets: z.strictObject({
    global: Base64.nullable(),
    accounts: z.record(z.uuid(), Base64)
  })
});
export type SecurityFile = z.infer<typeof SecurityFileSchema>;

// --- Historique des téléchargements (F2) : downloads.json, 0600 --------------------------

export const DownloadStateSchema = z.enum(["progressing", "completed", "cancelled", "interrupted"]);
export type DownloadState = z.infer<typeof DownloadStateSchema>;

export const DownloadRecordSchema = z.strictObject({
  id: z.uuid(),
  accountId: z.uuid(),
  fileName: z.string().min(1).max(260),
  path: z.string().min(1).max(4096),
  bytes: z.int().min(0),
  state: DownloadStateSchema,
  startedAt: IsoDateTime,
  finishedAt: IsoDateTime.optional()
});
export type DownloadRecord = z.infer<typeof DownloadRecordSchema>;

export const DownloadsFileSchema = z.strictObject({
  schemaVersion: z.literal(1),
  records: z.array(DownloadRecordSchema).max(1000)
});
export type DownloadsFile = z.infer<typeof DownloadsFileSchema>;

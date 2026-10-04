// Contrat IPC (§26) : canaux, état poussé vers l'UI, commandes reçues de l'UI.
// Toute commande est validée par zod dans le processus principal.

import { z } from "zod";
import { LABEL_MAX_LENGTH } from "./constants";
import type { Locale } from "./i18n";
import {
  AccountPermissionsSchema,
  AccountProxyModeSchema,
  FocusProfileSchema,
  GlobalProxySchema,
  InterfaceScaleSchema,
  LanguagePreferenceSchema,
  NotificationSettingsSchema,
  PrivacyVeilSchema,
  ProxyServerSchema,
  ZoomPercentSchema,
  ScheduleSchema,
  SpellcheckModeSchema,
  ThemeSchema,
  TrayCountStyleSchema,
  type AccountConfig,
  type FocusFile,
  type Mode,
  type Preferences,
  type Schedule
} from "./schemas";

export { CHANNELS } from "./channels";

export type Lifecycle = "sleeping" | "loading" | "needs_qr" | "ready" | "offline" | "crashed";
export type PolicySource = "default" | "manual" | "focus" | "schedule";

// --- État de la fenêtre principale ----------------------------------------------

export interface AccountItem {
  id: string;
  label: string;
  color: string;
  icon: string | null;
  /** n pour Ctrl+n, null au-delà de 9. */
  shortcut: number | null;
  lifecycle: Lifecycle;
  active: boolean;
  policy: { mode: Mode; source: PolicySource; until: string | null };
  unread: number | null;
  inCall: boolean;
  audible: boolean;
  memoryMB: number | null;
  /** F1 : zoom de la vue WhatsApp, en pourcentage. */
  zoomPercent: number;
  /** F14 : média en cours (ou en pause récente) dans ce compte. */
  playback: { playing: boolean; kind: "audio" | "video"; title: string | null } | null;
}

export interface LockView {
  enabled: boolean;
  locked: boolean;
  /** Prochain essai permis après plusieurs échecs (ISO). */
  retryAt: string | null;
  failed: boolean;
}

export interface Notice {
  id: string;
  level: "info" | "warning" | "error";
  message: string;
  /** Une information « sticky » ne s'efface pas d'elle-même. */
  sticky?: boolean;
  /** Action proposée dans la notice (par exemple « Mettre en veille »). */
  action?: { label: string; command: { type: "sleep-account"; id: string } };
}

export interface ShellState {
  productName: string;
  /** Langue de l'interface (F12) et étiquette BCP 47 pour les dates et nombres. */
  language: Locale;
  localeTag: string;
  accounts: AccountItem[];
  activeId: string | null;
  totalUnread: number;
  focus: { profiles: Array<{ id: string; name: string }>; activeProfileId: string | null; until: string | null };
  sidebarCollapsed: boolean;
  onboardingDone: boolean;
  /** Lien de conversation en attente du choix d'un compte (§23). id : une demande = un id. */
  pendingLink: { id: number; phone: string | null } | null;
  notices: Notice[];
  trayAvailable: boolean;
  /** F6 */
  lock: LockView;
  /** F7 */
  veiled: boolean;
  /** F14 : lecture affichée en pied de barre latérale. */
  nowPlaying: { accountId: string; label: string; playing: boolean; kind: "audio" | "video"; title: string | null } | null;
  /** F2 */
  downloads: { active: number; progress: number | null };
  /** F1 : zoom qui vient de changer, affiché brièvement. */
  zoomToast: { accountId: string; percent: number; sequence: number } | null;
}

export interface DownloadEntry {
  id: string;
  accountId: string;
  accountLabel: string;
  fileName: string;
  bytes: number;
  state: "progressing" | "completed" | "cancelled" | "interrupted";
  startedAt: string;
  finishedAt: string | null;
  missing: boolean;
  progress: number | null;
}

// --- État de la fenêtre des paramètres ----------------------------------------------

export type SettingsSection = "general" | "appearance" | "accounts" | "schedules" | "focus" | "files" | "downloads" | "security" | "network" | "about";

export interface SettingsState {
  productName: string;
  language: Locale;
  localeTag: string;
  /** Langues préférées du système, pour afficher le choix « Système (…) ». */
  systemLanguages: string[];
  disclaimer: string;
  preferences: Preferences;
  accounts: AccountConfig[];
  schedules: Schedule[];
  focus: FocusFile;
  trayAvailable: boolean;
  /** F5 : langues connues de Chromium, embarquées, et dictionnaire du système. */
  spellcheck: { available: string[]; bundled: string[]; systemDictionary: string | null; active: string[] };
  versions: { app: string; electron: string; chromium: string; node: string };
  paths: { userData: string; logs: string };
  memory: Record<string, number | null>;
  /** Navigation contextuelle ; le numéro change seulement sur demande explicite. */
  navigationRequest?: { section: SettingsSection; accountId?: string; sequence: number } | null;
  notices?: Notice[];
  /** F2 */
  downloads: DownloadEntry[];
  /** F6, F9 : jamais de code ni d'identifiant, seulement leur présence. */
  security: {
    lock: { enabled: boolean; onStart: boolean; onHide: boolean; idleMinutes: number; onScreenLock: boolean };
    secureStorage: boolean;
    proxyCredentials: { global: boolean; accounts: Record<string, boolean> };
  };
  /** F9 : dernier test de connexion, par portée (« global » ou compte). */
  proxyTests: Record<string, { ok: boolean; route: string; error?: string; running?: boolean }>;
}

// --- Commandes ------------------------------------------------------------------------

const Id = z.uuid();
const Point = { x: z.number().finite(), y: z.number().finite() };

export const SnoozePresetSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("minutes"), minutes: z.int().min(1).max(7 * 24 * 60) }),
  z.strictObject({ kind: z.literal("tomorrow-morning") }),
  z.strictObject({ kind: z.literal("next-monday") }),
  z.strictObject({ kind: z.literal("until"), until: z.iso.datetime({ offset: true }) }),
  z.strictObject({ kind: z.literal("indefinitely") })
]);
export type SnoozePresetInput = z.infer<typeof SnoozePresetSchema>;

const Color = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const Icon = z.string().max(16);

export const AccountPatchSchema = z.strictObject({
  label: z.string().trim().min(1).max(LABEL_MAX_LENGTH).optional(),
  color: Color.optional(),
  icon: Icon.nullable().optional(),
  notifications: NotificationSettingsSchema.partial().optional(),
  scheduleId: Id.nullable().optional(),
  autoSleepAfterMinutes: z.int().min(1).max(7 * 24 * 60).nullable().optional(),
  zoomPercent: ZoomPercentSchema.optional(),
  permissions: AccountPermissionsSchema.partial().optional(),
  proxyMode: AccountProxyModeSchema.optional(),
  proxy: ProxyServerSchema.nullable().optional()
});
export type AccountPatch = z.infer<typeof AccountPatchSchema>;

export const PreferencesPatchSchema = z.strictObject({
  launchAtLogin: z.boolean().optional(),
  closeToTray: z.boolean().optional(),
  startMinimized: z.boolean().optional(),
  theme: ThemeSchema.optional(),
  spellcheckLanguages: z.array(z.string().max(16)).max(5).optional(),
  handleWhatsappLinks: z.boolean().optional(),
  sidebarCollapsed: z.boolean().optional(),
  askDownloadLocation: z.boolean().optional(),
  onboardingDone: z.boolean().optional(),
  language: LanguagePreferenceSchema.optional(),
  interfaceScale: InterfaceScaleSchema.optional(),
  spellcheckMode: SpellcheckModeSchema.optional(),
  downloadsHistoryDays: z.int().min(0).max(365).optional(),
  privacyVeil: PrivacyVeilSchema.partial().optional(),
  proxy: GlobalProxySchema.optional(),
  trayCountStyle: TrayCountStyleSchema.optional(),
  exclusivePlayback: z.boolean().optional()
});
export type PreferencesPatch = z.infer<typeof PreferencesPatchSchema>;

const LockCode = z.string().max(128);
/** Portée d'un proxy : réglage global ou identifiant d'un compte. */
const ProxyScopeSchema = z.union([z.literal("global"), Id]);

export const CommandSchema = z.discriminatedUnion("type", [
  // Fenêtre principale
  z.strictObject({ type: z.literal("add-account"), label: z.string().max(200), color: Color.optional(), icon: Icon.optional() }),
  z.strictObject({ type: z.literal("switch-account"), id: Id }),
  z.strictObject({ type: z.literal("sleep-account"), id: Id }),
  z.strictObject({ type: z.literal("wake-account"), id: Id }),
  z.strictObject({ type: z.literal("reload-account"), id: Id }),
  z.strictObject({ type: z.literal("remove-account"), id: Id }),
  z.strictObject({ type: z.literal("request-remove-account"), id: Id }),
  z.strictObject({ type: z.literal("snooze"), id: Id, preset: SnoozePresetSchema }),
  z.strictObject({ type: z.literal("resume"), id: Id }),
  z.strictObject({ type: z.literal("account-menu"), id: Id, ...Point }),
  z.strictObject({ type: z.literal("snooze-menu"), id: Id, ...Point }),
  z.strictObject({ type: z.literal("focus-menu"), ...Point }),
  z.strictObject({ type: z.literal("set-modal"), open: z.boolean() }),
  z.strictObject({ type: z.literal("resolve-link"), accountId: Id.nullable() }),
  z.strictObject({ type: z.literal("reorder-accounts"), ids: z.array(Id).max(100) }),
  z.strictObject({ type: z.literal("dismiss-notice"), id: z.string().max(100) }),
  z.strictObject({
    type: z.literal("open-settings"),
    accountId: Id.optional(),
    section: z.enum(["general", "appearance", "accounts", "schedules", "focus", "files", "downloads", "security", "network", "about"]).optional()
  }),
  // Paramètres
  z.strictObject({ type: z.literal("update-account"), id: Id, patch: AccountPatchSchema }),
  z.strictObject({ type: z.literal("clear-cache"), id: Id }),
  z.strictObject({ type: z.literal("set-preferences"), patch: PreferencesPatchSchema }),
  z.strictObject({ type: z.literal("save-schedule"), schedule: ScheduleSchema }),
  z.strictObject({ type: z.literal("delete-schedule"), id: Id }),
  z.strictObject({ type: z.literal("request-delete-schedule"), id: Id }),
  z.strictObject({ type: z.literal("save-focus-profile"), profile: FocusProfileSchema }),
  z.strictObject({ type: z.literal("delete-focus-profile"), id: Id }),
  z.strictObject({ type: z.literal("request-delete-focus-profile"), id: Id }),
  z.strictObject({ type: z.literal("activate-focus"), profileId: Id.nullable(), minutes: z.int().min(1).max(7 * 24 * 60).nullable() }),
  z.strictObject({ type: z.literal("open-logs") }),
  // F1
  z.strictObject({ type: z.literal("zoom"), id: Id.optional(), action: z.enum(["in", "out", "reset"]) }),
  // F14
  z.strictObject({ type: z.literal("media-control"), id: Id, action: z.enum(["pause", "play"]) }),
  // F2
  z.strictObject({ type: z.literal("download-open"), id: Id }),
  z.strictObject({ type: z.literal("download-show"), id: Id }),
  z.strictObject({ type: z.literal("download-remove"), id: Id }),
  z.strictObject({ type: z.literal("downloads-clear") }),
  // F3
  z.strictObject({ type: z.literal("create-diagnostic-report") }),
  z.strictObject({ type: z.literal("report-problem") }),
  // F6
  z.strictObject({ type: z.literal("lock-now") }),
  z.strictObject({ type: z.literal("unlock"), code: LockCode }),
  z.strictObject({ type: z.literal("forgot-lock-code") }),
  z.strictObject({ type: z.literal("set-lock-code"), current: LockCode.nullable(), next: LockCode }),
  z.strictObject({ type: z.literal("disable-lock"), current: LockCode }),
  z.strictObject({
    type: z.literal("set-lock-options"),
    options: z.strictObject({ onStart: z.boolean(), onHide: z.boolean(), idleMinutes: z.int().min(0).max(24 * 60), onScreenLock: z.boolean() }).partial()
  }),
  // F7
  z.strictObject({ type: z.literal("toggle-veil") }),
  // F9
  z.strictObject({ type: z.literal("set-proxy-credentials"), scope: ProxyScopeSchema, username: z.string().max(255), password: z.string().max(255) }),
  z.strictObject({ type: z.literal("clear-proxy-credentials"), scope: ProxyScopeSchema }),
  z.strictObject({ type: z.literal("test-proxy"), scope: ProxyScopeSchema })
]);
export type Command = z.infer<typeof CommandSchema>;

// --- Messages du preload WhatsApp ---------------------------------------------------------

export const NotifyPayloadSchema = z.strictObject({
  id: z.int().min(0),
  title: z.string().max(500).transform((value) => value.slice(0, 200)),
  body: z.string().max(10_000).transform((value) => value.slice(0, 2000)),
  tag: z.string().max(500).transform((value) => value.slice(0, 200)),
  silent: z.boolean(),
  /** data: URL d'image (photo du contact), bornée à 256 Kio. */
  icon: z
    .string()
    .max(350_000)
    .regex(/^data:image\/(png|jpeg|webp|gif);base64,/)
    .nullable(),
  /** F10 : photo servie par un autre domaine, téléchargée par le processus principal. */
  iconUrl: z.string().max(2048).regex(/^https?:\/\//).nullable()
});
export type NotifyPayload = z.infer<typeof NotifyPayloadSchema>;

export const MediaPayloadSchema = z.strictObject({
  source: z.enum(["getUserMedia", "getDisplayMedia"]),
  event: z.enum(["start", "stop"]),
  trackKind: z.enum(["audio", "video"])
});
export type MediaPayload = z.infer<typeof MediaPayloadSchema>;

/** Signaux de l'adaptateur WhatsApp (§35, niveau 3, lecture seule). */
export const LinkStatePayloadSchema = z.strictObject({
  /** Écran de liaison (QR ou code) affiché. */
  linking: z.boolean(),
  /** Interface des conversations affichée (compte connecté). */
  chats: z.boolean()
});
export type LinkStatePayload = z.infer<typeof LinkStatePayloadSchema>;

export const EnvPayloadSchema = z.strictObject({
  userAgent: z.string().max(500),
  notificationOverridden: z.boolean(),
  scriptsBeforeOverride: z.int().min(0)
});
export type EnvPayload = z.infer<typeof EnvPayloadSchema>;

/** F14 : lecture observée par le preload (API standard des médias, niveau 1). */
export const PlaybackPayloadSchema = z.strictObject({
  state: z.enum(["playing", "paused", "ended"]),
  kind: z.enum(["audio", "video"]),
  title: z.string().max(300).nullable(),
  startedVisible: z.boolean()
});
export type PlaybackPayload = z.infer<typeof PlaybackPayloadSchema>;

export const VeilRevealPayloadSchema = z.strictObject({ kind: z.enum(["hover", "click"]) });
export const AdapterCheckPayloadSchema = z.strictObject({ messageBlur: z.boolean() });

export const VisibilityPayloadSchema = z.strictObject({
  state: z.enum(["visible", "hidden"]),
  hasFocus: z.boolean()
});

// Contrat IPC (§26) : canaux, état poussé vers l'UI, commandes reçues de l'UI.
// Toute commande est validée par zod dans le processus principal.

import { z } from "zod";
import { LABEL_MAX_LENGTH } from "./constants";
import {
  FocusProfileSchema,
  NotificationSettingsSchema,
  ScheduleSchema,
  ThemeSchema,
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
}

// --- État de la fenêtre des paramètres ----------------------------------------------

export interface SettingsState {
  productName: string;
  disclaimer: string;
  preferences: Preferences;
  accounts: AccountConfig[];
  schedules: Schedule[];
  focus: FocusFile;
  trayAvailable: boolean;
  spellcheckLanguages: string[];
  versions: { app: string; electron: string; chromium: string; node: string };
  paths: { userData: string; logs: string };
  memory: Record<string, number | null>;
  /** Navigation contextuelle ; le numéro change seulement sur demande explicite. */
  navigationRequest?: { section: "accounts" | "focus"; accountId?: string; sequence: number } | null;
  notices?: Notice[];
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
  autoSleepAfterMinutes: z.int().min(1).max(7 * 24 * 60).nullable().optional()
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
  onboardingDone: z.boolean().optional()
});
export type PreferencesPatch = z.infer<typeof PreferencesPatchSchema>;

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
  z.strictObject({ type: z.literal("open-settings"), accountId: Id.optional() }),
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
  z.strictObject({ type: z.literal("open-logs") })
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
    .nullable()
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

export const VisibilityPayloadSchema = z.strictObject({
  state: z.enum(["visible", "hidden"]),
  hasFocus: z.boolean()
});

// Types partagés main / preloads / coque.
// Import type uniquement depuis les preloads : un preload sandboxé ne peut pas
// charger de fichier local à l'exécution.

export type Lifecycle = "sleeping" | "loading" | "loaded" | "crashed" | "failed";

export interface AccountView {
  id: string;
  label: string;
  color: string;
  lifecycle: Lifecycle;
  visible: boolean;
  snoozed: boolean;
  unread: number | null;
  pageVisibility: string | null;
  micActive: boolean;
  camActive: boolean;
  screenShareActive: boolean;
  audible: boolean;
  memoryMB: number | null;
  cpuPercent: number | null;
}

export interface ShellState {
  accounts: AccountView[];
  activeId: string | null;
  totalUnread: number;
  totalMemoryMB: number | null;
  logsVisible: boolean;
  sidebarWidth: number;
  logHeight: number;
  targetUrl: string;
  platform: string;
}

export interface LogEntry {
  ts: string;
  level: "info" | "warn" | "error";
  account?: string;
  event: string;
  data?: unknown;
}

// Messages envoyés par le preload WhatsApp au main.
export interface NotifyPayload {
  id: number;
  title: string;
  body: string;
  tag: string;
  hasIcon: boolean;
  silent: boolean;
}

export interface MediaPayload {
  source: "getUserMedia" | "getDisplayMedia";
  event: "start" | "stop";
  trackKind: string;
}

export interface EnvPayload {
  href: string;
  userAgent: string;
  brands: string[];
  readyState: string;
  scriptsBeforeOverride: number;
  notificationOverridden: boolean;
}

export interface VisibilityPayload {
  state: string;
  hasFocus: boolean;
}

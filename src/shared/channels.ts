// Noms des canaux IPC, sans dépendance : importables par les preloads.

export const CHANNELS = {
  shellState: "shell:state",
  shellGetState: "shell:get-state",
  shellRequestAddAccount: "shell:request-add-account",
  shellRequestSnoozeDate: "shell:request-snooze-date",
  shellRequestFocusAccounts: "shell:request-focus-accounts",
  shellRequestShortcuts: "shell:request-shortcuts",
  settingsState: "settings:state",
  settingsGetState: "settings:get-state",
  command: "app:command",
  waNotify: "wa:notify",
  waNotificationClose: "wa:notification-close",
  waNotificationClick: "wa:notification-click",
  waMedia: "wa:media",
  waLinkState: "wa:link-state",
  waEnv: "wa:env",
  waSwNotification: "wa:sw-notification",
  waVisibility: "wa:visibility",
  /** F14 : lecture d'un média (page → principal) et commande Pause/Reprendre (principal → page). */
  waMediaPlayback: "wa:media-playback",
  waMediaControl: "wa:media-control",
  /** F14 : textes pour les métadonnées de lecture (« Message vocal »). */
  waLabels: "wa:labels",
  /** F7 : état du voile (principal → page), survol ou clic (page → principal), auto-test F7b. */
  waVeil: "wa:veil",
  waVeilReveal: "wa:veil-reveal",
  waAdapterCheck: "wa:adapter-check"
} as const;

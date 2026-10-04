// Noms des canaux IPC, sans dépendance : importables par les preloads.

export const CHANNELS = {
  shellState: "shell:state",
  shellGetState: "shell:get-state",
  shellRequestAddAccount: "shell:request-add-account",
  shellRequestSnoozeDate: "shell:request-snooze-date",
  shellRequestFocusAccounts: "shell:request-focus-accounts",
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
  waVisibility: "wa:visibility"
} as const;

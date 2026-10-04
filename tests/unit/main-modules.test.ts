import { describe, expect, it } from "vitest";
import { adapterTimeoutEvent, linkStateEvent } from "../../src/main/core/adapter";
import { safeFileName, uniqueFileName } from "../../src/main/core/downloads";
import { accountMenu, focusMenu, trayMenu, type MenuItemModel } from "../../src/main/core/menus";
import { isPermissionGranted, normalizeOrigin } from "../../src/main/core/permissions";
import { accountsToAutoSleep, RAM_SUGGESTION_MB, sleepSuggestion } from "../../src/main/core/resources";
import { looksLikeCallNotification } from "../../src/main/whatsapp-adapter/call-classifier";
import { formatRemaining, initials, statusHint, statusSymbol } from "../../src/shared/format";
import { CommandSchema, NotifyPayloadSchema, type AccountItem, type ShellState } from "../../src/shared/ipc";

const NOW = new Date("2026-10-05T10:00:00Z");
const ID = "3e6d9227-1b2c-4d3e-8f40-1a2b3c4d5e6f";

const item = (overrides: Partial<AccountItem> = {}): AccountItem => ({
  id: ID,
  label: "Travail",
  color: "#5b5bd6",
  icon: null,
  shortcut: 1,
  lifecycle: "ready",
  active: false,
  policy: { mode: "normal", source: "default", until: null },
  unread: 4,
  inCall: false,
  audible: false,
  memoryMB: null,
  ...overrides
});

const labels = (items: MenuItemModel[]): string[] => items.map((entry) => (entry.kind === "separator" ? "—" : entry.label));

describe("permissions (§26)", () => {
  it("normalise l'origine, avec ou sans barre finale", () => {
    expect(normalizeOrigin("https://web.whatsapp.com/")).toBe("https://web.whatsapp.com");
    expect(normalizeOrigin("pas une url")).toBe("");
    expect(normalizeOrigin(undefined)).toBe("");
  });

  it("n'accorde que la liste blanche, et seulement à WhatsApp", () => {
    expect(isPermissionGranted("notifications", "https://web.whatsapp.com/")).toBe(true);
    expect(isPermissionGranted("persistent-storage", "https://web.whatsapp.com")).toBe(true);
    expect(isPermissionGranted("geolocation", "https://web.whatsapp.com")).toBe(false);
    expect(isPermissionGranted("media", "https://evil.example")).toBe(false);
    expect(isPermissionGranted("media", "http://web.whatsapp.com")).toBe(false);
  });
});

describe("adaptateur WhatsApp (§35)", () => {
  it("traduit l'écran de liaison et l'interface des conversations", () => {
    expect(linkStateEvent("loading", { linking: true, chats: false }, false)).toBe("link-required");
    expect(linkStateEvent("loading", { linking: false, chats: true }, false)).toBe("session-valid");
    expect(linkStateEvent("needs_qr", { linking: false, chats: true }, false)).toBe("linked");
    expect(linkStateEvent("ready", { linking: true, chats: false }, true)).toBe("remote-logout");
    expect(linkStateEvent("offline", { linking: true, chats: false }, true)).toBe("remote-logout");
  });

  it("ignore les signaux sans objet (écran de chargement, compte en veille)", () => {
    expect(linkStateEvent("loading", { linking: false, chats: false }, false)).toBeNull();
    expect(linkStateEvent("ready", { linking: false, chats: true }, true)).toBeNull();
    expect(linkStateEvent("sleeping", { linking: true, chats: false }, true)).toBeNull();
  });
});

describe("veille automatique (§17)", () => {
  const base = { id: "a", autoSleepAfterMinutes: 30, sleeping: false, active: false, inCall: false, hiddenSince: NOW.getTime() - 31 * 60_000 };
  it("endort un compte caché depuis assez longtemps", () => {
    expect(accountsToAutoSleep([base], NOW.getTime())).toEqual(["a"]);
  });
  it("épargne le compte affiché, en appel, déjà endormi, sans option ou caché trop récemment", () => {
    const now = NOW.getTime();
    expect(accountsToAutoSleep([{ ...base, active: true, hiddenSince: null }], now)).toEqual([]);
    expect(accountsToAutoSleep([{ ...base, inCall: true }], now)).toEqual([]);
    expect(accountsToAutoSleep([{ ...base, sleeping: true }], now)).toEqual([]);
    const { autoSleepAfterMinutes: _option, ...withoutOption } = base;
    expect(accountsToAutoSleep([withoutOption], now)).toEqual([]);
    expect(accountsToAutoSleep([{ ...base, hiddenSince: now - 5 * 60_000 }], now)).toEqual([]);
  });
});

describe("téléchargements (§22)", () => {
  it("nettoie les noms de fichiers", () => {
    expect(safeFileName("../../etc/passwd")).toBe("_.._etc_passwd");
    expect(safeFileName(".bashrc")).toBe("bashrc");
    expect(safeFileName("   ")).toBe("fichier");
    expect(safeFileName("a\u0000b\nc.txt")).toBe("a_b_c.txt");
  });
  it("n'écrase jamais un fichier existant", () => {
    const taken = new Set(["rapport.pdf", "rapport (1).pdf"]);
    expect(uniqueFileName("rapport.pdf", (name) => taken.has(name))).toBe("rapport (2).pdf");
    expect(uniqueFileName("notes", (name) => name === "notes")).toBe("notes (1)");
  });
});

describe("reconnaissance des appels (§12, expérimental)", () => {
  it("reconnaît les libellés d'appel courants", () => {
    expect(looksLikeCallNotification("Paul", "Appel vocal entrant")).toBe(true);
    expect(looksLikeCallNotification("Paul", "Incoming video call")).toBe(true);
    expect(looksLikeCallNotification("Pablo", "Llamada de voz entrante")).toBe(true);
  });
  it("ne prend pas un message ordinaire pour un appel", () => {
    expect(looksLikeCallNotification("Marie", "Je t'appelle ce soir")).toBe(false);
    expect(looksLikeCallNotification("Rappel", "Réunion à 10 h")).toBe(false);
  });
});

describe("formats d'affichage", () => {
  it("formate une durée restante", () => {
    expect(formatRemaining(new Date(NOW.getTime() + 12 * 60_000), NOW)).toBe("12 min");
    expect(formatRemaining(new Date(NOW.getTime() + 102 * 60_000), NOW)).toBe("1h42");
    expect(formatRemaining(new Date(NOW.getTime() + 120 * 60_000), NOW)).toBe("2 h");
    expect(formatRemaining(new Date(NOW.getTime() + 3 * 24 * 60 * 60_000), NOW)).toBe("3 j");
    expect(formatRemaining(new Date("2026-11-20T12:00:00Z"), NOW, "Europe/Paris")).toBe("jusqu’au 20 nov.");
    expect(formatRemaining(new Date("2099-01-15T08:30:00Z"), NOW, "Europe/Paris")).toBe("jusqu’au 15 janv. 2099");
  });
  it("donne les initiales", () => {
    expect(initials("Personnel")).toBe("P");
    expect(initials("équipe produit")).toBe("ÉP");
    expect(initials("  ")).toBe("?");
  });
  it("choisit le symbole et l'indication d'état (§2.4)", () => {
    expect(statusSymbol(item())).toBe("●");
    expect(statusSymbol(item({ policy: { mode: "snoozed", source: "manual", until: null } }))).toBe("◐");
    expect(statusSymbol(item({ lifecycle: "sleeping" }))).toBe("○");
    expect(statusHint(item(), NOW)).toBe("4");
    expect(statusHint(item({ policy: { mode: "snoozed", source: "manual", until: "2026-10-05T11:42:00Z" } }), NOW)).toBe("Snooze · 1h42");
    expect(statusHint(item({ lifecycle: "sleeping" }), NOW)).toBe("En veille");
  });
});

describe("menus natifs (§18, §21)", () => {
  it("propose Snooze, veille et réactivation selon l'état du compte", () => {
    expect(labels(accountMenu(item(), { includeRemove: false }))).toEqual(["Afficher", "—", "Snooze", "—", "Mettre en veille", "Recharger WhatsApp", "Paramètres…"]);
    const snoozed = accountMenu(item({ policy: { mode: "snoozed", source: "manual", until: null } }), { includeRemove: true });
    expect(labels(snoozed)).toContain("Réactiver les notifications");
    expect(labels(snoozed)).toContain("Supprimer le compte…");
    expect(labels(accountMenu(item({ lifecycle: "sleeping" }), { includeRemove: false }))).toContain("Réveiller");
    const inCall = accountMenu(item({ inCall: true }), { includeRemove: false }).find((entry) => entry.kind === "action" && entry.label === "Mettre en veille");
    expect(inCall).toMatchObject({ enabled: false });
  });

  it("construit le menu du tray avec l'état de chaque compte", () => {
    const state: ShellState = {
      productName: "WhatHush",
      accounts: [item(), item({ id: "c41f7751-2c3d-4e4f-9a51-2b3c4d5e6f70", label: "Support", lifecycle: "sleeping", unread: null })],
      activeId: ID,
      totalUnread: 4,
      focus: { profiles: [{ id: "f", name: "Réunion" }], activeProfileId: "f", until: null },
      sidebarCollapsed: false,
      onboardingDone: true,
      pendingLink: null,
      notices: [],
      trayAvailable: true
    };
    const menu = labels(trayMenu(state, NOW));
    expect(menu[0]).toBe("WhatHush");
    expect(menu).toContain("●  Travail   4");
    expect(menu).toContain("○  Support   En veille");
    expect(menu.slice(-2)).toEqual(["Afficher", "Quitter"]);
    expect(labels(focusMenu(state))).toEqual(["Aucun", "✓ Réunion", "—", "Configurer les Focus…"]);
  });
});

describe("contrat IPC (§26)", () => {
  it("accepte les commandes valides et refuse le reste", () => {
    expect(CommandSchema.safeParse({ type: "switch-account", id: ID }).success).toBe(true);
    expect(CommandSchema.safeParse({ type: "snooze", id: ID, preset: { kind: "minutes", minutes: 30 } }).success).toBe(true);
    expect(CommandSchema.safeParse({ type: "switch-account", id: "pas-un-uuid" }).success).toBe(false);
    expect(CommandSchema.safeParse({ type: "switch-account", id: ID, extra: 1 }).success).toBe(false);
    expect(CommandSchema.safeParse({ type: "exec", command: "rm -rf /" }).success).toBe(false);
    expect(CommandSchema.safeParse({ type: "snooze", id: ID, preset: { kind: "minutes", minutes: 0 } }).success).toBe(false);
  });

  it("borne les notifications reçues des pages", () => {
    const parsed = NotifyPayloadSchema.parse({ id: 1, title: "x".repeat(400), body: "y".repeat(5000), tag: "", silent: false, icon: null });
    expect(parsed.title).toHaveLength(200);
    expect(parsed.body).toHaveLength(2000);
    expect(NotifyPayloadSchema.safeParse({ id: 1, title: "", body: "", tag: "", silent: false, icon: "javascript:alert(1)" }).success).toBe(false);
    expect(NotifyPayloadSchema.safeParse({ id: 1, title: "", body: "", tag: "", silent: false, icon: "data:image/svg+xml;base64,AAAA" }).success).toBe(false);
  });
});

describe("correctifs de la revue", () => {
  it("adaptateur : un compte hors ligne qui réaffiche ses conversations est reconnecté (§34)", () => {
    expect(linkStateEvent("offline", { linking: false, chats: true }, true)).toBe("network-restored");
  });

  it("appels : seul un libellé d'appel exact compte, pas un message qui en parle", () => {
    expect(looksLikeCallNotification("Paul", "Appel vidéo entrant")).toBe(true);
    expect(looksLikeCallNotification("Paul", "Appel vocal…")).toBe(true);
    expect(looksLikeCallNotification("Incoming voice call", "Paul")).toBe(true);
    expect(looksLikeCallNotification("Marie", "On se fait un appel vidéo ?")).toBe(false);
    expect(looksLikeCallNotification("Marie", "appel vocal demain à 10 h")).toBe(false);
  });

  it("autostart : arguments Exec échappés selon la spécification Desktop Entry", async () => {
    const { desktopExecArg } = await import("../../src/main/desktop/desktop");
    expect(desktopExecArg("/opt/App/app")).toBe('"/opt/App/app"');
    expect(desktopExecArg('/home/a b/50%/x"$`\\y.AppImage')).toBe('"/home/a b/50%%/x\\"\\$\\`\\\\y.AppImage"');
  });

  it("protocole app:// : aucun fichier hors du dossier du renderer", async () => {
    const { resolveRendererPath } = await import("../../src/main/renderer-protocol");
    const root = "/opt/App/resources/app.asar/dist/renderer";
    expect(resolveRendererPath(root, "app://renderer/index.html")).toBe(`${root}/index.html`);
    expect(resolveRendererPath(root, "app://renderer/assets/a.js?v=1")).toBe(`${root}/assets/a.js`);
    expect(resolveRendererPath(root, "app://renderer/../../package.json")).toBe(`${root}/package.json`);
    // Points encodés : l'analyseur d'URL les réduit avant nous, le chemin reste confiné.
    expect(resolveRendererPath(root, "app://renderer/%2e%2e/%2e%2e/main/index.cjs")).toBe(`${root}/main/index.cjs`);
    // Barres encodées : décodées après l'analyse, mais la normalisation absolue confine aussi.
    expect(resolveRendererPath(root, "app://renderer/..%2F..%2F..%2Fmain%2Findex.cjs")).toBe(`${root}/main/index.cjs`);
    expect(resolveRendererPath(root, "app://renderer/%E0%A4%A")).toBeNull();
    expect(resolveRendererPath(root, "app://autre/index.html")).toBeNull();
    expect(resolveRendererPath(root, "file:///etc/passwd")).toBeNull();
  });
});

describe("correctifs de la seconde revue", () => {
  it("un compte jamais relié qui affiche le QR après un échec n'est pas « déconnecté » (n°5)", () => {
    expect(linkStateEvent("offline", { linking: true, chats: false }, false)).toBe("link-required");
  });

  it("les conversations l'emportent sur un repère de liaison présent dans la même page (n°5)", () => {
    expect(linkStateEvent("ready", { linking: true, chats: true }, true)).toBeNull();
    expect(linkStateEvent("loading", { linking: true, chats: true }, false)).toBe("session-valid");
  });

  it("sans signal de l'adaptateur, un chargement réussi sort aussi de l'état hors ligne (n°2)", () => {
    expect(adapterTimeoutEvent("loading")).toBe("session-valid");
    expect(adapterTimeoutEvent("offline")).toBe("network-restored");
    expect(adapterTimeoutEvent("ready")).toBeNull();
  });

  it("l'appel en cours se voit dans le tray (§19)", () => {
    expect(statusHint(item({ inCall: true }), NOW)).toBe("En appel");
  });

  it("suggère d'endormir le compte caché depuis le plus longtemps, au-delà du seuil (§17)", () => {
    const now = NOW.getTime();
    const base = { sleeping: false, active: false, inCall: false, memoryMB: 400 };
    const inputs = [
      { ...base, id: "a", label: "A", hiddenSince: now - 40 * 60_000 },
      { ...base, id: "b", label: "B", hiddenSince: now - 3 * 60 * 60_000 },
      { ...base, id: "c", label: "C", hiddenSince: now - 5 * 60 * 60_000, inCall: true },
      { ...base, id: "d", label: "D", hiddenSince: now - 10 * 60_000 }
    ];
    expect(sleepSuggestion(RAM_SUGGESTION_MB + 1, inputs, now)?.id).toBe("b");
    expect(sleepSuggestion(RAM_SUGGESTION_MB - 1, inputs, now)).toBeNull();
    expect(sleepSuggestion(null, inputs, now)).toBeNull();
  });

  it("lit le fuseau du système depuis /etc/localtime (§13)", async () => {
    const { timeZoneFromZoneinfoPath } = await import("../../src/main/system-timezone");
    expect(timeZoneFromZoneinfoPath("/usr/share/zoneinfo/Europe/Paris")).toBe("Europe/Paris");
    expect(timeZoneFromZoneinfoPath("../usr/share/zoneinfo/America/Argentina/Buenos_Aires")).toBe("America/Argentina/Buenos_Aires");
    expect(timeZoneFromZoneinfoPath("/usr/share/zoneinfo/posix/Asia/Tokyo")).toBe("Asia/Tokyo");
    expect(timeZoneFromZoneinfoPath("/etc/localtime")).toBeNull();
  });

  it("le menu d'un compte propose un Snooze jusqu'à une date (§12)", () => {
    const snooze = accountMenu(item(), { includeRemove: false }).find((entry) => entry.kind === "submenu" && entry.label === "Snooze");
    expect(snooze && snooze.kind === "submenu" ? labels(snooze.items).at(-1) : null).toBe("Jusqu’à une date…");
  });
});

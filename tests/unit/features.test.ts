// Fonctions pures des fonctionnalités complémentaires (plan 1.1).
import { describe, expect, it } from "vitest";
import { AVATAR_CACHE_SIZE, isAllowedAvatarUrl, LruCache } from "../../src/main/core/avatar";
import { formatReport, redact, reportFileName, tail } from "../../src/main/core/diagnostic";
import { pruneHistory, withPresence } from "../../src/main/core/downloads";
import { failureDelayMs, parseLockSignal, parseSessionPath, retryAt, shouldLock, validCode } from "../../src/main/core/lock";
import { alwaysAllow, checkPermission, decidePermission } from "../../src/main/core/permissions";
import { PlaybackTracker, PAUSED_VISIBLE_MS, shouldMute } from "../../src/main/core/playback";
import { chromiumProxyConfig, effectiveProxy, needsRelay, webRtcPolicy } from "../../src/main/core/proxy";
import { trayIconName } from "../../src/main/core/tray";
import type { AccountPermissions, DownloadRecord, LockSettings } from "../../src/shared/schemas";
import { matchShortcut, nextZoom, SHORTCUTS, type KeyInput } from "../../src/shared/shortcuts";

const WA = "https://web.whatsapp.com";
const ID = "4f0c1d2e-3b4a-4c5d-8e6f-7a8b9c0d1e2f";
const key = (input: Partial<KeyInput> & { key: string }): KeyInput => ({ control: false, shift: false, alt: false, meta: false, ...input });

describe("raccourcis et zoom (F1)", () => {
  it("chaque raccourci a un identifiant et des touches uniques", () => {
    expect(new Set(SHORTCUTS.map((shortcut) => shortcut.id)).size).toBe(SHORTCUTS.length);
    expect(new Set(SHORTCUTS.map((shortcut) => shortcut.keys.join("+"))).size).toBe(SHORTCUTS.length);
  });

  it("aucune touche ne déclenche deux raccourcis", () => {
    const keys = ["1", "5", "9", "0", "Tab", ",", "F6", "=", "+", "-", "_", "/", "?", "h", "H", "l", "L", "v", "V", "a"];
    for (const k of keys) {
      for (const control of [false, true]) {
        for (const shift of [false, true]) {
          const input = key({ key: k, control, shift });
          expect(SHORTCUTS.filter((shortcut) => shortcut.match(input)).length, JSON.stringify(input)).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it("reconnaît Ctrl+1 et Ctrl+0 en AZERTY par la touche physique", () => {
    expect(matchShortcut(key({ key: "&", code: "Digit1", control: true }))?.id).toBe("switch-account");
    expect(matchShortcut(key({ key: "à", code: "Digit0", control: true }))?.id).toBe("zoom-reset");
    expect(matchShortcut(key({ key: "=", control: true }))?.id).toBe("zoom-in");
    expect(matchShortcut(key({ key: "+", code: "NumpadAdd", control: true }))?.id).toBe("zoom-in");
    expect(matchShortcut(key({ key: "-", control: true }))?.id).toBe("zoom-out");
    expect(matchShortcut(key({ key: "Tab", control: true, shift: true }))?.id).toBe("previous-account");
    expect(matchShortcut(key({ key: "H", control: true, shift: true }))?.id).toBe("veil");
    expect(matchShortcut(key({ key: "h", control: true }))).toBeUndefined();
    // Revue : en AZERTY, « - » est sur la touche 6 : zoom arrière, pas le compte 6.
    expect(matchShortcut(key({ key: "-", code: "Digit6", control: true }))?.id).toBe("zoom-out");
    expect(matchShortcut(key({ key: "_", code: "Digit8", control: true }))?.id).toBe("zoom-out");
    // Le compte 6 reste joignable : Ctrl+Maj+6 produit « 6 ».
    expect(matchShortcut(key({ key: "6", code: "Digit6", control: true, shift: true }))?.id).toBe("switch-account");
    // QWERTY : Ctrl+Maj+1 produit « ! », pas un raccourci de compte.
    expect(matchShortcut(key({ key: "!", code: "Digit1", control: true, shift: true }))).toBeUndefined();
    expect(matchShortcut(key({ key: "1", control: true, alt: true }))).toBeUndefined();
  });

  it("zoome par paliers de 10 %, entre 50 et 200 %", () => {
    expect(nextZoom(100, "in")).toBe(110);
    expect(nextZoom(100, "out")).toBe(90);
    expect(nextZoom(200, "in")).toBe(200);
    expect(nextZoom(50, "out")).toBe(50);
    expect(nextZoom(133, "in")).toBe(140);
    expect(nextZoom(170, "reset")).toBe(100);
  });
});

describe("icône du tray (F4)", () => {
  it("choisit l'image selon le total et le style", () => {
    expect(trayIconName(0, "number")).toBe("tray");
    expect(trayIconName(1, "number")).toBe("tray-1");
    expect(trayIconName(9, "number")).toBe("tray-9");
    expect(trayIconName(10, "number")).toBe("tray-9plus");
    expect(trayIconName(1000, "number")).toBe("tray-9plus");
    expect(trayIconName(3, "dot")).toBe("tray-unread");
    expect(trayIconName(3, "none")).toBe("tray");
  });
});

describe("lecture des médias (F14)", () => {
  const report = (state: "playing" | "paused" | "ended", startedVisible = true) => ({ state, kind: "audio" as const, title: null, startedVisible });

  it("suit lecture, pause et fin par page, et en déduit l'état du compte", () => {
    const tracker = new PlaybackTracker();
    expect(tracker.report("a", 1, report("playing"), 1000)).toBe(true);
    expect(tracker.forAccount("a", 1000)).toMatchObject({ playing: true, userStarted: true, webContentsId: 1 });
    expect(tracker.report("a", 1, report("paused"), 2000)).toBe(false);
    expect(tracker.forAccount("a", 2000)).toMatchObject({ playing: false });
    // Une pause ancienne n'est plus proposée.
    expect(tracker.forAccount("a", 2000 + PAUSED_VISIBLE_MS + 1)).toBeNull();
    expect(tracker.report("a", 1, report("playing"), 3000)).toBe(true);
    tracker.report("a", 1, report("ended"), 4000);
    expect(tracker.forAccount("a", 4000)).toBeNull();
  });

  it("oublie la lecture d'une page fermée ou d'un compte endormi", () => {
    const tracker = new PlaybackTracker();
    tracker.report("a", 1, report("playing"), 0);
    tracker.report("b", 2, report("playing"), 0);
    expect(tracker.playingPagesExcept("a")).toEqual([2]);
    tracker.pageGone(1);
    expect(tracker.forAccount("a", 0)).toBeNull();
    tracker.accountGone("b");
    expect(tracker.forAccount("b", 0)).toBeNull();
  });

  it("une reprise garde l'origine de la lecture (lancée par l'utilisateur)", () => {
    const tracker = new PlaybackTracker();
    tracker.report("a", 1, report("playing", true), 0);
    tracker.report("a", 1, report("paused", true), 10);
    tracker.report("a", 1, report("playing", false), 20);
    expect(tracker.forAccount("a", 20)?.userStarted).toBe(true);
  });

  it("le Snooze ne coupe jamais une lecture lancée par l'utilisateur", () => {
    expect(shouldMute({ muteWhenHidden: true, shown: false, inCall: false, userPlayback: false })).toBe(true);
    expect(shouldMute({ muteWhenHidden: true, shown: false, inCall: false, userPlayback: true })).toBe(false);
    expect(shouldMute({ muteWhenHidden: true, shown: false, inCall: true, userPlayback: false })).toBe(false);
    expect(shouldMute({ muteWhenHidden: true, shown: true, inCall: false, userPlayback: false })).toBe(false);
    expect(shouldMute({ muteWhenHidden: false, shown: false, inCall: false, userPlayback: false })).toBe(false);
  });
});

describe("historique des téléchargements (F2)", () => {
  const record = (id: string, startedAt: string, state: DownloadRecord["state"] = "completed"): DownloadRecord => ({
    id: `${id}0000000-0000-4000-8000-000000000000`.slice(0, 36),
    accountId: ID,
    fileName: `${id}.pdf`,
    path: `/tmp/${id}.pdf`,
    bytes: 10,
    state,
    startedAt,
    ...(state === "progressing" ? {} : { finishedAt: startedAt })
  });
  const now = new Date("2026-10-05T12:00:00Z");

  it("garde la rétention choisie, les plus récents d'abord", () => {
    const records = [record("a", "2026-08-01T00:00:00Z"), record("b", "2026-10-04T00:00:00Z"), record("c", "2026-09-20T00:00:00Z")];
    expect(pruneHistory(records, now, 30).map((entry) => entry.fileName)).toEqual(["b.pdf", "c.pdf"]);
    expect(pruneHistory(records, now, 7).map((entry) => entry.fileName)).toEqual(["b.pdf"]);
  });

  it("sans historique, ne garde que les téléchargements en cours", () => {
    const records = [record("a", "2026-10-05T11:00:00Z"), record("b", "2026-10-05T11:59:00Z", "progressing")];
    expect(pruneHistory(records, now, 0).map((entry) => entry.fileName)).toEqual(["b.pdf"]);
  });

  it("signale un fichier terminé mais déplacé comme introuvable", () => {
    const views = withPresence([record("a", "2026-10-05T11:00:00Z"), record("b", "2026-10-05T11:00:00Z", "cancelled")], () => false);
    expect(views.map((view) => view.missing)).toEqual([true, false]);
  });
});

describe("autorisations par compte (F8)", () => {
  const settings: AccountPermissions = { microphone: "allow", camera: "ask", location: "deny", screenShare: "ask" };

  it("refuse toujours une autre origine, quel que soit le réglage", () => {
    expect(decidePermission({ permission: "media", origin: "https://evil.example", mediaTypes: ["audio"] }, { ...settings }, WA).decision).toBe("deny");
    expect(decidePermission({ permission: "notifications", origin: "https://evil.example" }, settings, WA).decision).toBe("deny");
  });

  it("décide micro et caméra séparément", () => {
    expect(decidePermission({ permission: "media", origin: `${WA}/`, mediaTypes: ["audio"] }, settings, WA)).toEqual({ decision: "grant", subject: "microphone" });
    expect(decidePermission({ permission: "media", origin: WA, mediaTypes: ["video"] }, settings, WA)).toEqual({ decision: "ask", subject: "camera" });
    expect(decidePermission({ permission: "media", origin: WA, mediaTypes: ["audio", "video"] }, settings, WA)).toEqual({ decision: "ask", subject: "microphoneCamera" });
    expect(decidePermission({ permission: "media", origin: WA, mediaTypes: ["audio", "video"] }, { ...settings, microphone: "deny" }, WA).decision).toBe("deny");
    // Type inconnu : les deux sont nécessaires.
    expect(decidePermission({ permission: "media", origin: WA, mediaTypes: [] }, settings, WA).decision).toBe("ask");
  });

  it("applique localisation et partage d'écran, laisse les autres permissions à l'application", () => {
    expect(decidePermission({ permission: "geolocation", origin: WA }, settings, WA).decision).toBe("deny");
    expect(decidePermission({ permission: "geolocation", origin: WA }, { ...settings, location: "ask" }, WA)).toEqual({ decision: "ask", subject: "location" });
    expect(decidePermission({ permission: "display-capture", origin: WA }, settings, WA).decision).toBe("grant");
    expect(decidePermission({ permission: "display-capture", origin: WA }, { ...settings, screenShare: "deny" }, WA).decision).toBe("deny");
    expect(decidePermission({ permission: "notifications", origin: WA }, settings, WA).decision).toBe("grant");
    expect(decidePermission({ permission: "midi", origin: WA }, settings, WA).decision).toBe("deny");
  });

  it("répond aux vérifications sans bloquer la demande quand le réglage est « Demander »", () => {
    expect(checkPermission("media", WA, "video", settings, WA)).toBe(true);
    expect(checkPermission("media", WA, "audio", { ...settings, microphone: "deny" }, WA)).toBe(false);
    expect(checkPermission("geolocation", WA, undefined, settings, WA)).toBe(false);
    expect(checkPermission("media", "https://evil.example", "audio", settings, WA)).toBe(false);
  });

  it("« Toujours pour ce compte » autorise ce qui a été demandé", () => {
    expect(alwaysAllow(settings, "microphoneCamera")).toMatchObject({ microphone: "allow", camera: "allow" });
    expect(alwaysAllow(settings, "location")).toMatchObject({ location: "allow" });
  });
});

describe("verrouillage (F6)", () => {
  const lock: LockSettings = { enabled: true, hash: "", salt: "", params: { N: 1024, r: 8, p: 1 }, onStart: true, onHide: false, idleMinutes: 15, onScreenLock: true };

  it("impose un délai croissant plafonné à 60 s", () => {
    expect([0, 1, 2, 3, 4, 7, 8, 30].map(failureDelayMs)).toEqual([0, 1000, 2000, 4000, 8000, 60000, 60000, 60000]);
    const now = new Date("2026-10-05T12:00:00Z");
    expect(retryAt({ count: 3, lastAt: "2026-10-05T11:59:58Z" }, now)?.toISOString()).toBe("2026-10-05T12:00:02.000Z");
    expect(retryAt({ count: 3, lastAt: "2026-10-05T11:59:00Z" }, now)).toBeNull();
    expect(retryAt({ count: 0, lastAt: null }, now)).toBeNull();
  });

  it("verrouille selon les déclencheurs choisis", () => {
    expect(shouldLock(lock, "start")).toBe(true);
    expect(shouldLock(lock, "hide")).toBe(false);
    expect(shouldLock(lock, "idle", 14 * 60)).toBe(false);
    expect(shouldLock(lock, "idle", 15 * 60)).toBe(true);
    expect(shouldLock(lock, "screen-lock")).toBe(true);
    expect(shouldLock({ ...lock, enabled: false }, "manual")).toBe(false);
    expect(shouldLock({ ...lock, idleMinutes: 0 }, "idle", 99_999)).toBe(false);
  });

  it("valide la longueur du code", () => {
    expect(validCode("123")).toBe(false);
    expect(validCode("1234")).toBe(true);
    expect(validCode("x".repeat(129))).toBe(false);
  });

  it("lit le verrouillage de session dans la sortie de gdbus monitor", () => {
    expect(parseLockSignal("/org/freedesktop/login1/session/_32: org.freedesktop.login1.Session.Lock ()")).toBe(true);
    expect(parseLockSignal("/org/freedesktop/login1/session/_32: org.freedesktop.login1.Session.Unlock ()")).toBe(false);
    expect(parseLockSignal("/org/freedesktop/login1/session/_32: org.freedesktop.DBus.Properties.PropertiesChanged ('org.freedesktop.login1.Session', {'LockedHint': <true>}, @as [])")).toBe(true);
    expect(parseLockSignal("/org/freedesktop/login1/session/_32: org.freedesktop.DBus.Properties.PropertiesChanged ('org.freedesktop.login1.Session', {'LockedHint': <false>}, @as [])")).toBe(false);
    expect(parseLockSignal("/ScreenSaver: org.freedesktop.ScreenSaver.ActiveChanged (true,)")).toBe(true);
    expect(parseLockSignal("/org/gnome/ScreenSaver: org.gnome.ScreenSaver.ActiveChanged (false,)")).toBe(false);
    expect(parseLockSignal("/org/freedesktop/login1: org.freedesktop.login1.Manager.SessionNew ('3', objectpath '/x')")).toBeNull();
    expect(parseSessionPath("(objectpath '/org/freedesktop/login1/session/_32',)")).toBe("/org/freedesktop/login1/session/_32");
    expect(parseSessionPath("Error: GDBus.Error")).toBeNull();
  });
});

describe("rapport de diagnostic (F3)", () => {
  it("retire noms de comptes, dossier personnel, proxy, e-mails et numéros", () => {
    const text = 'compte "Équipe produit" et "Équipe" ; /home/marie/.config/mcdesk ; proxy.corp.example:3128 ; marie@exemple.fr ; +33 6 12 34 56 78';
    const output = redact(text, { labels: ["Équipe", "Équipe produit"], home: "/home/marie", proxyHosts: ["proxy.corp.example"], accountName: (n) => `Account ${n}` });
    expect(output).toBe('compte "Account 2" et "Account 1" ; ~/.config/mcdesk ; [proxy]:3128 ; [e-mail] ; [phone]');
  });

  it("met en forme les sections et garde les dernières lignes du journal", () => {
    expect(tail("a\nb\nc\n", 2)).toEqual(["b", "c"]);
    expect(formatReport("R", [{ title: "S", lines: [["clé", true], ["vide", null]] }])).toBe("R\n=\n\n## S\n\nclé : true\nvide : —\n");
    expect(reportFileName("WhatHush", new Date(2026, 9, 5, 14, 30, 12))).toBe("whathush-diagnostic-20261005-143012.txt");
  });
});

describe("proxy (F9)", () => {
  const server = { type: "http" as const, host: "proxy.local", port: 3128, auth: true };
  const account = { id: ID, proxyMode: "inherit" as const, proxy: null };

  it("hérite du réglage global ou applique l'exception du compte", () => {
    expect(effectiveProxy({ mode: "system", server: null }, account)).toEqual({ mode: "system" });
    expect(effectiveProxy({ mode: "manual", server }, account)).toEqual({ mode: "fixed", server, scope: "global" });
    expect(effectiveProxy({ mode: "manual", server }, { ...account, proxyMode: "none" })).toEqual({ mode: "direct" });
    const own = { type: "socks5" as const, host: "10.0.0.2", port: 1080, auth: false };
    expect(effectiveProxy({ mode: "none", server: null }, { id: ID, proxyMode: "manual", proxy: own })).toEqual({ mode: "fixed", server: own, scope: ID });
  });

  it("construit les règles Chromium, avec le relais pour un SOCKS5 authentifié", () => {
    expect(chromiumProxyConfig({ mode: "direct" })).toEqual({ mode: "direct" });
    expect(chromiumProxyConfig({ mode: "fixed", server, scope: "global" })).toEqual({ mode: "fixed_servers", proxyRules: "http://proxy.local:3128" });
    const socks = { mode: "fixed" as const, server: { type: "socks5" as const, host: "s.example", port: 1080, auth: true }, scope: "global" };
    expect(needsRelay(socks)).toBe(true);
    expect(chromiumProxyConfig(socks, { relayPort: 40123 }).proxyRules).toBe("socks5://127.0.0.1:40123");
    expect(chromiumProxyConfig({ ...socks, server: { ...socks.server, auth: false } }).proxyRules).toBe("socks5://s.example:1080");
    expect(chromiumProxyConfig({ mode: "fixed", server, scope: "global" }, { includeLoopback: true }).proxyBypassRules).toBe("<-loopback>");
  });

  it("empêche les appels de contourner un proxy actif", () => {
    expect(webRtcPolicy({ mode: "fixed", server, scope: "global" })).toBe("disable_non_proxied_udp");
    expect(webRtcPolicy({ mode: "system" })).toBe("default");
  });
});

describe("photos des notifications (F10)", () => {
  it("n'accepte que https://*.whatsapp.net", () => {
    expect(isAllowedAvatarUrl("https://pps.whatsapp.net/v/t61/abc.jpg?oh=1&oe=2")).toBe(true);
    expect(isAllowedAvatarUrl("https://media-cdg2-1.cdn.whatsapp.net/x")).toBe(true);
    expect(isAllowedAvatarUrl("http://pps.whatsapp.net/x")).toBe(false);
    expect(isAllowedAvatarUrl("https://pps.whatsapp.net.evil.example/x")).toBe(false);
    expect(isAllowedAvatarUrl("https://evil.example/whatsapp.net")).toBe(false);
    expect(isAllowedAvatarUrl("https://user:pw@pps.whatsapp.net/x")).toBe(false);
    expect(isAllowedAvatarUrl("https://pps.whatsapp.net:8443/x")).toBe(false);
    expect(isAllowedAvatarUrl("http://127.0.0.1:4000/a.png", ["http://127.0.0.1:4000"])).toBe(true);
  });

  it("garde un cache LRU borné", () => {
    const cache = new LruCache<number>(2);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.get("a");
    cache.set("c", 3);
    expect([cache.get("a"), cache.get("b"), cache.get("c")]).toEqual([1, undefined, 3]);
    expect(AVATAR_CACHE_SIZE).toBe(100);
  });
});

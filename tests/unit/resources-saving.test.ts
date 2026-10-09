// Économies de ressources : décisions pures (mode économie, présence, recyclage),
// sonde de présentation, service de présence, garde-fous de démarrage.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ECONOMY_TIMING, economyActions, economyApplies, relayFinished, type EconomyAccount, type EconomyContext } from "../../src/main/core/economy";
import { nextAway } from "../../src/main/core/presence";
import { RECYCLE, recycleCandidate, type RecycleInput } from "../../src/main/core/resources";
import { claimInstance, handOver, orphanedProcesses, otherInstance, processIdentity, releaseInstance, takeHandOver } from "../../src/main/instance-guard";
import type { Logger } from "../../src/main/log";
import { PresenceService } from "../../src/main/presence/presence-service";
import { PresentationProbe } from "../../src/shared/presentation";

const silent: Logger = { dir: "", debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };
const NOW = 10 * 60 * 60_000;
const MIN = 60_000;

describe("mode économie : décisions", () => {
  const base: EconomyAccount = {
    id: "a",
    delivery: "periodic",
    sleeping: false,
    shown: false,
    inCall: false,
    playing: false,
    lifecycle: "ready",
    hiddenSince: NOW - 6 * MIN,
    dozing: false,
    nextRelayAt: null,
    relay: null
  };
  const context: EconomyContext = { now: NOW, intervalMinutes: 30, inTray: false, windowHiddenSince: null, timing: ECONOMY_TIMING };

  it("s'endort caché depuis 5 min, jamais affiché, en appel, en lecture ou à scanner", () => {
    expect(economyActions([base], context)).toEqual([{ type: "doze", id: "a" }]);
    expect(economyActions([{ ...base, hiddenSince: NOW - 4 * MIN }], context)).toEqual([]);
    expect(economyActions([{ ...base, shown: true, hiddenSince: null }], context)).toEqual([]);
    expect(economyActions([{ ...base, inCall: true }], context)).toEqual([]);
    expect(economyActions([{ ...base, playing: true }], context)).toEqual([]);
    expect(economyActions([{ ...base, lifecycle: "needs_qr" }], context)).toEqual([]);
    expect(economyActions([{ ...base, delivery: "realtime" }], context)).toEqual([]);
    // Veille demandée par l'utilisateur : jamais de relève.
    expect(economyActions([{ ...base, sleeping: true, dozing: true, nextRelayAt: NOW - 1 }], context)).toEqual([{ type: "wake", id: "a" }]);
  });

  it("relève à l'heure prévue, puis se rendort une fois la page installée et les notifications calmées", () => {
    const dozing = { ...base, lifecycle: "sleeping" as const, dozing: true, nextRelayAt: NOW + MIN };
    expect(economyActions([dozing], context)).toEqual([]);
    expect(economyActions([{ ...dozing, nextRelayAt: NOW }], context)).toEqual([{ type: "relay", id: "a" }]);
    const relay = { startedAt: NOW - 90_000, readyAt: NOW - 70_000, lastActivityAt: NOW - 70_000 };
    expect(relayFinished(relay, NOW, ECONOMY_TIMING)).toBe(true);
    // Une notification récente prolonge la relève…
    expect(relayFinished({ ...relay, lastActivityAt: NOW - 5_000 }, NOW, ECONOMY_TIMING)).toBe(false);
    // … mais jamais au-delà de 4 min ; une page encore en chargement attend.
    expect(relayFinished({ startedAt: NOW - 5 * MIN, readyAt: null, lastActivityAt: NOW }, NOW, ECONOMY_TIMING)).toBe(true);
    expect(relayFinished({ startedAt: NOW - MIN, readyAt: null, lastActivityAt: NOW - MIN }, NOW, ECONOMY_TIMING)).toBe(false);
    expect(economyActions([{ ...base, relay }], context)).toEqual([{ type: "doze", id: "a" }]);
  });

  it("affiché, ou repassé en continu : le compte endormi se réveille", () => {
    const dozing = { ...base, lifecycle: "sleeping" as const, dozing: true, nextRelayAt: NOW + 10 * MIN };
    expect(economyActions([{ ...dozing, shown: true }], context)).toEqual([{ type: "wake", id: "a" }]);
    expect(economyActions([{ ...dozing, delivery: "realtime" }], context)).toEqual([{ type: "wake", id: "a" }]);
  });

  it("économie maximale : dans la barre système depuis 5 min, tous les comptes", () => {
    const realtime = { ...base, delivery: "realtime" as const };
    const tray = { ...context, inTray: true, windowHiddenSince: NOW - 6 * MIN };
    expect(economyApplies(realtime, tray)).toBe(true);
    expect(economyApplies(realtime, { ...tray, windowHiddenSince: NOW - 2 * MIN })).toBe(false);
    expect(economyApplies(realtime, { ...tray, inTray: false })).toBe(false);
    expect(economyActions([realtime], tray)).toEqual([{ type: "doze", id: "a" }]);
  });
});

describe("présence", () => {
  it("absent au-delà du seuil, de retour à la première action, jamais si l'option est désactivée", () => {
    expect(nextAway({ awayHideMinutes: 5, idleSeconds: 299, wasAway: false })).toBe(false);
    expect(nextAway({ awayHideMinutes: 5, idleSeconds: 300, wasAway: false })).toBe(true);
    expect(nextAway({ awayHideMinutes: 5, idleSeconds: 120, wasAway: true })).toBe(true);
    expect(nextAway({ awayHideMinutes: 5, idleSeconds: 2, wasAway: true })).toBe(false);
    expect(nextAway({ awayHideMinutes: 0, idleSeconds: 9999, wasAway: false })).toBe(false);
  });

  it("sonde de présentation : deux images manquées = fenêtre non présentée, la suivante la rétablit", () => {
    const probe = new PresentationProbe(2);
    expect(probe.tick(true)).toEqual({ request: true, presented: null });
    expect(probe.frame()).toBeNull();
    expect(probe.tick(true)).toEqual({ request: true, presented: null });
    // Plus d'images (fenêtre réduite) : la demande reste en attente.
    expect(probe.tick(true)).toEqual({ request: false, presented: null });
    expect(probe.tick(true)).toEqual({ request: false, presented: false });
    expect(probe.tick(true)).toEqual({ request: false, presented: null });
    // L'image attendue arrive : la fenêtre est de nouveau présentée.
    expect(probe.frame()).toBe(true);
    // Fenêtre masquée (Electron le sait) : la sonde ne conclut rien.
    expect(probe.tick(false)).toEqual({ request: false, presented: null });

    // Sonde relancée alors que le processus principal croit la fenêtre non présentée (sonde
    // arrêtée fenêtre réduite) : la première image le corrige.
    const restarted = new PresentationProbe(2, false);
    expect(restarted.tick(true)).toEqual({ request: true, presented: null });
    expect(restarted.frame()).toBe(true);
  });

  describe("PresenceService", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("relève l'inactivité toutes les 30 s, toutes les 2 s pendant l'absence, rien fenêtre masquée", () => {
      let idle = 0;
      const reads = vi.fn(() => idle);
      const presence = new PresenceService({ log: silent, idleSeconds: reads, awayHideMinutes: () => 5 });
      const changes = vi.fn();
      presence.on("changed", changes);
      presence.start();
      idle = 301;
      vi.advanceTimersByTime(30_000);
      expect(presence.isAway()).toBe(true);
      expect(presence.attended()).toBe(false);
      idle = 1;
      vi.advanceTimersByTime(2_000);
      expect(presence.isAway()).toBe(false);
      expect(changes).toHaveBeenCalledTimes(2);
      presence.setWindowVisible(false);
      const before = reads.mock.calls.length;
      vi.advanceTimersByTime(10 * 60_000);
      expect(reads.mock.calls.length).toBe(before);
      presence.stop();
    });

    it("fenêtre non présentée : personne ne la voit ; option à « jamais » : aucun relevé", () => {
      const reads = vi.fn(() => 9999);
      const presence = new PresenceService({ log: silent, idleSeconds: reads, awayHideMinutes: () => 0 });
      presence.start();
      vi.advanceTimersByTime(10 * 60_000);
      expect(reads).not.toHaveBeenCalled();
      expect(presence.attended()).toBe(true);
      presence.setPresented(false);
      expect(presence.attended()).toBe(false);
      presence.setPresented(true);
      expect(presence.attended()).toBe(true);
      presence.stop();
    });
  });
});

describe("recyclage", () => {
  const input: RecycleInput = {
    id: "a",
    lifecycle: "ready",
    rssMB: 900,
    baselineMB: 350,
    active: false,
    inCall: false,
    playing: false,
    hiddenSince: NOW - 2 * 60 * MIN,
    lastRecycledAt: null
  };

  it("recharge une page cachée qui a doublé, pendant une absence ou fenêtre masquée", () => {
    expect(recycleCandidate([input], { now: NOW, userAway: true, windowHidden: false })).toBe("a");
    expect(recycleCandidate([input], { now: NOW, userAway: false, windowHidden: true })).toBe("a");
    // Utilisateur présent : seulement après 4 h cachée.
    expect(recycleCandidate([input], { now: NOW, userAway: false, windowHidden: false })).toBeNull();
    expect(recycleCandidate([{ ...input, hiddenSince: NOW - 5 * 60 * MIN }], { now: NOW, userAway: false, windowHidden: false })).toBe("a");
  });

  it("jamais affichée, en appel, en lecture, peu gonflée, ni deux fois en 12 h", () => {
    const away = { now: NOW, userAway: true, windowHidden: true };
    expect(recycleCandidate([{ ...input, active: true }], away)).toBeNull();
    expect(recycleCandidate([{ ...input, inCall: true }], away)).toBeNull();
    expect(recycleCandidate([{ ...input, playing: true }], away)).toBeNull();
    expect(recycleCandidate([{ ...input, rssMB: 650 }], away)).toBeNull();
    expect(recycleCandidate([{ ...input, baselineMB: 500 }], away)).toBeNull();
    expect(recycleCandidate([{ ...input, hiddenSince: NOW - 30 * MIN }], away)).toBeNull();
    expect(recycleCandidate([{ ...input, lastRecycledAt: NOW - RECYCLE.everyMs + MIN }], away)).toBeNull();
    expect(recycleCandidate([{ ...input, baselineMB: null }], away)).toBeNull();
    // Le plus gros d'abord, un seul à la fois.
    expect(recycleCandidate([input, { ...input, id: "b", rssMB: 1200 }], away)).toBe("b");
  });
});

describe("garde-fous de démarrage", () => {
  let root: string;
  let userData: string;

  /** Faux /proc : processus avec ligne de commande, parent et date de démarrage. */
  function proc(pid: number, ppid: number, command: string[], comm = "electron", start = 1000): void {
    const dir = path.join(root, String(pid));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "cmdline"), command.join("\0"));
    fs.writeFileSync(path.join(dir, "comm"), `${comm}\n`);
    const fields = ["S", String(ppid), ...Array.from({ length: 17 }, () => "0"), String(start)];
    fs.writeFileSync(path.join(dir, "stat"), `${pid} (${comm}) ${fields.join(" ")} 0 0`);
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "fake-proc-"));
    userData = fs.mkdtempSync(path.join(os.tmpdir(), "whathush-data-"));
    fs.mkdirSync(path.join(root, "sys", "kernel", "random"), { recursive: true });
    fs.writeFileSync(path.join(root, "sys", "kernel", "random", "boot_id"), "boot-1\n");
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(userData, { recursive: true, force: true });
  });

  it("instance unique : une instance vivante est reconnue, un PID réutilisé ou mort ne l'est pas", () => {
    proc(100, 1, ["/opt/WhatHush/whathush"], "whathush", 5000);
    proc(200, 1, ["/opt/WhatHush/whathush"], "whathush", 7000);
    expect(processIdentity(100, root)).toBe("boot-1:5000");
    claimInstance(userData, 100, root);
    expect(otherInstance(userData, 200, root)).toBe(100);
    expect(otherInstance(userData, 100, root)).toBeNull();
    // Même PID, autre processus (redémarrage, réutilisation) : pas une instance.
    fs.rmSync(path.join(root, "100"), { recursive: true });
    proc(100, 1, ["/usr/bin/bash"], "bash", 9000);
    expect(otherInstance(userData, 200, root)).toBeNull();
    releaseInstance(userData, 200);
    expect(fs.existsSync(path.join(userData, "instance.json"))).toBe(true);
    releaseInstance(userData, 100);
    expect(fs.existsSync(path.join(userData, "instance.json"))).toBe(false);
  });

  it("seconde instance : sa ligne de commande (liens) est remise une fois à l'instance en place, jamais périmée", () => {
    const argv = ["/opt/WhatHush/whathush", "whatsapp://send?phone=33612345678"];
    handOver(userData, argv, 1_000_000);
    expect(takeHandOver(userData, 1_002_000)).toEqual(argv);
    expect(takeHandOver(userData, 1_002_000)).toEqual([]);
    handOver(userData, argv, 1_000_000);
    expect(takeHandOver(userData, 1_000_000 + 60_000)).toEqual([]);
    expect(fs.existsSync(path.join(userData, "second-instance.json"))).toBe(false);
  });

  it("orphelins : processus Chromium de ce profil rattachés à init ou systemd, jamais nos enfants ni un autre profil", () => {
    const marker = `--user-data-dir=${userData}`;
    proc(10, 1, ["/usr/lib/systemd/systemd", "--user"], "systemd");
    proc(300, 10, [`/opt/WhatHush/whathush --type=utility --utility-sub-type=network.mojom.NetworkService ${marker} --lang=fr`], "whathush");
    proc(301, 1, ["/opt/WhatHush/whathush", "--type=gpu-process", marker], "whathush");
    proc(500, 1, ["/opt/WhatHush/whathush"], "whathush");
    proc(502, 500, ["/opt/WhatHush/whathush", "--type=renderer", marker], "whathush");
    proc(400, 1, ["/opt/WhatHush/whathush", "--type=renderer", "--user-data-dir=/autre/profil"], "whathush");
    proc(401, 1, ["gdbus", "monitor", "--session"], "gdbus");
    // Profil voisin dont le nom commence comme le nôtre.
    proc(402, 1, ["/opt/WhatHush/whathush", "--type=renderer", `${marker}-test`], "whathush");
    expect(orphanedProcesses(userData, 500, root).sort()).toEqual([300, 301]);
  });
});

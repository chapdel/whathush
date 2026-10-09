// Relais « sh » des gdbus monitor, quand setpriv manque : gdbus s'arrête avec lui, qu'il
// reçoive SIGTERM (arrêt normal de l'écoute) ou que son entrée se ferme (application tuée).
// Vrais processus : un faux gdbus (sleep) en tête du PATH.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ powerMonitor: { getSystemIdleTime: () => 0 } }));
const { MONITOR_RELAY } = await import("../../src/main/security/lock-service");

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let bin: string;

/** Processus « sleep <secondes> » encore en vie (durée unique par cas). */
function sleeping(seconds: number): number {
  let count = 0;
  for (const entry of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      if (fs.readFileSync(`/proc/${entry}/cmdline`, "utf8") === `sleep\0${seconds}\0`) count += 1;
    } catch {
      // processus terminé entre-temps
    }
  }
  return count;
}

async function relay(seconds: number, stop: (child: ReturnType<typeof spawn>) => void): Promise<number> {
  const child = spawn("sh", ["-c", MONITOR_RELAY, "sh", String(seconds)], { stdio: ["pipe", "pipe", "ignore"], env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` } });
  for (let i = 0; i < 50 && sleeping(seconds) === 0; i++) await sleep(20);
  expect(sleeping(seconds)).toBe(1);
  stop(child);
  for (let i = 0; i < 50 && sleeping(seconds) > 0; i++) await sleep(20);
  return sleeping(seconds);
}

beforeAll(() => {
  bin = fs.mkdtempSync(path.join(os.tmpdir(), "fake-gdbus-"));
  // « gdbus monitor <secondes> » : un processus qui dure, reconnaissable à sa durée.
  fs.writeFileSync(path.join(bin, "gdbus"), '#!/bin/sh\nshift\nexec sleep "$1"\n', { mode: 0o755 });
});
afterAll(() => fs.rmSync(bin, { recursive: true, force: true }));

describe("relais sh de gdbus monitor", () => {
  const base = 3000 + (process.pid % 500) * 2;

  it("arrêt de l'écoute (entrée fermée et SIGTERM, comme stopMonitors) : gdbus s'arrête", async () => {
    expect(
      await relay(base, (child) => {
        child.stdin?.end();
        child.kill();
      })
    ).toBe(0);
  });

  it("application tuée (entrée fermée par le noyau) : gdbus s'arrête", async () => {
    expect(await relay(base + 1, (child) => child.stdin?.end())).toBe(0);
  });
});

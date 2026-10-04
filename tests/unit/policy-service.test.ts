import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { addAccount } from "../../src/main/core/accounts";
import { PolicyService } from "../../src/main/policy/policy-service";
import { AppStore } from "../../src/main/storage/app-store";
import type { Logger } from "../../src/main/log";

it("le tick rétablit le Focus à la fin du Snooze, puis le mode normal à la fin du Focus", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-04T12:00:00Z"));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "whathush-policy-test-"));
  const log: Logger = { dir, debug() {}, info() {}, warn() {}, error() {} };
  const store = new AppStore(dir, log);
  let id = "";
  store.update("accounts", (file) => {
    const result = addAccount(file, { label: "Travail" }, new Date());
    id = result.account.id;
    return result.file;
  });
  const profileId = crypto.randomUUID();
  store.update("focus", (file) => ({ ...file, profiles: [{ id: profileId, name: "Réunion", modes: { [id]: "calls-only" } }] }));
  const policy = new PolicyService(store);
  const changed = vi.fn();
  policy.on("changed", changed);
  policy.start();
  try {
    policy.activateFocus(profileId, 2);
    policy.snooze(id, { kind: "minutes", minutes: 1 });
    expect(policy.policy(id)).toMatchObject({ mode: "snoozed", source: "manual" });
    changed.mockClear();
    vi.advanceTimersByTime(60_000);
    expect(policy.policy(id)).toMatchObject({ mode: "calls-only", source: "focus" });
    expect(store.get("accounts").accounts[0]).not.toHaveProperty("manualOverride");
    vi.advanceTimersByTime(60_000);
    expect(policy.policy(id)).toMatchObject({ mode: "normal", source: "default" });
    expect(store.get("focus").active).toBeNull();
    expect(changed).toHaveBeenCalledTimes(2);
  } finally {
    policy.stop();
    vi.useRealTimers();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

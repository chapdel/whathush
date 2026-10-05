// Écoute du verrouillage de session : les gdbus monitor ne survivent pas à l'application.

import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const spawned: Array<EventEmitter & { stdout: EventEmitter; kill: ReturnType<typeof vi.fn> }> = [];

vi.mock("electron", () => ({ powerMonitor: { getSystemIdleTime: () => 0 } }));
vi.mock("node:child_process", () => ({
  spawn: () => {
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), kill: vi.fn() });
    spawned.push(child);
    return child;
  },
  // Aucune session logind trouvée : seuls les deux économiseurs d'écran sont écoutés.
  execFile: (_file: string, _args: string[], _options: unknown, callback: (error: Error | null, stdout: string) => void) => callback(new Error("pas de logind"), "")
}));

const { LockService } = await import("../../src/main/security/lock-service");

function service(onProcessExit: (listener: () => void) => void) {
  const security = { lock: { enabled: false, onStart: false, onHide: false, idleMinutes: 0, onScreenLock: true }, failures: { count: 0, lastAt: null } };
  return new LockService({
    store: { get: () => security, update: () => undefined } as never,
    log: { info: () => undefined, warn: () => undefined, error: () => undefined } as never,
    watchSession: true,
    onProcessExit
  });
}

afterEach(() => {
  spawned.length = 0;
});

describe("verrouillage de session", () => {
  it("arrête les gdbus monitor à la sortie du processus, même sans before-quit", () => {
    let atExit: (() => void) | null = null;
    const lock = service((listener) => (atExit = listener));
    lock.start();
    expect(spawned).toHaveLength(2);
    expect(atExit).not.toBeNull();
    atExit!();
    for (const monitor of spawned) expect(monitor.kill).toHaveBeenCalledTimes(1);
  });

  it("n'écoute rien et n'accroche rien sans écoute de session", () => {
    const onProcessExit = vi.fn();
    const security = { lock: { enabled: false, onStart: false, onHide: false, idleMinutes: 0, onScreenLock: true }, failures: { count: 0, lastAt: null } };
    const lock = new LockService({ store: { get: () => security, update: () => undefined } as never, log: { info: () => undefined } as never, watchSession: false, onProcessExit });
    lock.start();
    lock.stop();
    expect(spawned).toHaveLength(0);
    expect(onProcessExit).not.toHaveBeenCalled();
  });
});

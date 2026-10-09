// Écoute du verrouillage de session : seulement quand le verrou l'utilise, et jamais
// de gdbus monitor qui survive à l'application.

import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

type FakeChild = EventEmitter & { stdout: EventEmitter; stdin: { end: ReturnType<typeof vi.fn> }; kill: ReturnType<typeof vi.fn>; command: string; args: string[] };
const spawned: FakeChild[] = [];

vi.mock("electron", () => ({ powerMonitor: { getSystemIdleTime: () => 0 } }));
vi.mock("node:child_process", () => ({
  spawn: (command: string, args: string[]) => {
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stdin: { end: vi.fn() }, kill: vi.fn(), command, args });
    spawned.push(child);
    return child;
  },
  execFile: (_file: string, _args: string[], _options: unknown, callback: (error: Error | null, stdout: string) => void) => logind(callback)
}));
type LogindReply = (callback: (error: Error | null, stdout: string) => void) => void;
// Par défaut, aucune session logind trouvée : seuls les deux économiseurs d'écran sont écoutés.
const noLogind: LogindReply = (callback) => callback(new Error("pas de logind"), "");
let logind: LogindReply = noLogind;

const { LockService } = await import("../../src/main/security/lock-service");

type Lock = { enabled: boolean; onStart: boolean; onHide: boolean; idleMinutes: number; onScreenLock: boolean; hash: string; salt: string; params: { N: number; r: number; p: number } };

function service(lock: Partial<Lock>, onProcessExit: (listener: () => void) => void = () => undefined) {
  let security = {
    schemaVersion: 1,
    lock: { enabled: false, onStart: false, onHide: false, idleMinutes: 0, onScreenLock: true, hash: "", salt: "", params: { N: 1024, r: 8, p: 1 }, ...lock },
    failures: { count: 0, lastAt: null },
    proxySecrets: { global: null, accounts: {} }
  };
  const store = {
    get: () => security,
    update: (_key: string, updater: (current: typeof security) => typeof security) => {
      security = updater(security);
      return true;
    }
  };
  return new LockService({
    store: store as never,
    log: { info: () => undefined, warn: () => undefined, error: () => undefined } as never,
    watchSession: true,
    onProcessExit
  });
}

afterEach(() => {
  spawned.length = 0;
  logind = noLogind;
  vi.useRealTimers();
});

describe("verrouillage de session", () => {
  it("sans verrou : ni gdbus monitor, ni mesure de l'inactivité", () => {
    vi.useFakeTimers();
    const idle = vi.fn(() => 0);
    const lock = new LockService({
      store: { get: () => ({ lock: { enabled: false, onStart: true, onHide: false, idleMinutes: 5, onScreenLock: true }, failures: { count: 0, lastAt: null } }), update: () => true } as never,
      log: { info: () => undefined } as never,
      watchSession: true,
      idleSeconds: idle
    });
    lock.start();
    vi.advanceTimersByTime(10 * 60_000);
    expect(spawned).toHaveLength(0);
    expect(idle).not.toHaveBeenCalled();
    lock.stop();
  });

  it("verrou actif : écoute la session, arrête les moniteurs à la sortie du processus, même sans before-quit", () => {
    let atExit: (() => void) | null = null;
    const lock = service({ enabled: true }, (listener) => (atExit = listener));
    lock.start();
    expect(spawned).toHaveLength(2);
    expect(atExit).not.toBeNull();
    atExit!();
    for (const monitor of spawned) expect(monitor.kill).toHaveBeenCalledTimes(1);
  });

  it("chaque gdbus meurt avec l'application, même tuée par SIGKILL", () => {
    const lock = service({ enabled: true });
    lock.start();
    for (const monitor of spawned) {
      const line = [monitor.command, ...monitor.args].join(" ");
      // setpriv : signal du noyau à la mort du parent ; sinon relais sh attaché par son entrée.
      expect(/setpriv --pdeathsig TERM -- gdbus monitor/.test(line) || (monitor.command === "sh" && /read -r _; kill/.test(line))).toBe(true);
    }
    lock.stop();
  });

  it("suit les réglages : l'écoute démarre avec l'option, s'arrête sans elle ou sans code", () => {
    const lock = service({ enabled: true, onScreenLock: false });
    lock.start();
    expect(spawned).toHaveLength(0);
    lock.setOptions({ onScreenLock: true });
    expect(spawned).toHaveLength(2);
    lock.setOptions({ onScreenLock: false });
    for (const monitor of spawned) {
      expect(monitor.stdin.end).toHaveBeenCalled();
      expect(monitor.kill).toHaveBeenCalled();
    }
    lock.setOptions({ onScreenLock: true });
    expect(spawned).toHaveLength(4);
    lock.removeLock();
    for (const monitor of spawned.slice(2)) expect(monitor.kill).toHaveBeenCalled();
  });

  it("option coupée puis rétablie pendant la recherche de la session logind : un seul moniteur logind", () => {
    const replies: Array<() => void> = [];
    logind = (callback) => replies.push(() => callback(null, "(objectpath '/org/freedesktop/login1/session/_31',)\n"));
    const lock = service({ enabled: true });
    lock.start();
    lock.setOptions({ onScreenLock: false });
    lock.setOptions({ onScreenLock: true });
    // Réponse de la première recherche (écoute arrêtée entre-temps), puis de la seconde.
    for (const reply of replies) reply();
    expect(spawned.filter((monitor) => monitor.args.includes("--system"))).toHaveLength(1);
    lock.stop();
  });

  it("n'écoute rien et n'accroche rien sans écoute de session", () => {
    const onProcessExit = vi.fn();
    const security = { lock: { enabled: true, onStart: false, onHide: false, idleMinutes: 0, onScreenLock: true }, failures: { count: 0, lastAt: null } };
    const lock = new LockService({ store: { get: () => security, update: () => undefined } as never, log: { info: () => undefined } as never, watchSession: false, onProcessExit });
    lock.start();
    lock.stop();
    expect(spawned).toHaveLength(0);
    expect(onProcessExit).not.toHaveBeenCalled();
  });
});

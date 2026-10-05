// Verrouillage par code. Verrou d'interface : il empêche une personne devant
// l'écran de lire les conversations ; il ne chiffre pas les sessions.
// - empreinte scrypt (node:crypto), sel aléatoire, comparaison à temps constant ;
// - délai croissant après un échec, conservé au redémarrage ;
// - déclencheurs : démarrage, fenêtre masquée, inactivité, verrouillage de la session.

import { powerMonitor } from "electron";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import type { LockSettings } from "../../shared/schemas";
import { parseLockSignal, parseSessionPath, retryAt, shouldLock, validCode, type LockTrigger } from "../core/lock";
import type { Logger } from "../log";
import { SCRYPT_PARAMS } from "../storage/documents";
import type { AppStore } from "../storage/app-store";

const IDLE_POLL_MS = 15_000;
const KEY_LENGTH = 32;

export interface LockState {
  enabled: boolean;
  locked: boolean;
  /** Prochain essai permis (ISO), après plusieurs échecs. */
  retryAt: string | null;
  /** Le dernier essai était faux. */
  failed: boolean;
}

export type LockOptions = Pick<LockSettings, "onStart" | "onHide" | "idleMinutes" | "onScreenLock">;

function derive(code: string, salt: Buffer, params: LockSettings["params"]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(code.normalize("NFC"), salt, KEY_LENGTH, { ...params, maxmem: 256 * params.N * params.r }, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

export class LockService extends EventEmitter<{ changed: []; locked: [LockTrigger]; unlocked: [] }> {
  private locked = false;
  private failed = false;
  /** Un seul essai de code à la fois : des essais simultanés contourneraient le délai. */
  private checking = false;
  private idleTimer: NodeJS.Timeout | null = null;
  private readonly monitors: ChildProcess[] = [];

  constructor(
    private readonly deps: {
      store: AppStore;
      log: Logger;
      now?: () => Date;
      /** Secondes d'inactivité du système (injectable pour les tests). */
      idleSeconds?: () => number;
      /** Écouter le verrouillage de session (désactivé en test). */
      watchSession: boolean;
      /** Intervalle de mesure de l'inactivité (15 s ; plus court en test). */
      idlePollMs?: number;
      /** Sortie du processus (injectable pour les tests). */
      onProcessExit?: (listener: () => void) => void;
    }
  ) {
    super();
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private settings(): LockSettings {
    return this.deps.store.get("security").lock;
  }

  state(): LockState {
    const security = this.deps.store.get("security");
    const at = retryAt(security.failures, this.now());
    return { enabled: security.lock.enabled, locked: this.locked, retryAt: at ? at.toISOString() : null, failed: this.failed };
  }

  isLocked(): boolean {
    return this.locked;
  }

  isEnabled(): boolean {
    return this.settings().enabled;
  }

  options(): LockOptions {
    const { onStart, onHide, idleMinutes, onScreenLock } = this.settings();
    return { onStart, onHide, idleMinutes, onScreenLock };
  }

  start(): void {
    this.trigger("start");
    this.idleTimer = setInterval(() => this.trigger("idle"), this.deps.idlePollMs ?? IDLE_POLL_MS);
    if (this.deps.watchSession) {
      this.watchSession();
      // app.exit() (auto-test) et process.exit() ne passent pas par before-quit : sans
      // cela, les gdbus monitor survivraient à l'application, et garderaient ouvert le
      // bac à sable Flatpak.
      (this.deps.onProcessExit ?? ((listener) => process.once("exit", listener)))(() => this.stop());
    }
  }

  stop(): void {
    if (this.idleTimer) clearInterval(this.idleTimer);
    this.idleTimer = null;
    for (const monitor of this.monitors) monitor.kill();
    this.monitors.length = 0;
  }

  /** Verrouille si le déclencheur est activé ; « manual » verrouille toujours (si un code existe). */
  trigger(trigger: LockTrigger): void {
    if (this.locked) return;
    const idle = trigger === "idle" ? (this.deps.idleSeconds?.() ?? powerMonitor.getSystemIdleTime()) : 0;
    if (!shouldLock(this.settings(), trigger, idle)) return;
    this.locked = true;
    this.failed = false;
    this.deps.log.info("locked", { trigger });
    this.emit("locked", trigger);
    this.emit("changed");
  }

  private async matches(code: string): Promise<boolean> {
    const lock = this.settings();
    if (!lock.hash || !lock.salt) return false;
    const expected = Buffer.from(lock.hash, "base64");
    const actual = await derive(code, Buffer.from(lock.salt, "base64"), lock.params);
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  }

  private recordFailure(): void {
    this.deps.store.update("security", (file) => ({ ...file, failures: { count: Math.min(1000, file.failures.count + 1), lastAt: this.now().toISOString() } }));
  }

  /**
   * Vérifie un code en respectant le délai imposé : un seul essai à la fois, échec
   * enregistré avant le calcul (et retiré s'il réussit) ; un essai pendant le délai est
   * refusé sans calcul.
   */
  private async attempt(code: string): Promise<boolean> {
    if (this.checking || retryAt(this.deps.store.get("security").failures, this.now())) return false;
    this.checking = true;
    const before = this.deps.store.get("security").failures;
    this.recordFailure();
    try {
      const ok = await this.matches(code);
      if (ok) this.deps.store.update("security", (file) => ({ ...file, failures: before.count > 0 ? { count: 0, lastAt: null } : before }));
      else this.deps.log.warn("code-failed", { failures: this.deps.store.get("security").failures.count });
      return ok;
    } finally {
      this.checking = false;
    }
  }

  /** Essai de déverrouillage ; refusé sans calcul pendant le délai imposé. */
  async unlock(code: string): Promise<boolean> {
    if (!this.locked) return true;
    const ok = await this.attempt(code);
    if (ok) {
      this.locked = false;
      this.failed = false;
      this.deps.log.info("unlocked");
      this.emit("unlocked");
    } else {
      this.failed = true;
    }
    this.emit("changed");
    return ok;
  }

  /** Nouveau code ; le code actuel est exigé s'il y en a un. */
  async setCode(current: string | null, next: string): Promise<"ok" | "invalid" | "wrong-current"> {
    if (!validCode(next)) return "invalid";
    if (this.settings().enabled && !(current !== null && (await this.attempt(current)))) return "wrong-current";
    const salt = crypto.randomBytes(16);
    const hash = await derive(next, salt, SCRYPT_PARAMS);
    this.deps.store.update("security", (file) => ({
      ...file,
      lock: { ...file.lock, enabled: true, hash: hash.toString("base64"), salt: salt.toString("base64"), params: { ...SCRYPT_PARAMS } },
      failures: { count: 0, lastAt: null }
    }));
    this.deps.log.info("lock-code-set");
    this.emit("changed");
    return "ok";
  }

  async disable(current: string): Promise<"ok" | "wrong-current"> {
    if (!(await this.attempt(current))) return "wrong-current";
    this.removeLock();
    return "ok";
  }

  /** Après « Code oublié » : les sessions ont été effacées, le verrou est retiré. */
  removeLock(): void {
    this.deps.store.update("security", (file) => ({ ...file, lock: { ...file.lock, enabled: false, hash: "", salt: "" }, failures: { count: 0, lastAt: null } }));
    this.locked = false;
    this.failed = false;
    this.deps.log.info("lock-removed");
    this.emit("unlocked");
    this.emit("changed");
  }

  setOptions(patch: Partial<LockOptions>): void {
    this.deps.store.update("security", (file) => ({ ...file, lock: { ...file.lock, ...patch } }));
    this.emit("changed");
  }

  // --- Verrouillage de la session (Linux) ---------------------------------------------------
  // L'événement lock-screen d'Electron n'existe pas sous Linux : on écoute logind
  // (LockedHint, Lock) sur le bus système et l'économiseur d'écran sur le bus de session.

  private watchSession(): void {
    const listen = (args: string[]) => {
      const monitor = spawn("gdbus", ["monitor", ...args], { stdio: ["ignore", "pipe", "ignore"] });
      monitor.on("error", (error) => this.deps.log.warn("session-lock-monitor-failed", { error: String(error) }));
      let pending = "";
      monitor.stdout.on("data", (chunk: Buffer) => {
        pending += chunk.toString();
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        for (const line of lines) if (parseLockSignal(line) === true) this.trigger("screen-lock");
      });
      this.monitors.push(monitor);
    };
    listen(["--session", "--dest", "org.freedesktop.ScreenSaver"]);
    listen(["--session", "--dest", "org.gnome.ScreenSaver"]);
    // Session de l'application ; sinon (service utilisateur, Flatpak) celle de XDG_SESSION_ID.
    const lookups: string[][] = [["GetSessionByPID", String(process.pid)], ...(process.env.XDG_SESSION_ID ? [["GetSession", process.env.XDG_SESSION_ID]] : [])];
    const next = (index: number): void => {
      const lookup = lookups[index];
      if (!lookup) {
        this.deps.log.info("logind-session-unknown");
        return;
      }
      execFile(
        "gdbus",
        ["call", "--system", "--dest", "org.freedesktop.login1", "--object-path", "/org/freedesktop/login1", "--method", `org.freedesktop.login1.Manager.${lookup[0]}`, lookup[1] ?? ""],
        { timeout: 3000 },
        (error, stdout) => {
          const sessionPath = error ? null : parseSessionPath(String(stdout));
          if (sessionPath) listen(["--system", "--dest", "org.freedesktop.login1", "--object-path", sessionPath]);
          else next(index + 1);
        }
      );
    };
    next(0);
  }
}

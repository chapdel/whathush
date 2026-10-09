// Verrouillage par code. Verrou d'interface : il empêche une personne devant
// l'écran de lire les conversations ; il ne chiffre pas les sessions.
// - empreinte scrypt (node:crypto), sel aléatoire, comparaison à temps constant ;
// - délai croissant après un échec, conservé au redémarrage ;
// - déclencheurs : démarrage, fenêtre masquée, inactivité, verrouillage de la session.

import { powerMonitor } from "electron";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
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

  private started = false;
  private exitHooked = false;
  /** Génération de l'écoute de session : une recherche logind d'une écoute arrêtée est ignorée. */
  private sessionWatch = 0;

  start(): void {
    this.started = true;
    this.trigger("start");
    this.syncWatchers();
  }

  /**
   * Mesure de l'inactivité et écoute du verrouillage de session seulement si un
   * déclencheur les utilise : sans verrou, ni minuteur ni processus gdbus. Rappelé à
   * chaque changement de réglage.
   */
  private syncWatchers(): void {
    if (!this.started) return;
    const lock = this.settings();
    const idle = lock.enabled && lock.idleMinutes > 0;
    if (idle && !this.idleTimer) this.idleTimer = setInterval(() => this.trigger("idle"), this.deps.idlePollMs ?? IDLE_POLL_MS);
    if (!idle && this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = null;
    }
    const session = this.deps.watchSession && lock.enabled && lock.onScreenLock;
    if (session && this.monitors.length === 0) {
      this.watchSession();
      if (!this.exitHooked) {
        this.exitHooked = true;
        // app.exit() (auto-test) et process.exit() ne passent pas par before-quit : sans
        // cela, les gdbus monitor survivraient à l'application, et garderaient ouvert le
        // bac à sable Flatpak.
        (this.deps.onProcessExit ?? ((listener) => process.once("exit", listener)))(() => this.stop());
      }
    }
    if (!session) this.stopMonitors();
  }

  private stopMonitors(): void {
    // Une recherche de session logind en cours n'ajoutera plus rien.
    this.sessionWatch += 1;
    for (const monitor of this.monitors) {
      // Relais « sh » : fin de son entrée ou SIGTERM, il arrête gdbus dans les deux cas.
      monitor.stdin?.end();
      monitor.kill();
    }
    this.monitors.length = 0;
  }

  stop(): void {
    this.started = false;
    if (this.idleTimer) clearInterval(this.idleTimer);
    this.idleTimer = null;
    this.stopMonitors();
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
    this.syncWatchers();
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
    this.syncWatchers();
    this.emit("unlocked");
    this.emit("changed");
  }

  setOptions(patch: Partial<LockOptions>): void {
    this.deps.store.update("security", (file) => ({ ...file, lock: { ...file.lock, ...patch } }));
    this.syncWatchers();
    this.emit("changed");
  }

  // --- Verrouillage de la session (Linux) ---------------------------------------------------
  // L'événement lock-screen d'Electron n'existe pas sous Linux : on écoute logind
  // (LockedHint, Lock) sur le bus système et l'économiseur d'écran sur le bus de session.

  private watchSession(): void {
    const generation = this.sessionWatch;
    const listen = (args: string[]) => {
      const monitor = spawnMonitor(args);
      monitor.on("error", (error) => this.deps.log.warn("session-lock-monitor-failed", { error: String(error) }));
      let pending = "";
      monitor.stdout?.on("data", (chunk: Buffer) => {
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
          // Réglage changé pendant la recherche (écoute arrêtée, puis peut-être relancée) : rien à ajouter.
          if (generation !== this.sessionWatch) return;
          const sessionPath = error ? null : parseSessionPath(String(stdout));
          if (sessionPath) listen(["--system", "--dest", "org.freedesktop.login1", "--object-path", sessionPath]);
          else next(index + 1);
        }
      );
    };
    next(0);
  }
}

/** Chemin d'un exécutable du PATH, ou null. */
function which(name: string): string | null {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // absent de ce dossier
    }
  }
  return null;
}

/**
 * gdbus monitor lié à la vie de l'application, même tuée par SIGKILL (constat : des
 * moniteurs orphelins tournaient encore 39 h après). setpriv --pdeathsig demande au
 * noyau de le terminer à la mort de son parent ; sans setpriv, un relais « sh » l'arrête à
 * la fin de son entrée standard (fermée par le noyau à la mort de l'application) ou quand
 * il reçoit SIGTERM (arrêt normal : sans le trap, il mourait avant d'arrêter gdbus).
 */
function spawnMonitor(args: string[]): ChildProcess {
  const setpriv = which("setpriv");
  if (setpriv) return spawn(setpriv, ["--pdeathsig", "TERM", "--", "gdbus", "monitor", ...args], { stdio: ["ignore", "pipe", "ignore"] });
  return spawn("sh", ["-c", MONITOR_RELAY, "sh", ...args], { stdio: ["pipe", "pipe", "ignore"] });
}

/** Relais « sh » de gdbus monitor (exporté pour les tests). */
export const MONITOR_RELAY = `trap 'kill "$child" 2>/dev/null; exit 0' TERM; gdbus monitor "$@" & child=$!; read -r _; kill "$child" 2>/dev/null`;

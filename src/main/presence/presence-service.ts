// PresenceService : quelqu'un peut-il voir WhatsApp ? Deux signaux :
// - la fenêtre est présentée (la coque reçoit des images ; sous Wayland, une fenêtre
//   réduite par le bureau n'est signalée à Electron que par « blur ») ;
// - l'utilisateur est là (inactivité du système sous le seuil choisi).
// Sans personne devant, les vues sont masquées : WhatsApp reste connecté et notifie,
// mais ses minuteries sont bridées et il ne marque rien comme lu.

import { EventEmitter } from "node:events";
import { IDLE_POLL_MS, nextAway } from "../core/presence";
import type { Logger } from "../log";

export interface PresenceDeps {
  log: Logger;
  /** Secondes d'inactivité du système (powerMonitor ; injectable pour les tests). */
  idleSeconds(): number;
  /** Seuil d'absence choisi (minutes) ; 0 = jamais. */
  awayHideMinutes(): number;
  /** Intervalles de relevé (plus courts en test). */
  pollMs?: { present: number; away: number };
}

export class PresenceService extends EventEmitter<{ changed: [] }> {
  private presented = true;
  private away = false;
  private windowVisible = true;
  private timer: NodeJS.Timeout | null = null;
  private started = false;

  constructor(private readonly deps: PresenceDeps) {
    super();
  }

  start(): void {
    this.started = true;
    this.schedule();
  }

  stop(): void {
    this.started = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Quelqu'un peut voir la fenêtre. */
  attended(): boolean {
    return this.presented && !this.away;
  }

  isAway(): boolean {
    return this.away;
  }

  isPresented(): boolean {
    return this.presented;
  }

  /** Sonde d'images de la coque. */
  setPresented(presented: boolean): void {
    if (presented === this.presented) return;
    this.presented = presented;
    this.deps.log.info(presented ? "window-presented" : "window-not-presented");
    this.emit("changed");
  }

  /** Fenêtre affichée ou masquée (barre système) : pas de relevé quand elle est masquée. */
  setWindowVisible(visible: boolean): void {
    this.windowVisible = visible;
    if (visible) this.check();
    else this.schedule();
  }

  /** Réglage modifié, focus, clic sur une notification : relevé immédiat. */
  refresh(): void {
    this.check();
  }

  private check(): void {
    if (!this.started) return;
    const minutes = this.deps.awayHideMinutes();
    const next = this.windowVisible ? nextAway({ awayHideMinutes: minutes, idleSeconds: this.deps.idleSeconds(), wasAway: this.away }) : false;
    if (next !== this.away) {
      this.away = next;
      this.deps.log.info(next ? "user-away" : "user-back");
      this.emit("changed");
    }
    this.schedule();
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.started || !this.windowVisible || this.deps.awayHideMinutes() <= 0) return;
    const poll = this.deps.pollMs ?? IDLE_POLL_MS;
    this.timer = setTimeout(() => this.check(), this.away ? poll.away : poll.present);
  }
}

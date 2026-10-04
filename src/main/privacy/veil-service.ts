// Voile de confidentialité (F7).
// F7a : un flou CSS sur l'élément racine de la page (niveau 2) : aucun sélecteur de
//   WhatsApp, donc rien à casser. Déclenché à la demande (Ctrl+Maj+H), quand la fenêtre
//   perd le focus, ou pendant un partage d'écran (options). Le survol ou un clic dans la
//   vue le retire jusqu'au déclenchement suivant ; pendant un partage, seul un clic.
// F7b : flou message par message (niveau 3, expérimental) : sélecteurs de l'adaptateur,
//   auto-test dans la page, désactivé automatiquement s'ils ne correspondent plus.

import { EventEmitter } from "node:events";
import type { WebContents } from "electron";
import { CHANNELS } from "../../shared/channels";
import type { PrivacyVeil } from "../../shared/schemas";
import type { Logger } from "../log";

export const VEIL_CSS = "html { filter: blur(18px) saturate(.6) !important; transition: filter .12s ease-out !important; }";

/** Repères de l'adaptateur (§35) pour F7b ; le même relevé est fait par le preload. */
export const MESSAGE_BLUR_CSS = [
  "[data-pre-plain-text], #main img, #main video, #pane-side [data-testid=\"cell-frame-secondary\"] { filter: blur(7px) !important; transition: filter .12s ease-out !important; }",
  "[data-pre-plain-text]:hover, #main img:hover, #main video:hover, #pane-side [data-testid=\"cell-frame-secondary\"]:hover { filter: none !important; }"
].join("\n");

type Layer = "veil" | "messages";

export class VeilService extends EventEmitter<{ changed: [] }> {
  private veiled = false;
  /** Déclenché par un partage d'écran : le survol ne suffit pas à dévoiler. */
  private strict = false;
  /** Feuille insérée par page et couche ; un essai en cours porte un jeton unique. */
  private readonly inserted = new Map<string, string>();
  private token = 0;
  /** Comptes dont l'auto-test du flou des messages a échoué. */
  private readonly blurUnavailable = new Set<number>();

  constructor(
    private readonly deps: {
      log: Logger;
      preferences(): PrivacyVeil;
      /** Pages WhatsApp à voiler (vues et popups). */
      pages(): WebContents[];
    }
  ) {
    super();
  }

  isVeiled(): boolean {
    return this.veiled;
  }

  /** Raccourci ou bouton : bascule. */
  toggle(): void {
    if (this.veiled) this.unveil();
    else this.veil(false);
  }

  veil(strict: boolean): void {
    if (this.veiled && this.strict === strict) return;
    this.veiled = true;
    this.strict = strict;
    this.applyAll();
  }

  unveil(): void {
    if (!this.veiled) return;
    this.veiled = false;
    this.strict = false;
    this.applyAll();
  }

  windowBlurred(): void {
    if (this.deps.preferences().onBlur) this.veil(this.strict);
  }

  screenShareChanged(sharing: boolean): void {
    if (sharing && this.deps.preferences().onScreenShare) this.veil(true);
  }

  /** Survol ou clic signalé par le preload d'une page. */
  reveal(kind: "hover" | "click"): void {
    if (!this.veiled || (this.strict && kind !== "click")) return;
    this.unveil();
  }

  /** Auto-test du flou des messages (F7b), rapporté par le preload. */
  adapterCheck(contents: WebContents, matched: boolean): boolean {
    const known = !this.blurUnavailable.has(contents.id);
    if (matched) this.blurUnavailable.delete(contents.id);
    else this.blurUnavailable.add(contents.id);
    void this.apply(contents);
    // true : premier échec pour cette page, à signaler une fois.
    return !matched && known;
  }

  /** Page (re)chargée : son CSS inséré a disparu avec le document. */
  pageLoaded(contents: WebContents): void {
    for (const layer of ["veil", "messages"] as const) this.inserted.delete(this.key(contents, layer));
    void this.apply(contents);
  }

  pageGone(contents: WebContents): void {
    for (const layer of ["veil", "messages"] as const) this.inserted.delete(this.key(contents, layer));
    this.blurUnavailable.delete(contents.id);
  }

  applyAll(): void {
    for (const contents of this.deps.pages()) void this.apply(contents);
    this.emit("changed");
  }

  private key(contents: WebContents, layer: Layer): string {
    return `${contents.id}:${layer}`;
  }

  private async apply(contents: WebContents): Promise<void> {
    if (contents.isDestroyed()) return;
    const messages = this.deps.preferences().blurMessages && !this.blurUnavailable.has(contents.id);
    await this.setLayer(contents, "veil", this.veiled, VEIL_CSS);
    await this.setLayer(contents, "messages", messages, MESSAGE_BLUR_CSS);
    // Le preload n'écoute le survol et les clics que pendant le voile.
    if (!contents.isDestroyed()) contents.send(CHANNELS.waVeil, { veiled: this.veiled, strict: this.strict, blurMessages: this.deps.preferences().blurMessages });
  }

  private async setLayer(contents: WebContents, layer: Layer, on: boolean, css: string): Promise<void> {
    const key = this.key(contents, layer);
    const existing = this.inserted.get(key);
    try {
      if (on && !existing) {
        // Réservé tout de suite par un jeton propre à cet appel : deux appels rapprochés
        // n'insèrent pas deux fois, et un ancien appel ne prend pas la place d'un nouveau.
        const pending = `pending:${++this.token}`;
        this.inserted.set(key, pending);
        // Origine « auteur » : sous Electron 44, removeInsertedCSS ne retire pas une feuille
        // d'origine « user » (vérifié par test). !important suffit : WhatsApp ne pose aucun
        // filtre sur ces éléments.
        const inserted = await contents.insertCSS(css);
        if (this.inserted.get(key) === pending) this.inserted.set(key, inserted);
        else await contents.removeInsertedCSS(inserted);
      } else if (!on && existing) {
        this.inserted.delete(key);
        if (!existing.startsWith("pending:")) await contents.removeInsertedCSS(existing);
      }
    } catch (error) {
      if (!contents.isDestroyed()) this.deps.log.warn("veil-css-failed", { layer, error: String(error) });
    }
  }
}

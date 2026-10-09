// Mode économie : décisions pures. Un compte en relèves dort quand il est caché et se
// réveille à intervalle régulier (caché) le temps de recevoir ses messages et ses
// notifications, puis se rendort. Il libère alors la mémoire de sa page WhatsApp et de son
// service worker ; en contrepartie, ses messages arrivent par paquets et il ne sonne pas.

import type { Lifecycle } from "../../shared/ipc";
import type { Delivery } from "../../shared/schemas";

export interface EconomyTiming {
  /** Caché depuis ce délai, un compte en relèves s'endort. */
  dozeAfterHiddenMs: number;
  /** Après l'installation de la page, durée minimale d'une relève. */
  relaySettleMs: number;
  /** Une notification prolonge la relève de ce délai (messages en rafale). */
  relayQuietMs: number;
  /** Durée maximale d'une relève, chargement compris. */
  relayMaxMs: number;
  /** Fenêtre dans la barre système depuis ce délai : économie maximale (option). */
  trayAfterMs: number;
}

export const ECONOMY_TIMING: EconomyTiming = {
  dozeAfterHiddenMs: 5 * 60_000,
  relaySettleMs: 60_000,
  relayQuietMs: 20_000,
  relayMaxMs: 4 * 60_000,
  trayAfterMs: 5 * 60_000
};

export interface RelayState {
  startedAt: number;
  /** Page installée (connectée, QR ou hors ligne) ; null pendant le chargement. */
  readyAt: number | null;
  /** Dernière notification reçue pendant la relève. */
  lastActivityAt: number;
}

export interface EconomyAccount {
  id: string;
  delivery: Delivery;
  /** Veille demandée par l'utilisateur (persistée) : jamais de relève. */
  sleeping: boolean;
  /** Compte affiché dans la fenêtre visible. */
  shown: boolean;
  inCall: boolean;
  /** Lecture d'un média en cours dans ce compte. */
  playing: boolean;
  lifecycle: Lifecycle;
  /** Depuis quand le compte n'est plus affiché ; null s'il l'est. */
  hiddenSince: number | null;
  dozing: boolean;
  nextRelayAt: number | null;
  relay: RelayState | null;
}

export interface EconomyContext {
  now: number;
  intervalMinutes: number;
  /** Option « économie maximale dans la barre système ». */
  inTray: boolean;
  /** Fenêtre masquée (barre système) depuis cet instant ; null si elle est affichée. */
  windowHiddenSince: number | null;
  timing: EconomyTiming;
}

/** end : relève abandonnée, le compte reste éveillé (affiché, hors du mode économie, ou à l'utilisateur d'agir). */
export type EconomyAction = { type: "doze"; id: string } | { type: "relay"; id: string } | { type: "wake"; id: string } | { type: "end"; id: string };

/** Le compte reçoit-il ses messages par relèves en ce moment ? */
export function economyApplies(account: Pick<EconomyAccount, "delivery" | "sleeping">, context: EconomyContext): boolean {
  if (account.sleeping) return false;
  if (account.delivery === "periodic") return true;
  return context.inTray && context.windowHiddenSince !== null && context.now - context.windowHiddenSince >= context.timing.trayAfterMs;
}

/** Relève terminée : page installée depuis assez longtemps, sans notification récente, ou durée maximale atteinte. */
export function relayFinished(relay: RelayState, now: number, timing: EconomyTiming): boolean {
  if (now - relay.startedAt >= timing.relayMaxMs) return true;
  return relay.readyAt !== null && now - relay.readyAt >= timing.relaySettleMs && now - relay.lastActivityAt >= timing.relayQuietMs;
}

/**
 * Actions à mener maintenant. Jamais pendant un appel ni une lecture ; jamais pour un
 * compte qui demande une action de l'utilisateur (QR à scanner, erreur).
 */
export function economyActions(accounts: readonly EconomyAccount[], context: EconomyContext): EconomyAction[] {
  const actions: EconomyAction[] = [];
  for (const account of accounts) {
    const applies = economyApplies(account, context);
    if (account.dozing) {
      if (!applies || account.shown) actions.push({ type: "wake", id: account.id });
      else if (account.nextRelayAt !== null && context.now >= account.nextRelayAt) actions.push({ type: "relay", id: account.id });
      continue;
    }
    const needsUser = account.lifecycle === "needs_qr" || account.lifecycle === "crashed" || account.lifecycle === "sleeping";
    if (!applies || account.shown || needsUser) {
      if (account.relay) actions.push({ type: "end", id: account.id });
      continue;
    }
    // Appel ou lecture : la relève (ou l'endormissement) attend qu'ils finissent.
    if (account.inCall || account.playing) continue;
    if (account.relay) {
      if (relayFinished(account.relay, context.now, context.timing)) actions.push({ type: "doze", id: account.id });
      continue;
    }
    if (account.hiddenSince !== null && context.now - account.hiddenSince >= context.timing.dozeAfterHiddenMs) actions.push({ type: "doze", id: account.id });
  }
  return actions;
}

/** Prochaine relève, à partir de l'endormissement. */
export function nextRelayAt(dozedAt: number, intervalMinutes: number): number {
  return dozedAt + intervalMinutes * 60_000;
}

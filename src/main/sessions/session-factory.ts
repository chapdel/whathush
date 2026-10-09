// Fabrique de sessions : tout le durcissement d'une partition passe ici.
// Les handlers Electron sont attachés à une session : une session créée ailleurs
// garderait le comportement par défaut (toutes permissions accordées).

import { desktopCapturer, session, type DesktopCapturerSource, type DownloadItem, type Session } from "electron";
import fs from "node:fs";
import path from "node:path";
import { partitionFor } from "../../shared/constants";
import type { AccountPermissions } from "../../shared/schemas";
import { checkPermission, decidePermission, normalizeOrigin, type PermissionSubject } from "../core/permissions";
import { BLOCKED_DICTIONARY_URL, BUNDLED_DICTIONARIES, GOOGLE_DICTIONARY_URL, type SpellcheckPlan } from "../core/spellcheck";
import type { Logger } from "../log";

export interface SessionDeps {
  whatsappOrigin: string;
  userAgent: string;
  log: Logger;
  onDownload: (accountId: string, item: DownloadItem) => void;
  spellcheck(): SpellcheckPlan;
  /** Réglages du compte, relus à chaque demande. */
  permissions(accountId: string): AccountPermissions;
  /** « Demander » ; « always » met le réglage du compte à « Autoriser ». */
  askPermission(accountId: string, subject: PermissionSubject): Promise<"deny" | "once" | "always">;
  /**
   * Sous Wayland, le portail système fait choisir l'écran. Sous X11, rien ne le
   * fait : on demande confirmation et on fait choisir l'écran. null = refus.
   */
  chooseScreen(accountId: string, sources: DesktopCapturerSource[]): Promise<DesktopCapturerSource | null>;
}

/** Wayland natif : défaut d'Electron 44 dès qu'un compositeur Wayland est disponible (Lab). */
export function usesWaylandPortal(ozonePlatform: string): boolean {
  return Boolean(process.env.WAYLAND_DISPLAY) && ozonePlatform !== "x11" && ozonePlatform !== "headless";
}

const hardened = new WeakSet<Session>();
/** Comptes dont la session existe déjà : un réglage ne doit pas créer celle d'un compte endormi. */
const created = new Set<string>();

export function hasAccountSession(accountId: string): boolean {
  return created.has(accountId);
}

export function chromeUserAgent(): string {
  // Le moteur réellement utilisé, sans la mention Electron.
  const major = process.versions.chrome.split(".")[0];
  const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
  return `Mozilla/5.0 (X11; Linux ${arch}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

export function accountSession(accountId: string, deps: SessionDeps): Session {
  const ses = session.fromPartition(partitionFor(accountId));
  if (hardened.has(ses)) return ses;
  hardened.add(ses);
  created.add(accountId);
  const { log, whatsappOrigin } = deps;

  ses.setUserAgent(deps.userAgent);

  // Liste blanche par origine d'abord, puis réglage du compte.
  ses.setPermissionRequestHandler((_webContents, permission, callback, details) => {
    const mediaTypes = (details as { mediaTypes?: string[] }).mediaTypes;
    const outcome = decidePermission({ permission, origin: details.requestingUrl, ...(mediaTypes ? { mediaTypes } : {}) }, deps.permissions(accountId), whatsappOrigin);
    if (outcome.decision === "ask" && outcome.subject) {
      deps
        .askPermission(accountId, outcome.subject)
        .then((answer) => {
          log.info("permission-asked", { accountId, permission, answer });
          callback(answer !== "deny");
        })
        .catch(() => callback(false));
      return;
    }
    if (outcome.decision === "deny") log.warn("permission-denied", { accountId, permission, origin: normalizeOrigin(details.requestingUrl) });
    callback(outcome.decision === "grant");
  });

  const checksLogged = new Set<string>();
  ses.setPermissionCheckHandler((_webContents, permission, requestingOrigin, details) => {
    const granted = checkPermission(permission, requestingOrigin, details.mediaType, deps.permissions(accountId), whatsappOrigin);
    if (!granted && !checksLogged.has(permission)) {
      checksLogged.add(permission);
      log.info("permission-check-denied", { accountId, permission });
    }
    return granted;
  });

  ses.setDevicePermissionHandler(() => false);

  // Sous Wayland, desktopCapturer ouvre le sélecteur du portail système.
  // Seul le type « screen » est demandé, pour éviter un double sélecteur.
  ses.setDisplayMediaRequestHandler((request, callback) => {
    if (decidePermission({ permission: "display-capture", origin: request.securityOrigin }, deps.permissions(accountId), whatsappOrigin).decision !== "grant") {
      callback({});
      return;
    }
    desktopCapturer
      .getSources({ types: ["screen"] })
      .then(async (sources) => {
        log.info("display-media", { accountId, sources: sources.length });
        const source = await deps.chooseScreen(accountId, sources);
        callback(source ? { video: source } : {});
      })
      .catch((error: unknown) => {
        log.error("display-media-error", error);
        callback({});
      });
  });

  ses.on("will-download", (_event, item) => deps.onDownload(accountId, item));

  // Un téléchargement demandé alors qu'il est bloqué signale un dictionnaire
  // embarqué introuvable (nom de fichier changé par une version d'Electron).
  ses.on("spellcheck-dictionary-initialized", (_event, language) => log.info("spellcheck-ready", { accountId, language }));
  ses.on("spellcheck-dictionary-download-begin", (_event, language) => log.info("spellcheck-download", { accountId, language }));
  ses.on("spellcheck-dictionary-download-failure", (_event, language) => log.warn("spellcheck-dictionary-missing", { accountId, language }));
  applySpellcheck(ses, deps.spellcheck());
  return ses;
}

/**
 * Jamais de téléchargement depuis Google sans choix explicite d'une langue non embarquée.
 * Correcteur désactivé : aucune langue, sinon Chromium charge quand même le dictionnaire de
 * la langue de l'interface dans chaque session (vérifié : désactiver ne suffit pas).
 */
export function applySpellcheck(ses: Session, plan: SpellcheckPlan): void {
  ses.setSpellCheckerDictionaryDownloadURL(plan.allowGoogle ? GOOGLE_DICTIONARY_URL : BLOCKED_DICTIONARY_URL);
  ses.setSpellCheckerEnabled(plan.languages.length > 0);
  ses.setSpellCheckerLanguages(plan.languages);
}

/**
 * Dépose les dictionnaires embarqués là où Chromium les cherche avant tout
 * téléchargement (<userData>/Dictionaries). Copie seulement s'ils manquent ou diffèrent.
 */
export function installBundledDictionaries(sourceDir: string, targetDir: string, log: Logger): void {
  try {
    fs.mkdirSync(targetDir, { recursive: true, mode: 0o700 });
  } catch (error) {
    log.warn("dictionary-install-failed", { error: String(error) });
    return;
  }
  // Un fichier à la fois : l'échec de l'un n'empêche pas les autres langues.
  for (const file of Object.values(BUNDLED_DICTIONARIES)) {
    try {
      const source = path.join(sourceDir, file);
      const target = path.join(targetDir, file);
      const size = fs.statSync(source).size;
      if (fs.existsSync(target) && fs.statSync(target).size === size) continue;
      fs.copyFileSync(source, target);
      log.info("dictionary-installed", { file });
    } catch (error) {
      log.warn("dictionary-install-failed", { file, error: String(error) });
    }
  }
}

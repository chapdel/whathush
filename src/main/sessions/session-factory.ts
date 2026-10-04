// Fabrique de sessions (§4) : tout le durcissement d'une partition passe ici.
// Les handlers Electron sont attachés à une session : une session créée ailleurs
// garderait le comportement par défaut (toutes permissions accordées).

import { desktopCapturer, session, type DesktopCapturerSource, type DownloadItem, type Session } from "electron";
import { partitionFor } from "../../shared/constants";
import { isPermissionGranted, normalizeOrigin } from "../core/permissions";
import type { Logger } from "../log";

export interface SessionDeps {
  whatsappOrigin: string;
  userAgent: string;
  log: Logger;
  onDownload: (accountId: string, item: DownloadItem) => void;
  spellcheckLanguages(): readonly string[];
  /**
   * §20 : sous Wayland, le portail système fait choisir l'écran. Sous X11, rien ne le
   * fait : on demande confirmation et on fait choisir l'écran. null = refus.
   */
  chooseScreen(accountId: string, sources: DesktopCapturerSource[]): Promise<DesktopCapturerSource | null>;
}

/** Wayland natif : défaut d'Electron 44 dès qu'un compositeur Wayland est disponible (Lab). */
export function usesWaylandPortal(ozonePlatform: string): boolean {
  return Boolean(process.env.WAYLAND_DISPLAY) && ozonePlatform !== "x11" && ozonePlatform !== "headless";
}

const hardened = new WeakSet<Session>();

export function chromeUserAgent(): string {
  // §5 : le moteur réellement utilisé, sans la mention Electron.
  const major = process.versions.chrome.split(".")[0];
  const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
  return `Mozilla/5.0 (X11; Linux ${arch}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

export function accountSession(accountId: string, deps: SessionDeps): Session {
  const ses = session.fromPartition(partitionFor(accountId));
  if (hardened.has(ses)) return ses;
  hardened.add(ses);
  const { log, whatsappOrigin } = deps;

  ses.setUserAgent(deps.userAgent);

  ses.setPermissionRequestHandler((_webContents, permission, callback, details) => {
    const granted = isPermissionGranted(permission, details.requestingUrl, whatsappOrigin);
    if (!granted) log.warn("permission-denied", { accountId, permission, origin: normalizeOrigin(details.requestingUrl) });
    callback(granted);
  });

  const checksLogged = new Set<string>();
  ses.setPermissionCheckHandler((_webContents, permission, requestingOrigin) => {
    const granted = isPermissionGranted(permission, requestingOrigin, whatsappOrigin);
    if (!granted && !checksLogged.has(permission)) {
      checksLogged.add(permission);
      log.info("permission-check-denied", { accountId, permission });
    }
    return granted;
  });

  ses.setDevicePermissionHandler(() => false);

  // §20 : sous Wayland, desktopCapturer ouvre le sélecteur du portail système.
  // Seul le type « screen » est demandé, pour éviter un double sélecteur.
  ses.setDisplayMediaRequestHandler((request, callback) => {
    if (!isPermissionGranted("display-capture", request.securityOrigin, whatsappOrigin)) {
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

  // §24 : correcteur désactivé tant qu'aucune langue n'est choisie (les
  // dictionnaires seraient téléchargés depuis les serveurs de Google).
  applySpellcheck(ses, deps.spellcheckLanguages());
  return ses;
}

export function applySpellcheck(ses: Session, languages: readonly string[]): void {
  const available = new Set(ses.availableSpellCheckerLanguages);
  const selected = languages.filter((language) => available.has(language));
  ses.setSpellCheckerEnabled(selected.length > 0);
  if (selected.length > 0) ses.setSpellCheckerLanguages(selected);
}

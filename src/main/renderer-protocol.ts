// Protocole app:// pour l'interface de la coque (§26).
// Le fuse GrantFileProtocolExtraPrivileges est désactivé : file:// ne peut plus lire
// dans app.asar, et c'est voulu. L'interface est servie par ce protocole, limité au
// dossier du renderer (pas de remontée de chemin).

import { protocol } from "electron";
import fs from "node:fs";
import path from "node:path";

export const RENDERER_SCHEME = "app";
export const RENDERER_HOST = "renderer";
export const RENDERER_BASE_URL = `${RENDERER_SCHEME}://${RENDERER_HOST}/`;

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json",
  ".woff2": "font/woff2"
};

/** À appeler avant ready. */
export function registerRendererScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: RENDERER_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } }
  ]);
}

/** Chemin du fichier demandé, ou null s'il sort du dossier du renderer. */
export function resolveRendererPath(rendererDir: string, url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== `${RENDERER_SCHEME}:` || parsed.host !== RENDERER_HOST) return null;
  let relative: string;
  try {
    relative = decodeURIComponent(parsed.pathname);
  } catch {
    return null;
  }
  const root = path.resolve(rendererDir);
  const file = path.resolve(root, `.${path.posix.normalize(relative)}`);
  return file === root || file.startsWith(root + path.sep) ? file : null;
}

/** À appeler après ready, sur la session par défaut (celle de la coque). */
export function serveRenderer(rendererDir: string): void {
  protocol.handle(RENDERER_SCHEME, async (request) => {
    const file = resolveRendererPath(rendererDir, request.url);
    if (!file) return new Response("Introuvable", { status: 404 });
    try {
      // fs lit dans app.asar (Electron l'y autorise pour le processus principal).
      const body = await fs.promises.readFile(file);
      const type = MIME_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
      return new Response(body, { headers: { "content-type": type, "x-content-type-options": "nosniff" } });
    } catch {
      return new Response("Introuvable", { status: 404 });
    }
  });
}

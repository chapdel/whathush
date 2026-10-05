// Photos des notifications servies par un autre domaine de WhatsApp. La page
// ne peut pas toujours les lire (CORS) ; le processus principal les télécharge avec la
// session du compte : hôtes de WhatsApp seulement, images de 256 Kio au plus, délai de
// 2 s, cache en mémoire (100 entrées), jamais écrit sur le disque.

import type { Session } from "electron";
import { AVATAR_CACHE_SIZE, AVATAR_MAX_BYTES, AVATAR_TIMEOUT_MS, AVATAR_TYPES, isAllowedAvatarUrl, LruCache } from "../core/avatar";
import type { Logger } from "../log";

export class AvatarFetcher {
  private readonly cache = new LruCache<Buffer | null>(AVATAR_CACHE_SIZE);

  constructor(
    private readonly deps: {
      sessionFor(accountId: string): Session;
      log: Logger;
      /** Tests : origines supplémentaires autorisées (fausse page). */
      extraOrigins: readonly string[];
    }
  ) {}

  async fetch(accountId: string, url: string): Promise<Buffer | null> {
    if (!isAllowedAvatarUrl(url, this.deps.extraOrigins)) {
      this.deps.log.info("avatar-refused-host");
      return null;
    }
    const key = `${accountId}|${url}`;
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;
    const { image, definitive } = await this.download(accountId, url);
    // Un délai dépassé ou une erreur réseau ne condamne pas la photo pour la session.
    if (image || definitive) this.cache.set(key, image);
    return image;
  }

  private async download(accountId: string, url: string): Promise<{ image: Buffer | null; definitive: boolean }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), AVATAR_TIMEOUT_MS);
    try {
      const response = await this.deps.sessionFor(accountId).fetch(url, { signal: controller.signal, redirect: "error", credentials: "omit" });
      const type = (response.headers.get("content-type") ?? "").split(";")[0]?.trim() ?? "";
      const length = Number(response.headers.get("content-length") ?? "0");
      if (!response.ok || !AVATAR_TYPES.test(type) || length > AVATAR_MAX_BYTES || !response.body) return { image: null, definitive: response.status < 500 };
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > AVATAR_MAX_BYTES) {
          await reader.cancel();
          return { image: null, definitive: true };
        }
        chunks.push(value);
      }
      return { image: Buffer.concat(chunks), definitive: true };
    } catch (error) {
      this.deps.log.info("avatar-fetch-failed", { error: (error as Error).name });
      return { image: null, definitive: false };
    } finally {
      clearTimeout(timer);
    }
  }
}

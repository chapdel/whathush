// Photos des notifications (F10). Une photo servie par un autre domaine de WhatsApp
// peut être refusée à la page ; le processus principal la télécharge alors lui-même,
// avec la session du compte, seulement depuis les hôtes de WhatsApp.

export const AVATAR_MAX_BYTES = 256 * 1024;
export const AVATAR_TIMEOUT_MS = 2000;
export const AVATAR_CACHE_SIZE = 100;
export const AVATAR_TYPES = /^image\/(png|jpeg|webp|gif)$/;

/** https://*.whatsapp.net uniquement (plus les hôtes de test explicitement autorisés). */
export function isAllowedAvatarUrl(value: string, extraOrigins: readonly string[] = []): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (extraOrigins.includes(url.origin)) return true;
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) return false;
  const host = url.hostname.toLowerCase();
  return host === "whatsapp.net" || host.endsWith(".whatsapp.net");
}

/** Petit cache LRU en mémoire, jamais écrit sur le disque. */
export class LruCache<V> {
  private readonly entries = new Map<string, V>();

  constructor(private readonly capacity: number) {}

  get(key: string): V | undefined {
    const value = this.entries.get(key);
    if (value !== undefined) {
      this.entries.delete(key);
      this.entries.set(key, value);
    }
    return value;
  }

  set(key: string, value: V): void {
    this.entries.delete(key);
    this.entries.set(key, value);
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  get size(): number {
    return this.entries.size;
  }
}

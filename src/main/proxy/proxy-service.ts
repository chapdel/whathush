// Proxy HTTP / SOCKS5 avec authentification.
// - réglage global, exception par compte, appliqués par session.setProxy() à chaque
//   partition avant tout chargement ;
// - identifiants chiffrés par safeStorage dans security.json ; jamais en clair sur le
//   disque : sans trousseau sécurisé (backend basic_text), ils restent en mémoire ;
// - HTTP(S) : Chromium s'authentifie (événement login) ;
// - SOCKS5 avec identifiants : relais local (socks-relay.ts) ;
// - WebRTC : les appels ne contournent pas un proxy actif.

import { safeStorage, type AuthInfo, type Session, type WebContents } from "electron";
import crypto from "node:crypto";
import type { AccountConfig, ProxyServer } from "../../shared/schemas";
import { chromiumProxyConfig, effectiveProxy, needsRelay, proxyKey, webRtcPolicy, type EffectiveProxy, type ProxyScope } from "../core/proxy";
import type { Logger } from "../log";
import type { AppStore } from "../storage/app-store";
import { Socks5Relay } from "./socks-relay";

export interface Credentials {
  username: string;
  password: string;
}

export interface ProxyTestResult {
  ok: boolean;
  route: string;
  error?: string;
}

interface RelayEntry {
  key: string;
  relay: Socks5Relay;
  /** Promesse enregistrée avant le démarrage : deux applications simultanées partagent le même relais. */
  port: Promise<number>;
}

/**
 * La même requête qui redemande des identifiants moins de 15 s après une réponse : le
 * proxy les a refusés (Chromium rejoue la requête refusée). Des requêtes différentes en
 * parallèle, au premier chargement, demandent chacune une fois : ce n'est pas un refus.
 */
const AUTH_RETRY_WINDOW_MS = 15_000;

export class ProxyService {
  private readonly memory = new Map<ProxyScope, Credentials>();
  private readonly relays = new Map<ProxyScope, RelayEntry>();
  private readonly applied = new Map<string, string>();
  private readonly lastAnswer = new Map<string, number>();

  constructor(
    private readonly deps: {
      store: AppStore;
      log: Logger;
      sessionFor(accountId: string): Session;
      account(accountId: string): AccountConfig | undefined;
      accounts(): AccountConfig[];
      /** Pages d'un compte (vue et popups), pour la politique WebRTC. */
      pages(accountId: string): WebContents[];
      accountForPage(contents: WebContents): string | undefined;
      notifyAuthProblem(scope: ProxyScope, kind: "failed" | "missing"): void;
      /** Tests : faire passer aussi 127.0.0.1 par le proxy. */
      includeLoopback: boolean;
    }
  ) {}

  // --- Identifiants ------------------------------------------------------------------------

  /** Trousseau sécurisé disponible (pas le backend « basic_text » de Chromium). */
  secureStorage(): boolean {
    try {
      return safeStorage.isEncryptionAvailable() && safeStorage.getSelectedStorageBackend() !== "basic_text";
    } catch {
      return false;
    }
  }

  hasCredentials(scope: ProxyScope): boolean {
    return this.memory.has(scope) || this.storedSecret(scope) !== null;
  }

  private storedSecret(scope: ProxyScope): string | null {
    const secrets = this.deps.store.get("security").proxySecrets;
    return scope === "global" ? secrets.global : (secrets.accounts[scope] ?? null);
  }

  credentials(scope: ProxyScope): Credentials | null {
    const cached = this.memory.get(scope);
    if (cached) return cached;
    const secret = this.storedSecret(scope);
    if (!secret || !this.secureStorage()) return null;
    try {
      const parsed = JSON.parse(safeStorage.decryptString(Buffer.from(secret, "base64"))) as Credentials;
      if (typeof parsed.username !== "string" || typeof parsed.password !== "string") return null;
      this.memory.set(scope, parsed);
      return parsed;
    } catch (error) {
      this.deps.log.warn("proxy-secret-unreadable", { scope: scope === "global" ? "global" : "account", error: String(error) });
      return null;
    }
  }

  /** Enregistre chiffré si possible ; sinon en mémoire seulement. */
  setCredentials(scope: ProxyScope, credentials: Credentials): "saved" | "memory" {
    this.memory.set(scope, credentials);
    let result: "saved" | "memory" = "memory";
    if (this.secureStorage()) {
      const secret = safeStorage.encryptString(JSON.stringify(credentials)).toString("base64");
      this.deps.store.update("security", (file) => ({
        ...file,
        proxySecrets: scope === "global" ? { ...file.proxySecrets, global: secret } : { ...file.proxySecrets, accounts: { ...file.proxySecrets.accounts, [scope]: secret } }
      }));
      result = "saved";
    }
    this.lastAnswer.clear();
    void this.forgetCachedAuth(scope).then(() => this.applyAll());
    return result;
  }

  /**
   * Chromium garde en cache les identifiants acceptés par un proxy : sans ce nettoyage,
   * de nouveaux identifiants ne serviraient qu'après le refus des anciens.
   */
  private async forgetCachedAuth(scope: ProxyScope): Promise<void> {
    for (const account of this.deps.accounts()) {
      const proxy = this.effective(account.id);
      if (proxy.mode === "fixed" && proxy.scope === scope) await this.deps.sessionFor(account.id).clearAuthCache().catch(() => undefined);
    }
  }

  clearCredentials(scope: ProxyScope): void {
    this.memory.delete(scope);
    void this.forgetCachedAuth(scope);
    this.deps.store.update("security", (file) => {
      const accounts = { ...file.proxySecrets.accounts };
      if (scope !== "global") delete accounts[scope];
      return { ...file, proxySecrets: { global: scope === "global" ? null : file.proxySecrets.global, accounts } };
    });
    void this.applyAll();
  }

  /** Compte supprimé : ses identifiants aussi. */
  forgetAccount(accountId: string): void {
    if (this.hasCredentials(accountId)) this.clearCredentials(accountId);
    this.stopRelay(accountId);
  }

  // --- Application aux sessions ------------------------------------------------------------

  effective(accountId: string): EffectiveProxy {
    const account = this.deps.account(accountId);
    const global = this.deps.store.get("preferences").proxy;
    return account ? effectiveProxy(global, account) : { mode: "system" };
  }

  /** À attendre avant le premier chargement d'une vue. */
  async apply(accountId: string): Promise<void> {
    const proxy = this.effective(accountId);
    let relayPort: number | undefined;
    let relayKey = "";
    if (needsRelay(proxy) && proxy.mode === "fixed") {
      const relay = await this.ensureRelay(proxy.scope, proxy.server);
      relayPort = relay.port;
      relayKey = relay.key;
    }
    const config = chromiumProxyConfig(proxy, { ...(relayPort ? { relayPort } : {}), includeLoopback: this.deps.includeLoopback });
    // Le relais garde son port quand son proxy amont change : la signature inclut sa clé,
    // pour fermer aussi les connexions établies (la websocket de WhatsApp) dans ce cas.
    const signature = `${JSON.stringify(config)}|${relayKey}`;
    const ses = this.deps.sessionFor(accountId);
    if (this.applied.get(accountId) !== signature) {
      await ses.setProxy(config);
      // Les connexions déjà ouvertes gardent l'ancien chemin : on les ferme.
      await ses.closeAllConnections();
      this.applied.set(accountId, signature);
      this.deps.log.info("proxy-applied", { accountId, mode: config.mode, type: proxy.mode === "fixed" ? proxy.server.type : null, relay: Boolean(relayPort) });
    }
    for (const page of this.deps.pages(accountId)) this.applyWebRtc(page, proxy);
  }

  async applyAll(): Promise<void> {
    const used = new Set<ProxyScope>();
    for (const account of this.deps.accounts()) {
      const proxy = this.effective(account.id);
      if (needsRelay(proxy) && proxy.mode === "fixed") used.add(proxy.scope);
      await this.apply(account.id).catch((error: unknown) => this.deps.log.warn("proxy-apply-failed", { accountId: account.id, error: String(error) }));
    }
    for (const scope of [...this.relays.keys()]) if (!used.has(scope)) this.stopRelay(scope);
  }

  applyWebRtc(page: WebContents, proxy: EffectiveProxy = this.effective(this.deps.accountForPage(page) ?? "")): void {
    if (!page.isDestroyed()) page.setWebRTCIPHandlingPolicy(webRtcPolicy(proxy));
  }

  private async ensureRelay(scope: ProxyScope, server: ProxyServer): Promise<{ port: number; key: string }> {
    const credentials = this.credentials(scope);
    // Empreinte des identifiants (jamais gardés en clair dans la clé) : un mot de passe
    // changé, même de même longueur, reconfigure le relais.
    const secret = crypto.createHash("sha256").update(`${credentials?.username ?? ""}\u0000${credentials?.password ?? ""}`).digest("hex");
    const key = `${proxyKey({ mode: "fixed", server, scope })}|${secret}`;
    const existing = this.relays.get(scope);
    const upstream = { host: server.host.replace(/^\[|\]$/g, ""), port: server.port, username: credentials?.username ?? "", password: credentials?.password ?? "" };
    if (existing) {
      if (existing.key !== key) {
        existing.relay.setUpstream(upstream);
        existing.key = key;
      }
      return { port: await existing.port, key };
    }
    if (!credentials) this.deps.notifyAuthProblem(scope, "missing");
    const relay = new Socks5Relay({ upstream });
    relay.on("auth-failed", () => this.deps.notifyAuthProblem(scope, "failed"));
    relay.on("error", (error) => this.deps.log.warn("socks-relay-error", { error: error.message }));
    const port = relay.start();
    this.relays.set(scope, { key, relay, port });
    try {
      const started = await port;
      this.deps.log.info("socks-relay-started", { scope: scope === "global" ? "global" : "account" });
      return { port: started, key };
    } catch (error) {
      if (this.relays.get(scope)?.relay === relay) this.relays.delete(scope);
      throw error;
    }
  }

  private stopRelay(scope: ProxyScope): void {
    const entry = this.relays.get(scope);
    if (!entry) return;
    entry.relay.stop();
    this.relays.delete(scope);
  }

  stop(): void {
    for (const scope of [...this.relays.keys()]) this.stopRelay(scope);
  }

  // --- Authentification HTTP(S) ---------------------------------------------------------------

  /**
   * Événement login de l'application, pour un proxy. Les requêtes du service worker
   * arrivent sans WebContents : on choisit alors les identifiants par hôte et port.
   */
  handleLogin(contents: WebContents | null, url: string, authInfo: AuthInfo): Credentials | null {
    const accountId = contents ? this.deps.accountForPage(contents) : undefined;
    const candidates: ProxyScope[] = accountId ? [accountId] : this.deps.accounts().map((account) => account.id);
    const scopes = new Set<ProxyScope>();
    for (const id of candidates) {
      const proxy = this.effective(id);
      if (proxy.mode === "fixed" && proxy.server.host.replace(/^\[|\]$/g, "") === authInfo.host && proxy.server.port === authInfo.port) scopes.add(proxy.scope);
    }
    // Requête sans page (service worker) et plusieurs portées sur le même proxy avec des
    // identifiants différents : impossible de savoir quel compte la fait. On refuse plutôt
    // que de prêter les identifiants d'un compte à un autre.
    const distinct = new Set([...scopes].map((candidate) => JSON.stringify(this.credentials(candidate))));
    if (scopes.size === 0 || distinct.size > 1) {
      if (distinct.size > 1) this.deps.log.warn("proxy-login-ambiguous", { scopes: scopes.size });
      return null;
    }
    const scope = [...scopes][0] as ProxyScope;
    const answerKey = `${scope}|${authInfo.host}:${authInfo.port}|${url}`;
    const now = Date.now();
    const previous = this.lastAnswer.get(answerKey);
    if (previous !== undefined && now - previous < AUTH_RETRY_WINDOW_MS) {
      // Redemandé aussitôt : les identifiants sont refusés. On n'insiste pas.
      this.deps.notifyAuthProblem(scope, "failed");
      return null;
    }
    const credentials = this.credentials(scope);
    if (!credentials) {
      this.deps.notifyAuthProblem(scope, "missing");
      return null;
    }
    this.lastAnswer.set(answerKey, now);
    if (this.lastAnswer.size > 500) for (const [key, at] of this.lastAnswer) if (now - at > AUTH_RETRY_WINDOW_MS) this.lastAnswer.delete(key);
    return credentials;
  }

  // --- Test ------------------------------------------------------------------------------------

  /** Route vers WhatsApp et requête réelle, avec la session du compte (jamais d'identifiants affichés). */
  async test(accountId: string, targetUrl: string): Promise<ProxyTestResult> {
    const ses = this.deps.sessionFor(accountId);
    try {
      await this.apply(accountId);
      const route = await ses.resolveProxy(targetUrl);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      try {
        const response = await ses.fetch(targetUrl, { method: "GET", signal: controller.signal, cache: "no-store" });
        return response.status < 500 ? { ok: true, route: describeRoute(route) } : { ok: false, route: describeRoute(route), error: `HTTP ${response.status}` };
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      return { ok: false, route: "", error: (error as Error).message.replace(/\s+/g, " ").slice(0, 200) };
    }
  }
}

/** « PROXY proxy.local:3128 » → « PROXY proxy.local:3128 », « DIRECT » → « DIRECT » ; jamais d'identifiants. */
function describeRoute(route: string): string {
  return route.split(";")[0]?.trim() || "DIRECT";
}

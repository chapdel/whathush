// Proxy : réglage global, exception par compte, règles Chromium. Pur.
// Chromium sait s'authentifier auprès d'un proxy HTTP(S), pas d'un SOCKS5 : un
// SOCKS5 avec identifiants passe par le relais local (proxy/socks-relay.ts).

import type { AccountConfig, GlobalProxy, ProxyServer } from "../../shared/schemas";

export type ProxyScope = "global" | string;

export type EffectiveProxy =
  | { mode: "system" }
  | { mode: "direct" }
  | { mode: "fixed"; server: ProxyServer; scope: ProxyScope };

export function effectiveProxy(global: GlobalProxy, account: Pick<AccountConfig, "id" | "proxyMode" | "proxy">): EffectiveProxy {
  if (account.proxyMode === "none") return { mode: "direct" };
  if (account.proxyMode === "manual" && account.proxy) return { mode: "fixed", server: account.proxy, scope: account.id };
  if (global.mode === "none") return { mode: "direct" };
  if (global.mode === "manual" && global.server) return { mode: "fixed", server: global.server, scope: "global" };
  return { mode: "system" };
}

/** Le relais local est nécessaire : SOCKS5 avec identifiants. */
export function needsRelay(proxy: EffectiveProxy): boolean {
  return proxy.mode === "fixed" && proxy.server.type === "socks5" && proxy.server.auth;
}

export interface ChromiumProxyConfig {
  mode: "system" | "direct" | "fixed_servers";
  proxyRules?: string;
  proxyBypassRules?: string;
}

/**
 * Configuration de session.setProxy(). relayPort : port du relais local pour un SOCKS5
 * authentifié. includeLoopback : faire passer aussi 127.0.0.1 par le proxy (tests).
 */
export function chromiumProxyConfig(proxy: EffectiveProxy, options: { relayPort?: number; includeLoopback?: boolean } = {}): ChromiumProxyConfig {
  if (proxy.mode === "system") return { mode: "system" };
  if (proxy.mode === "direct") return { mode: "direct" };
  const { server } = proxy;
  const rules =
    server.type === "socks5" && server.auth
      ? `socks5://127.0.0.1:${options.relayPort ?? 0}`
      : `${server.type}://${server.host}:${server.port}`;
  return { mode: "fixed_servers", proxyRules: rules, ...(options.includeLoopback ? { proxyBypassRules: "<-loopback>" } : {}) };
}

/** Les appels WebRTC ne doivent pas contourner un proxy actif (fuite de l'adresse réelle). */
export function webRtcPolicy(proxy: EffectiveProxy): "default" | "disable_non_proxied_udp" {
  return proxy.mode === "fixed" ? "disable_non_proxied_udp" : "default";
}

export function proxyKey(proxy: EffectiveProxy): string {
  return proxy.mode === "fixed" ? `${proxy.scope}|${proxy.server.type}|${proxy.server.host}|${proxy.server.port}|${proxy.server.auth}` : proxy.mode;
}

// Lots C et D du plan complémentaire : proxy (F9), photos des notifications (F10).
import { expect, test, type ElectronApplication } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { addAccountViaUi, command, inView, launch, link, probe, state, waitForAccount } from "./harness";
import { startHttpProxy, startSocksProxy } from "./proxy-servers";

const screens = path.resolve(import.meta.dirname, "../../test-results/screens");
const normalize = (text: string) => text.replace(/\s+/g, " ");
const settingsState = (app: ElectronApplication) => app.evaluate(() => JSON.parse(JSON.stringify((globalThis as any).__whathush.settingsState())));

test("proxy (F9) : HTTP authentifié pour un compte seulement, test de connexion, identifiants refusés", async () => {
  const proxy = await startHttpProxy("alice", "s3cr3t");
  const h = await launch();
  const { app } = h;
  try {
    const personnel = await addAccountViaUi(h, "Personnel");
    await link(h, personnel, "Personnel");
    const travail = await addAccountViaUi(h, "Travail");
    await link(h, travail, "Travail");

    await command(app, { type: "set-proxy-credentials", scope: travail, username: "alice", password: "s3cr3t" });
    await command(app, { type: "update-account", id: travail, patch: { proxy: { type: "http", host: "127.0.0.1", port: proxy.port, auth: true }, proxyMode: "manual" } });
    await expect.poll(() => app.evaluate((_electron, id) => (globalThis as any).__whathush.proxy.effective(id).mode, travail)).toBe("fixed");

    proxy.requests.length = 0;
    await command(app, { type: "reload-account", id: travail });
    await expect.poll(() => proxy.requests.some((url) => url.startsWith(h.fakeUrl))).toBe(true);
    await waitForAccount(app, "Travail", (account) => account.lifecycle === "ready");
    expect(proxy.refused).toBeGreaterThanOrEqual(1); // première requête sans identifiants, puis réponse 407

    // Les appels du compte sous proxy ne le contournent pas ; l'autre compte est inchangé.
    const policy = (id: string) => app.evaluate((_electron, accountId) => (globalThis as any).__whathush.viewsManager().webContents(accountId).getWebRTCIPHandlingPolicy(), id);
    expect(await policy(travail)).toBe("disable_non_proxied_udp");
    expect(await policy(personnel)).toBe("default");

    // Revue : un lien vers ce compte endormi part par son proxy, jamais en direct.
    await command(app, { type: "sleep-account", id: travail });
    await waitForAccount(app, "Travail", (account) => account.lifecycle === "sleeping");
    proxy.requests.length = 0;
    await app.evaluate((_electron, input) => (globalThis as any).__whathush.accounts.openUrl(input.id, `${input.base}send?phone=33612345678&text=Bonjour`), { id: travail, base: h.fakeUrl });
    await expect.poll(() => proxy.requests.some((url) => url.includes("/send?phone=33612345678"))).toBe(true);
    await waitForAccount(app, "Travail", (account) => account.lifecycle === "ready");

    const seen = proxy.requests.length;
    await command(app, { type: "reload-account", id: personnel });
    await waitForAccount(app, "Personnel", (account) => account.lifecycle === "ready");
    await app.evaluate(() => new Promise((resolve) => setTimeout(resolve, 500)));
    expect(proxy.requests.length).toBe(seen);

    // Jamais en clair sur le disque ; sans trousseau (tests), en mémoire seulement.
    for (const file of fs.readdirSync(h.userData).filter((name) => name.endsWith(".json"))) {
      expect(fs.readFileSync(path.join(h.userData, file), "utf8"), file).not.toContain("s3cr3t");
    }
    const settings = await settingsState(app);
    expect(settings.security).toMatchObject({ secureStorage: false, proxyCredentials: { global: false, accounts: { [travail]: true, [personnel]: false } } });

    await command(app, { type: "test-proxy", scope: travail });
    await expect.poll(async () => (await settingsState(app)).proxyTests[travail]).toMatchObject({ ok: true, route: `PROXY 127.0.0.1:${proxy.port}` });

    // Paramètres → Réseau du compte : formulaire et résultat du test.
    const windowPromise = app.waitForEvent("window");
    await command(app, { type: "open-settings", accountId: travail });
    const window = await windowPromise;
    await window.setViewportSize({ width: 1000, height: 900 });
    await expect(window.getByText(/WhatsApp est joignable/)).toBeVisible();
    await window.getByText("Proxy de ce compte").scrollIntoViewIfNeeded();
    fs.mkdirSync(screens, { recursive: true });
    await window.screenshot({ path: path.join(screens, "41-parametres-proxy-compte.png") });
    await window.close();

    // Revue : un autre serveur ne reçoit jamais les identifiants du précédent.
    await command(app, { type: "update-account", id: travail, patch: { proxy: { type: "http", host: "127.0.0.1", port: proxy.port + 1, auth: true } } });
    expect((await settingsState(app)).security.proxyCredentials.accounts[travail]).toBe(false);
    await command(app, { type: "update-account", id: travail, patch: { proxy: { type: "http", host: "127.0.0.1", port: proxy.port, auth: true } } });
    await command(app, { type: "set-proxy-credentials", scope: travail, username: "alice", password: "s3cr3t" });

    // Identifiants refusés : on n'insiste pas, l'utilisateur est prévenu.
    await command(app, { type: "set-proxy-credentials", scope: travail, username: "alice", password: "faux" });
    await command(app, { type: "reload-account", id: travail });
    await expect.poll(async () => (await state(app)).notices.map((notice) => normalize(notice.message))).toContain(
      "Le proxy refuse les identifiants (Travail). Vérifiez-les dans Paramètres → Réseau."
    );
  } finally {
    await h.close();
    h.stopFake();
    proxy.close();
  }
});

test("proxy (F9) : SOCKS5 authentifié par le relais local, réglage global hérité", async () => {
  const socks = await startSocksProxy("bob", "m0tdepasse");
  const h = await launch();
  const { app } = h;
  try {
    const id = await addAccountViaUi(h, "Personnel");
    await link(h, id, "Personnel");
    await command(app, { type: "set-proxy-credentials", scope: "global", username: "bob", password: "m0tdepasse" });
    await command(app, { type: "set-preferences", patch: { proxy: { mode: "manual", server: { type: "socks5", host: "127.0.0.1", port: socks.port, auth: true } } } });
    await expect.poll(() => app.evaluate((_electron, accountId) => (globalThis as any).__whathush.proxy.effective(accountId), id)).toMatchObject({ mode: "fixed", scope: "global" });
    socks.requests.length = 0;
    await command(app, { type: "reload-account", id });
    const target = new URL(h.fakeUrl);
    await expect.poll(() => socks.requests).toContain(`${target.hostname}:${target.port}`);
    await waitForAccount(app, "Personnel", (account) => account.lifecycle === "ready");
    expect(socks.refused).toBe(0);
    // Chromium parle au relais local, jamais directement au proxy authentifié.
    const route = await app.evaluate(async ({ session }, accountId) => session.fromPartition(`persist:wa-${accountId}`).resolveProxy("http://example.com/"), id);
    expect(route).toMatch(/^SOCKS5 127\.0\.0\.1:\d+$/);
    expect(route).not.toContain(String(socks.port));

    // Revue : un mot de passe changé, même de même longueur, reconfigure le relais.
    await command(app, { type: "set-proxy-credentials", scope: "global", username: "bob", password: "m0tdepassX" });
    await command(app, { type: "reload-account", id });
    await expect.poll(() => socks.refused).toBeGreaterThan(0);
    await expect.poll(async () => (await state(app)).notices.map((notice) => normalize(notice.message))).toContain(
      "Le proxy refuse les identifiants (tous les comptes). Vérifiez-les dans Paramètres → Réseau."
    );

    // Retour au proxy du système : le relais s'arrête.
    await command(app, { type: "set-preferences", patch: { proxy: { mode: "system", server: { type: "socks5", host: "127.0.0.1", port: socks.port, auth: true } } } });
    await expect.poll(() => app.evaluate(() => (globalThis as any).__whathush.proxy.relays.size)).toBe(0);
  } finally {
    await h.close();
    h.stopFake();
    socks.close();
  }
});

test("photos des notifications (F10) : autre origine téléchargée par le principal, bornée et filtrée", async () => {
  const h = await launch();
  const { app } = h;
  const last = async () => (await probe(app)).notifications.at(-1);
  try {
    const id = await addAccountViaUi(h, "Personnel");
    await link(h, id, "Personnel");
    await inView(app, id, `fake.notify('Marie', 'Avec photo', 'p1', '${h.avatarOrigin}/avatar.png')`);
    await expect.poll(last).toMatchObject({ body: "Avec photo", hasIcon: true });
    // Trop lourde (300 Kio) : notification sans photo.
    await inView(app, id, `fake.notify('Marie', 'Trop lourde', 'p2', '${h.avatarOrigin}/huge.png')`);
    await expect.poll(last).toMatchObject({ body: "Trop lourde", hasIcon: false });
    // Hôte non autorisé (autre origine que celle de WhatsApp) : jamais téléchargée.
    const other = h.avatarOrigin.replace("127.0.0.1", "localhost");
    await inView(app, id, `fake.notify('Marie', 'Hôte inconnu', 'p3', '${other}/avatar.png')`);
    await expect.poll(last).toMatchObject({ body: "Hôte inconnu", hasIcon: false });
    // Aperçu désactivé : ni texte ni photo.
    await command(app, { type: "update-account", id, patch: { notifications: { showPreview: false } } });
    await inView(app, id, `fake.notify('Marie', 'Sans aperçu', 'p4', '${h.avatarOrigin}/avatar.png')`);
    await expect.poll(last).toMatchObject({ body: "Nouveau message", hasIcon: false });
  } finally {
    await h.close();
    h.stopFake();
  }
});

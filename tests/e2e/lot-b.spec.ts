// Lot B du plan complémentaire : verrouillage (F6), voile (F7), autorisations (F8).
import { expect, test, type ElectronApplication } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { addAccountViaUi, command, inView, launch, link, pressShortcut, probe, screenshot, state, waitForAccount } from "./harness";

const screens = path.resolve(import.meta.dirname, "../../test-results/screens");
const shown = (app: ElectronApplication) => app.evaluate(() => (globalThis as any).__whathush.viewsManager().shown());
const windows = (app: ElectronApplication) => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
const normalize = (text: string) => text.replace(/\s+/g, " ");

test("verrouillage (F6) : code, verrouiller, délai croissant, pavé, notifications sans aperçu", async () => {
  const h = await launch();
  const { app, shell } = h;
  try {
    const id = await addAccountViaUi(h, "Personnel");
    await link(h, id, "Personnel");

    const settingsPromise = app.waitForEvent("window");
    await command(app, { type: "open-settings", section: "security" });
    const settings = await settingsPromise;
    await settings.setViewportSize({ width: 1000, height: 720 });
    await expect(settings.getByRole("heading", { name: "Sécurité" })).toBeVisible();
    await settings.getByLabel("Nouveau code").fill("2468");
    await settings.getByLabel("Confirmer le code").fill("2467");
    await expect(settings.getByText("Les deux codes ne correspondent pas.")).toBeVisible();
    await expect(settings.getByRole("button", { name: "Activer le verrou" })).toBeDisabled();
    await settings.getByLabel("Confirmer le code").fill("2468");
    await settings.getByRole("button", { name: "Activer le verrou" }).click();
    await expect(settings.getByText("Verrou activé.")).toBeVisible();
    const securityFile = path.join(h.userData, "security.json");
    const security = JSON.parse(fs.readFileSync(securityFile, "utf8"));
    expect(security.lock).toMatchObject({ enabled: true, params: { N: 32768, r: 8, p: 1 } });
    expect(security.lock.hash).toHaveLength(44);
    expect(fs.readFileSync(securityFile, "utf8")).not.toContain("2468");
    expect(fs.statSync(securityFile).mode & 0o777).toBe(0o600);
    fs.mkdirSync(screens, { recursive: true });
    await settings.screenshot({ path: path.join(screens, "36-parametres-securite.png") });

    // Ctrl+Maj+L depuis la vue WhatsApp : vues masquées, paramètres fermés, rien dans l'état.
    await pressShortcut(app, id, "L", ["control", "shift"]);
    await expect(shell.getByRole("heading", { name: /WhatHush est verrouillé/ })).toBeVisible();
    await expect.poll(() => shown(app)).toBeNull();
    await expect.poll(() => windows(app)).toBe(1);
    expect((await state(app)).accounts).toEqual([]);
    expect((await state(app)).notices).toEqual([]);
    await screenshot(h, "37-verrouille");

    // Raccourcis et commandes ignorés pendant le verrouillage.
    await pressShortcut(app, "shell", ",");
    await pressShortcut(app, "shell", "1");
    await command(app, { type: "open-settings" });
    await shell.waitForTimeout(300);
    expect(await windows(app)).toBe(1);
    expect(await shown(app)).toBeNull();

    // Notification reçue verrouillé : elle reste, sans aperçu ni expéditeur.
    await inView(app, id, "fake.notify('Marie', 'Message secret', 'lock-test')");
    await expect.poll(async () => (await probe(app)).notifications.at(-1)).toMatchObject({ title: "Personnel", body: "Nouveau message", hasIcon: false });

    // Mauvais code, puis délai croissant.
    const code = shell.getByLabel("Code", { exact: true });
    await code.fill("0000");
    await code.press("Enter");
    await expect(shell.getByText("Code incorrect.")).toBeVisible();
    await expect(code).toBeEnabled({ timeout: 5000 });
    await code.fill("1111");
    await code.press("Enter");
    await expect(shell.getByText(/Trop d’essais\. Réessayez dans \d+ secondes?\./)).toBeVisible();
    await expect(code).toBeDisabled();
    expect(JSON.parse(fs.readFileSync(securityFile, "utf8")).failures.count).toBe(2);

    // Pavé numérique, une fois le délai passé.
    await expect(code).toBeEnabled({ timeout: 8000 });
    for (const digit of "2468") await shell.locator(".keypad").getByRole("button", { name: digit, exact: true }).click();
    await shell.getByRole("button", { name: "Déverrouiller" }).click();
    await expect.poll(() => shown(app)).toBe(id);
    expect(JSON.parse(fs.readFileSync(securityFile, "utf8")).failures).toEqual({ count: 0, lastAt: null });
    expect((await state(app)).accounts).toHaveLength(1);
  } finally {
    await h.close();
    h.stopFake();
  }
});

test("verrouillage (F6) : inactivité, fenêtre masquée, démarrage, et « Code oublié » efface les sessions", async () => {
  const h = await launch();
  try {
    const id = await addAccountViaUi(h, "Personnel");
    await link(h, id, "Personnel");
    await command(h.app, { type: "set-lock-code", current: null, next: "1357" });
    await command(h.app, { type: "set-lock-options", options: { idleMinutes: 15, onHide: true } });

    await h.app.evaluate(() => {
      const application = (globalThis as any).__whathush;
      application.probe.idleSeconds = 14 * 60;
      application.lock.trigger("idle");
    });
    expect((await state(h.app)).lock.locked).toBe(false);
    await h.app.evaluate(() => {
      const application = (globalThis as any).__whathush;
      application.probe.idleSeconds = 15 * 60;
      application.lock.trigger("idle");
    });
    await expect.poll(async () => (await state(h.app)).lock.locked).toBe(true);
    await command(h.app, { type: "unlock", code: "1357" });
    await expect.poll(() => shown(h.app)).toBe(id);

    await h.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.hide());
    await expect.poll(async () => (await state(h.app)).lock.locked).toBe(true);
    await h.app.evaluate(() => (globalThis as any).__whathush.showMainWindow());
    await command(h.app, { type: "unlock", code: "1357" });
    await expect.poll(() => shown(h.app)).toBe(id);
  } finally {
    await h.close();
  }

  // Redémarrage : verrouillé avant d'afficher quoi que ce soit.
  const again = await launch({ userData: h.userData, fakeUrl: h.fakeUrl });
  try {
    await expect(again.shell.getByRole("heading", { name: /WhatHush est verrouillé/ })).toBeVisible();
    expect(await shown(again.app)).toBeNull();
    await again.app.evaluate(({ dialog }) => {
      (globalThis as any).__confirm = [];
      (dialog as any).showMessageBox = async (_parent: unknown, options: { message: string }) => {
        (globalThis as any).__confirm.push(options.message);
        return { response: 1 };
      };
    });
    // Revue : si une session ne peut pas être effacée, le verrou reste en place.
    await again.app.evaluate(({ session }) => {
      const application = (globalThis as any).__whathush;
      const ses = session.fromPartition(`persist:wa-${application.accounts.accounts()[0].id}`);
      (globalThis as any).__clear = ses.clearStorageData;
      (ses as any).clearStorageData = async () => {
        throw new Error("disque en lecture seule");
      };
    });
    await again.shell.getByRole("button", { name: "Code oublié ?" }).click();
    await expect.poll(() => again.app.evaluate(() => (globalThis as any).__confirm.length)).toBe(2);
    expect(normalize((await again.app.evaluate(() => (globalThis as any).__confirm))[1])).toContain("le verrou reste en place");
    expect((await state(again.app)).lock.locked).toBe(true);
    expect(await shown(again.app)).toBeNull();
    await again.app.evaluate(({ session }) => {
      const application = (globalThis as any).__whathush;
      const ses = session.fromPartition(`persist:wa-${application.accounts.accounts()[0].id}`);
      delete (ses as any).clearStorageData;
      (globalThis as any).__confirm = [];
    });
    await again.shell.getByRole("button", { name: "Code oublié ?" }).click();
    expect(normalize((await again.app.evaluate(() => (globalThis as any).__confirm))[0])).toBe("Effacer toutes les sessions WhatsApp ?");
    // Sessions effacées : le compte doit être relié de nouveau ; réglages gardés.
    await waitForAccount(again.app, "Personnel", (account) => account.lifecycle === "needs_qr");
    expect((await state(again.app)).lock).toMatchObject({ enabled: false, locked: false });
    expect(JSON.parse(fs.readFileSync(path.join(h.userData, "security.json"), "utf8")).lock).toMatchObject({ enabled: false, hash: "", salt: "" });
    await expect(again.shell.getByText(/Verrou retiré et sessions effacées/)).toBeVisible();
  } finally {
    await again.close();
    h.stopFake();
  }
});

test("voile (F7a) : bascule, survol, perte de focus, partage d'écran (clic seulement)", async () => {
  const h = await launch();
  const { app } = h;
  const blurred = (id: string) => inView<string>(app, id, "fake.blurred()");
  const mouse = (id: string, type: "mouseMove" | "mouseDown") =>
    app.evaluate((_electron, input) => {
      const wc = (globalThis as any).__whathush.viewsManager().webContents(input.id);
      if (input.type === "mouseDown") {
        wc.sendInputEvent({ type: "mouseDown", x: 300, y: 300, button: "left", clickCount: 1 });
        wc.sendInputEvent({ type: "mouseUp", x: 300, y: 300, button: "left", clickCount: 1 });
      } else wc.sendInputEvent({ type: "mouseMove", x: 300, y: 300 });
    }, { id, type });
  try {
    const id = await addAccountViaUi(h, "Personnel");
    await link(h, id, "Personnel");
    await pressShortcut(app, id, "H", ["control", "shift"]);
    await expect.poll(() => blurred(id)).toContain("blur");
    expect((await state(app)).veiled).toBe(true);
    await screenshot(h, "38-voile");
    await mouse(id, "mouseMove");
    await expect.poll(() => blurred(id)).toBe("none");

    // Perte de focus de la fenêtre (option) : voilé de nouveau.
    await command(app, { type: "set-preferences", patch: { privacyVeil: { onBlur: true } } });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.emit("blur"));
    await expect.poll(() => blurred(id)).toContain("blur");
    await mouse(id, "mouseDown");
    await expect.poll(() => blurred(id)).toBe("none");

    // Partage d'écran (option) : le survol ne suffit pas, il faut un clic.
    await command(app, { type: "set-preferences", patch: { privacyVeil: { onScreenShare: true } } });
    const wcId = await app.evaluate((_electron, accountId) => (globalThis as any).__whathush.viewsManager().webContents(accountId).id, id);
    await app.evaluate((_electron, input) => (globalThis as any).__whathush.calls.onMedia(input.id, input.wcId, { source: "getDisplayMedia", event: "start", trackKind: "video" }), { id, wcId });
    await expect.poll(() => blurred(id)).toContain("blur");
    await mouse(id, "mouseMove");
    await app.evaluate(() => new Promise((resolve) => setTimeout(resolve, 300)));
    expect(await blurred(id)).toContain("blur");
    await mouse(id, "mouseDown");
    await expect.poll(() => blurred(id)).toBe("none");
    await app.evaluate((_electron, input) => (globalThis as any).__whathush.calls.onMedia(input.id, input.wcId, { source: "getDisplayMedia", event: "stop", trackKind: "video" }), { id, wcId });
  } finally {
    await h.close();
    h.stopFake();
  }
});

test("flou des messages (F7b, expérimental) : repères reconnus, sinon désactivé avec une information", async () => {
  const h = await launch();
  const { app } = h;
  const messageFilter = (id: string) => inView<string>(app, id, "getComputedStyle(document.querySelector('.msg')).filter");
  try {
    const a = await addAccountViaUi(h, "Personnel");
    await link(h, a, "Personnel");
    const b = await addAccountViaUi(h, "Travail");
    await link(h, b, "Travail");
    // WhatsApp a changé sur « Travail » : plus aucun repère.
    await inView(app, b, "document.querySelectorAll('[data-pre-plain-text],[data-testid=\"cell-frame-secondary\"]').forEach((element) => { element.removeAttribute('data-pre-plain-text'); element.removeAttribute('data-testid'); })");
    await command(app, { type: "set-preferences", patch: { privacyVeil: { blurMessages: true } } });
    await expect.poll(() => inView<string>(app, a, "getComputedStyle(document.querySelector('[data-pre-plain-text]')).filter")).toContain("blur");
    await expect.poll(async () => (await state(app)).notices.map((notice) => normalize(notice.message))).toContain(
      "Flou des messages indisponible sur « Travail » : la page de WhatsApp a changé. Le voile de la conversation entière reste disponible."
    );
    // Le compte resté compatible garde son flou ; l'autre n'a aucune règle appliquée.
    expect(await messageFilter(b)).toBe("none");
    await command(app, { type: "switch-account", id: a });
    await screenshot(h, "39-flou-messages");
  } finally {
    await h.close();
    h.stopFake();
  }
});

test("autorisations (F8) : caméra refusée, « Demander » puis « Toujours pour ce compte », localisation", async () => {
  const h = await launch();
  const { app } = h;
  try {
    const id = await addAccountViaUi(h, "Personnel");
    await link(h, id, "Personnel");
    // Par défaut : micro et caméra permis, localisation refusée.
    expect(await inView(app, id, "fake.camera()")).toBe("ok");
    expect(await inView(app, id, "fake.location()")).toBe("error:1");

    await command(app, { type: "update-account", id, patch: { permissions: { camera: "deny" } } });
    expect(await inView(app, id, "fake.camera()")).toBe("NotAllowedError");

    await app.evaluate(({ dialog }) => {
      (globalThis as any).__asked = [];
      (dialog as any).showMessageBox = async (_parent: unknown, options: { message: string; buttons: string[] }) => {
        (globalThis as any).__asked.push(options);
        return { response: 2 };
      };
    });
    await command(app, { type: "update-account", id, patch: { permissions: { camera: "ask" } } });
    expect(await inView(app, id, "fake.camera()")).toBe("ok");
    const asked = await app.evaluate(() => (globalThis as any).__asked);
    expect(asked).toHaveLength(1);
    expect(normalize(asked[0].message)).toBe("« Personnel » veut utiliser la caméra.");
    expect(asked[0].buttons).toEqual(["Refuser", "Autoriser cette fois", "Toujours pour ce compte"]);
    const saved = JSON.parse(fs.readFileSync(path.join(h.userData, "accounts.json"), "utf8")).accounts[0].permissions;
    expect(saved).toEqual({ microphone: "allow", camera: "allow", location: "deny", screenShare: "ask" });
    // Désormais permis : plus de question.
    expect(await inView(app, id, "fake.camera()")).toBe("ok");
    expect(await app.evaluate(() => (globalThis as any).__asked.length)).toBe(1);

    // Réglage depuis les paramètres.
    const settingsPromise = app.waitForEvent("window");
    await command(app, { type: "open-settings", accountId: id });
    const settings = await settingsPromise;
    await settings.setViewportSize({ width: 1000, height: 720 });
    await settings.getByRole("radiogroup", { name: "Micro" }).getByRole("radio", { name: "Refuser" }).click();
    await expect.poll(() => JSON.parse(fs.readFileSync(path.join(h.userData, "accounts.json"), "utf8")).accounts[0].permissions.microphone).toBe("deny");
    await settings.getByRole("heading", { name: "Autorisations" }).or(settings.getByText("Autorisations", { exact: true })).first().scrollIntoViewIfNeeded();
    await settings.screenshot({ path: path.join(screens, "40-parametres-autorisations.png") });
  } finally {
    await h.close();
    h.stopFake();
  }
});

test("revue : verrou et popups, focus, essais simultanés, voile limité à la page affichée", async () => {
  const h = await launch();
  const { app, shell } = h;
  const popupVisible = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((window) => window.webContents.getURL().includes("/popup")).map((window) => window.isVisible()));
  try {
    const a = await addAccountViaUi(h, "Personnel");
    await link(h, a, "Personnel");
    const b = await addAccountViaUi(h, "Travail");
    await link(h, b, "Travail");
    await command(app, { type: "switch-account", id: a });
    await command(app, { type: "set-lock-code", current: null, next: "9876" });

    // Popup de WhatsApp (appel) : masquée pendant le verrouillage, réaffichée ensuite.
    await inView(app, a, "window.open('/popup', '_blank', 'width=420,height=320') !== null");
    await expect.poll(popupVisible).toEqual([true]);
    await pressShortcut(app, a, "L", ["control", "shift"]);
    await expect.poll(popupVisible).toEqual([false]);
    // Pas de nouvelle popup tant que c'est verrouillé ; le clavier va à l'écran de verrouillage.
    expect(await inView(app, a, "window.open('/popup', '_blank', 'width=420,height=320') === null")).toBe(true);
    expect(await popupVisible()).toEqual([false]);
    // Aucune vue WhatsApp ne garde le clavier ; en revenant à la fenêtre, il va au champ du code.
    expect(await app.evaluate((_electron, id) => (globalThis as any).__whathush.viewsManager().webContents(id).isFocused(), a)).toBe(false);
    await expect.poll(() => app.evaluate(() => (globalThis as any).__whathush.mainWebContents().isFocused())).toBe(true);
    // F12 ignoré, même avec les outils de développement disponibles (build de développement).
    await pressShortcut(app, "shell", "F12", []);
    expect(await app.evaluate((_electron, id) => (globalThis as any).__whathush.viewsManager().webContents(id).isDevToolsOpened(), a)).toBe(false);

    // Trois essais simultanés : un seul est compté, les autres sont refusés sans calcul.
    await app.evaluate(async () => {
      const application = (globalThis as any).__whathush;
      await Promise.all(["0000", "1111", "2222"].map((code) => application.handleCommand({ type: "unlock", code })));
    });
    expect(JSON.parse(fs.readFileSync(path.join(h.userData, "security.json"), "utf8")).failures.count).toBe(1);
    await expect(shell.getByLabel("Code", { exact: true })).toBeEnabled({ timeout: 5000 });
    await command(app, { type: "unlock", code: "9876" });
    await expect.poll(popupVisible).toEqual([true]);
    await expect.poll(() => shown(app)).toBe(a);

    // Voile : ni la vue cachée ni un événement fabriqué par la page ne dévoilent.
    await command(app, { type: "toggle-veil" });
    await expect.poll(() => inView<string>(app, a, "fake.blurred()")).toContain("blur");
    await app.evaluate((_electron, id) => (globalThis as any).__whathush.viewsManager().webContents(id).sendInputEvent({ type: "mouseMove", x: 300, y: 300 }), b);
    await inView(app, a, "window.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))");
    await app.evaluate(() => new Promise((resolve) => setTimeout(resolve, 300)));
    expect((await state(app)).veiled).toBe(true);
    await app.evaluate((_electron, id) => (globalThis as any).__whathush.viewsManager().webContents(id).sendInputEvent({ type: "mouseMove", x: 300, y: 300 }), a);
    await expect.poll(async () => (await state(app)).veiled).toBe(false);
  } finally {
    await h.close();
    h.stopFake();
  }
});

test("revue : un lien vers un compte endormi s'ouvre bien, après son proxy", async () => {
  const h = await launch();
  const { app } = h;
  try {
    const a = await addAccountViaUi(h, "Personnel");
    await link(h, a, "Personnel");
    await command(app, { type: "sleep-account", id: a });
    await waitForAccount(app, "Personnel", (account) => account.lifecycle === "sleeping");
    await app.evaluate(() => (globalThis as any).__whathush.links.handleExternal("whatsapp://send?phone=33612345678&text=Bonjour"));
    await expect
      .poll(() => app.evaluate((_electron, id) => (globalThis as any).__whathush.viewsManager().webContents(id)?.getURL() ?? "", a))
      .toContain("/send?phone=33612345678");
    await waitForAccount(app, "Personnel", (account) => account.lifecycle === "ready");
    expect(await app.evaluate((_electron, id) => (globalThis as any).__whathush.viewsManager().webContents(id).getURL(), a)).toContain("/send?phone=33612345678");
  } finally {
    await h.close();
    h.stopFake();
  }
});

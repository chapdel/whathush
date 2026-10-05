import { expect, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { addAccountViaUi, command, inView, launch, link, pressShortcut, probe, screenshot, state, waitForAccount } from "./harness";

test("clavier : comptes, focus du dialogue, Snooze en deux actions et paramètres contextuels", async () => {
  const h = await launch();
  try {
    const first = await addAccountViaUi(h, "Personnel");
    await link(h, first, "Personnel");
    const second = await addAccountViaUi(h, "Travail");
    await link(h, second, "Travail");
    await pressShortcut(h.app, second, "F6", []);
    await expect(h.shell.locator('.account-switch[aria-current="true"]')).toBeFocused();
    await h.shell.keyboard.press("ArrowUp");
    await expect(h.shell.locator('[data-account="Personnel"] .account-switch')).toBeFocused();
    await h.shell.keyboard.press("Space");
    await expect.poll(async () => (await state(h.app)).activeId).toBe(first);

    const add = h.shell.getByRole("button", { name: "Ajouter un compte", exact: true });
    await add.focus();
    await h.shell.keyboard.press("Enter");
    const dialog = h.shell.getByRole("dialog");
    await expect(dialog.getByRole("textbox")).toBeFocused();
    for (let i = 0; i < 10; i++) {
      await h.shell.keyboard.press("Tab");
      expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
    }
    await h.shell.keyboard.press("Escape");
    await expect(add).toBeFocused();
    await expect.poll(() => h.app.evaluate(() => (globalThis as any).__whathush.viewsManager().shown())).toBe(first);

    // Les vrais modèles Menu Electron sont capturés ; seuls leur affichage et le clic sont pilotés.
    await h.app.evaluate(({ Menu }) => {
      (Menu.prototype as any).popup = function () { (globalThis as any).__uiMenu = this; };
    });
    await h.shell.locator('[data-account="Travail"]').hover();
    await h.shell.getByRole("button", { name: "Snooze Travail", exact: true }).click();
    const labels = await h.app.evaluate(() => (globalThis as any).__uiMenu.items.map((item: any) => item.label));
    expect(labels).toEqual(["30 minutes", "1 heure", "4 heures", "Jusqu’à demain matin", "Jusqu’à lundi", "Jusqu’à réactivation", "Jusqu’à une date…"]);
    await h.app.evaluate(() => (globalThis as any).__uiMenu.items[0].click());
    await waitForAccount(h.app, "Travail", (account) => account.policy.mode === "snoozed");
    await h.shell.getByRole("button", { name: "Réactiver les notifications de Travail" }).click();
    await waitForAccount(h.app, "Travail", (account) => account.policy.mode === "normal");

    await h.shell.locator('[data-account="Travail"] .account-switch').focus();
    await h.shell.keyboard.press("Shift+F10");
    const settingsPromise = h.app.waitForEvent("window");
    await h.app.evaluate(() => (globalThis as any).__uiMenu.items.find((item: any) => item.label === "Paramètres…").click());
    const settings = await settingsPromise;
    await expect(settings.getByRole("heading", { name: "Comptes" })).toBeVisible();
    await expect(settings.getByLabel("Nom", { exact: true })).toHaveValue("Travail");
    await settings.getByRole("button", { name: "Apparence", exact: true }).click();
    const system = settings.getByRole("radio", { name: "Système", exact: true });
    await system.focus();
    await settings.keyboard.press("ArrowRight");
    await expect(settings.getByRole("radio", { name: "Clair", exact: true })).toBeFocused();
    await expect(settings.getByRole("radio", { name: "Clair", exact: true })).toHaveAttribute("aria-checked", "true");
  } finally { await h.close(); h.stopFake(); }
});

test("réseau, badge désactivé et notices dans la sidebar compacte", async () => {
  const h = await launch();
  try {
    const id = await addAccountViaUi(h, "Personnel");
    await link(h, id, "Personnel");
    await command(h.app, { type: "update-account", id, patch: { icon: "briefcase" } });
    await inView(h.app, id, 'fake.notify("Marie", "Message de test", "identity-test")');
    await expect.poll(async () => (await probe(h.app)).notifications.at(-1)?.title).toBe("Personnel — Marie");
    await inView(h.app, id, "fake.setUnread(1200)");
    await expect(h.shell.locator(".account > .badge")).toHaveText("99+");
    await command(h.app, { type: "update-account", id, patch: { notifications: { badge: false } } });
    await expect(h.shell.locator(".account .badge")).toHaveCount(0);
    await command(h.app, { type: "update-account", id, patch: { notifications: { badge: true } } });
    await h.app.evaluate(() => (globalThis as any).__whathush.accounts.networkChanged(false));
    await waitForAccount(h.app, "Personnel", (account) => account.lifecycle === "offline");
    await expect(h.shell.getByText("Connexion interrompue", { exact: false })).toBeVisible();
    await expect.poll(() => h.app.evaluate(() => (globalThis as any).__whathush.viewBounds().y)).toBe(44);
    await screenshot(h, "20-hors-ligne");
    await h.shell.getByRole("button", { name: "Réessayer", exact: true }).click();
    await waitForAccount(h.app, "Personnel", (account) => account.lifecycle === "ready");
    await expect(h.shell.locator(".connection-bar")).toHaveCount(0);
    expect(await h.app.evaluate(() => (globalThis as any).__whathush.viewBounds().y)).toBe(0);
    await command(h.app, { type: "set-preferences", patch: { sidebarCollapsed: true } });
    await h.app.evaluate((_electron, accountId) => (globalThis as any).__whathush.addNotice({
      id: "ui-notice", level: "info", message: "Un compte peut être mis en veille.", sticky: true,
      action: { label: "Mettre en veille", command: { type: "sleep-account", id: accountId } }
    }), id);
    await h.shell.getByRole("button", { name: /informations? à consulter/ }).click();
    await expect(h.shell.getByRole("dialog")).toContainText("Un compte peut être mis en veille.");
    await h.shell.getByRole("button", { name: "Mettre en veille", exact: true }).click();
    await waitForAccount(h.app, "Personnel", (account) => account.lifecycle === "sleeping");
    await h.shell.keyboard.press("Escape");
    await expect(h.shell.getByRole("heading", { name: /est en veille/ })).toBeVisible();
    await h.shell.getByRole("button", { name: "Réveiller", exact: true }).click();
    await waitForAccount(h.app, "Personnel", (account) => account.lifecycle === "ready");
  } finally { await h.close(); h.stopFake(); }
});

test("matrice visuelle : 1/2/5/10 comptes, états, tailles et thèmes", async () => {
  const h = await launch({ screenSize: "4096,2304" });
  test.setTimeout(180_000);
  try {
    const names = ["Personnel", "Travail", "Support", "Business", "Projet international — équipe Montréal", "Projet B", "Déconnecté", "Service clients", "En erreur", "Dernier compte"];
    for (const [index, name] of names.entries()) {
      await command(h.app, { type: "add-account", label: name });
      const account = await waitForAccount(h.app, name, (item) => item.lifecycle === "needs_qr");
      if (index !== 6) await link(h, account.id, name);
      if ([1, 2, 5, 10].includes(index + 1)) {
        await h.shell.mouse.move(500, 300);
        await expect(h.shell.locator(".account")).toHaveCount(index + 1);
        await screenshot(h, `matrix-${index + 1}-comptes`);
      }
    }
    const accounts = (await state(h.app)).accounts;
    for (const [index, unread] of [1, 99, 1200].entries()) await inView(h.app, accounts[index]!.id, `fake.setUnread(${unread})`);
    await expect(h.shell.locator(".account > .badge").first()).toHaveText("1");
    await expect(h.shell.locator('[data-account="Travail"] > .badge')).toHaveText("99");
    await expect(h.shell.locator('[data-account="Support"] > .badge')).toHaveText("99+");
    await command(h.app, { type: "snooze", id: accounts[2]!.id, preset: { kind: "minutes", minutes: 60 } });
    await command(h.app, { type: "sleep-account", id: accounts[3]!.id });
    await h.app.evaluate((_electron, id) => {
      const app = (globalThis as any).__whathush;
      app.viewsManager().destroy(id);
      app.accounts.runtime(id).lifecycle = "crashed";
      app.accounts.refreshVisibility();
      app.pushState();
    }, accounts[8]!.id);
    await command(h.app, { type: "switch-account", id: accounts[0]!.id });
    const dimensions = [[800, 600], [1024, 768], [1280, 720], [1366, 768], [1440, 900], [1920, 1080], [2560, 1440], [3440, 1440], [3840, 2160]];
    for (const theme of ["light", "dark"] as const) {
      await command(h.app, { type: "set-preferences", patch: { theme } });
      await h.shell.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      for (const page of h.app.context().pages()) {
        if (page.url().startsWith(h.fakeUrl)) await page.emulateMedia({ colorScheme: theme });
      }
      expect(await inView(h.app, accounts[0]!.id, 'matchMedia("(prefers-color-scheme: dark)").matches')).toBe(theme === "dark");
      // Contrastes des textes/états, y compris les surfaces sélectionnées.
      const ratios = await h.shell.evaluate(() => {
        const tokens = getComputedStyle(document.documentElement);
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 1;
        const context = canvas.getContext("2d")!;
        const luminance = (name: string) => {
          context.fillStyle = tokens.getPropertyValue(name).trim();
          context.fillRect(0, 0, 1, 1);
          const rgb = context.getImageData(0, 0, 1, 1).data;
          const channels = [0, 1, 2].map((i) => rgb[i]! / 255).map((v) => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
          return channels[0]! * .2126 + channels[1]! * .7152 + channels[2]! * .0722;
        };
        return [["--text", "--sidebar"], ["--muted", "--sidebar-active"], ["--muted", "--surface"], ["--warning", "--sidebar-active"], ["--danger", "--sidebar-active"], ["--on-accent", "--accent"]].map(([text, background]) => {
          const a = luminance(text!), b = luminance(background!);
          return { text, background, ratio: (Math.max(a, b) + .05) / (Math.min(a, b) + .05) };
        });
      });
      for (const { ratio, text, background } of ratios) expect(ratio, `${theme}: ${text}/${background}`).toBeGreaterThanOrEqual(4.5);
      for (const [width, height] of dimensions) {
        await h.app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]!.setContentSize(size[0]!, size[1]!), [width!, height!]);
        await expect.poll(() => h.shell.evaluate(() => [innerWidth, innerHeight])).toEqual([width, height]);
        expect(await h.shell.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        const bounds = await h.app.evaluate(() => (globalThis as any).__whathush.viewBounds());
        expect(bounds).toMatchObject({ x: width! < 960 ? 76 : 232, width: width! - (width! < 960 ? 76 : 232), height });
        const last = h.shell.locator('[data-account="Dernier compte"] .account-switch');
        await last.focus();
        await expect(last).toBeInViewport();
        await h.shell.locator('.account-switch[aria-current="true"]').focus();
        await h.shell.mouse.move(500, 300);
        await screenshot(h, `matrix-${theme}-${width}x${height}`);
      }
    }
    const settingsPromise = h.app.waitForEvent("window");
    await command(h.app, { type: "open-settings" });
    const settings = await settingsPromise;
    for (const width of [760, 800, 1000, 1280]) {
      await h.app.evaluate(({ BrowserWindow }, w) => BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().endsWith("settings.html"))!.setContentSize(w, 600), width);
      await expect.poll(() => settings.evaluate(() => innerWidth)).toBe(width);
      for (const section of ["Général", "Apparence", "Comptes", "Horaires", "Focus", "Sécurité", "Fichiers et liens", "Téléchargements", "Réseau", "À propos"]) {
        await settings.getByRole("button", { name: section, exact: true }).click();
        await expect(settings.getByRole("heading", { name: section, exact: true })).toBeVisible();
        expect(await settings.locator(".settings-main").evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
        if (section === "Comptes") await settings.locator(".list-item", { hasText: "Projet international" }).click();
        await settings.screenshot({ path: path.resolve("test-results/screens", `matrix-settings-${width}-${section}.png`) });
      }
    }
    fs.writeFileSync(path.resolve("test-results/screens/matrix-summary.json"), JSON.stringify({ dimensions, accountCounts: [1, 2, 5, 10], themes: ["light", "dark"], settingsWidths: [760, 800, 1000, 1280] }, null, 2));
  } finally { await h.close(); h.stopFake(); }
});

for (const scaleFactor of [1, 1.25, 1.5, 1.75, 2]) {
  test(`HiDPI ${scaleFactor * 100}% : géométrie shell/vue et dialogue`, async () => {
    const h = await launch({ scaleFactor, screenSize: "4096,2304" });
    try {
      const id = await addAccountViaUi(h, "Travail");
      await link(h, id, "Travail");
      expect(await h.shell.evaluate(() => devicePixelRatio)).toBe(scaleFactor);
      const native = await h.app.evaluate(() => (globalThis as any).__whathush.viewBounds());
      const sidebar = await h.shell.locator(".sidebar").boundingBox();
      expect(native.x).toBeCloseTo(sidebar!.width, 3);
      await screenshot(h, `matrix-hidpi-${scaleFactor * 100}-comptes`);
      await h.shell.getByRole("button", { name: "Ajouter un compte", exact: true }).click();
      const dialog = await h.shell.getByRole("dialog").boundingBox();
      expect(Math.round(dialog!.width)).toBeLessThanOrEqual(440);
      await screenshot(h, `matrix-hidpi-${scaleFactor * 100}`);
    } finally { await h.close(); h.stopFake(); }
  });
}

test("suppression : une confirmation native, annulation conservée, résultat visible dans les paramètres", async () => {
  const h = await launch();
  try {
    const id = await addAccountViaUi(h, "Personnel");
    await link(h, id, "Personnel");
    const settingsPromise = h.app.waitForEvent("window");
    await command(h.app, { type: "open-settings", accountId: id });
    const settings = await settingsPromise;
    await expect(settings.getByRole("heading", { name: "Comptes" })).toBeVisible();
    await settings.getByRole("button", { name: "Vider le cache", exact: true }).click();
    await expect(settings.getByText("Cache vidé. La session WhatsApp est conservée.")).toBeVisible();
    await h.app.evaluate(({ dialog }) => {
      (globalThis as any).__confirmations = [];
      (dialog as any).showMessageBox = async (_parent: any, options: any) => {
        (globalThis as any).__confirmations.push(options);
        return { response: 0 };
      };
    });
    await settings.getByRole("button", { name: "Supprimer le compte…", exact: true }).click();
    await expect.poll(() => h.app.evaluate(() => (globalThis as any).__confirmations.length)).toBe(1);
    expect((await state(h.app)).accounts).toHaveLength(1);
    expect(await h.app.evaluate(() => (globalThis as any).__confirmations[0])).toMatchObject({ buttons: ["Annuler", "Supprimer"], defaultId: 0, cancelId: 0 });
    await h.app.evaluate(({ dialog }) => { (dialog as any).showMessageBox = async () => ({ response: 1 }); });
    await settings.getByRole("button", { name: "Supprimer le compte…", exact: true }).click();
    await expect.poll(async () => (await state(h.app)).accounts.length).toBe(0);
    await expect(settings.getByText(/Aucun compte pour l’instant/)).toBeVisible();
  } finally { await h.close(); h.stopFake(); }
});

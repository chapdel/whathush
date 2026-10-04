import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { addAccountViaUi, command, launch, link, screenshot, state, waitForAccount } from "./harness";

const screens = path.resolve(import.meta.dirname, "../../test-results/screens");

async function shoot(page: Page, name: string): Promise<void> {
  fs.mkdirSync(screens, { recursive: true });
  await page.screenshot({ path: path.join(screens, `${name}.png`) });
}

test("paramètres : comptes, horaires, Focus, apparence (§15, §26, §30, §31)", async () => {
  const harness = await launch();
  const { app, shell } = harness;
  try {
    const personnel = await addAccountViaUi(harness, "Personnel");
    await link(harness, personnel, "Personnel");
    const travail = await addAccountViaUi(harness, "Travail");
    await link(harness, travail, "Travail");

    const settingsPromise = app.waitForEvent("window");
    await shell.getByRole("button", { name: "Paramètres" }).click();
    const settings = await settingsPromise;
    await settings.waitForLoadState("domcontentloaded");
    await settings.setViewportSize({ width: 1000, height: 720 });
    await expect(settings.getByRole("heading", { name: "Général" })).toBeVisible();
    await shoot(settings, "09-parametres-general");

    // Compte : aperçu masqué, icône, renommage.
    await settings.getByRole("button", { name: "Comptes" }).click();
    await settings.locator(".list-item", { hasText: "Travail" }).click();
    await settings.getByRole("switch", { name: "Aperçu du message" }).click();
    await settings.getByRole("radio", { name: "Travail", exact: true }).click();
    await expect.poll(async () => JSON.parse(fs.readFileSync(path.join(harness.userData, "accounts.json"), "utf8")).accounts[1]).toMatchObject({
      icon: "briefcase",
      notifications: { showPreview: false }
    });
    await shoot(settings, "10-parametres-compte");

    // Horaire depuis un modèle, puis association au compte.
    await settings.getByRole("button", { name: "Horaires" }).click();
    await settings.getByRole("button", { name: /Heures de bureau/ }).click();
    await expect(settings.locator(".list-item", { hasText: "Heures de bureau" })).toBeVisible();
    await shoot(settings, "11-parametres-horaires");
    const schedule = JSON.parse(fs.readFileSync(path.join(harness.userData, "schedules.json"), "utf8")).schedules[0];
    expect(schedule).toMatchObject({ name: "Heures de bureau", defaultMode: "snoozed" });
    await command(app, { type: "update-account", id: travail, patch: { scheduleId: schedule.id } });
    await waitForAccount(app, "Travail", (account) => account.policy.source === "schedule");

    // Focus.
    await settings.getByRole("button", { name: "Focus" }).click();
    await settings.getByRole("button", { name: "Nouveau Focus" }).click();
    await expect(settings.locator(".list-item", { hasText: "Focus 1" })).toBeVisible();
    await settings.getByRole("button", { name: "Activer maintenant" }).click();
    await expect.poll(async () => (await state(app)).focus.activeProfileId).not.toBeNull();
    await shoot(settings, "12-parametres-focus");
    await settings.getByRole("button", { name: "Désactiver" }).click();

    await settings.getByRole("button", { name: "À propos" }).click();
    await expect(settings.getByText("Projet indépendant, non affilié à WhatsApp LLC ni à Meta Platforms.")).toBeVisible();
    await shoot(settings, "13-parametres-a-propos");

    // Apparence : thème sombre et barre compacte, vus dans la fenêtre principale.
    // Playwright impose prefers-color-scheme: light aux pages qu'il pilote : on vérifie
    // le thème côté processus principal, puis on émule le mode sombre pour la capture.
    await command(app, { type: "set-preferences", patch: { theme: "dark" } });
    expect(await app.evaluate(({ nativeTheme }) => ({ source: nativeTheme.themeSource, dark: nativeTheme.shouldUseDarkColors }))).toEqual({
      source: "dark",
      dark: true
    });
    await command(app, { type: "switch-account", id: personnel });
    await shell.emulateMedia({ colorScheme: "dark" });
    await settings.emulateMedia({ colorScheme: "dark" });
    await shell.waitForTimeout(400);
    await screenshot(harness, "14-theme-sombre");
    await settings.getByRole("button", { name: "Horaires" }).click();
    await shoot(settings, "15-parametres-sombre");
    await command(app, { type: "set-preferences", patch: { sidebarCollapsed: true } });
    await shell.waitForTimeout(400);
    await screenshot(harness, "16-barre-compacte");
    expect(await app.evaluate(() => (globalThis as any).__whathush.viewBounds().x)).toBe(76);
  } finally {
    await harness.close();
    harness.stopFake();
  }
});

test("modale d'ajout : les vues WhatsApp sont masquées puis réaffichées (§29)", async () => {
  const harness = await launch();
  const { app, shell } = harness;
  try {
    const id = await addAccountViaUi(harness, "Personnel");
    await link(harness, id, "Personnel");
    const shown = () => app.evaluate(() => (globalThis as any).__whathush.viewsManager().shown());
    expect(await shown()).toBe(id);
    await shell.getByRole("button", { name: "Ajouter un compte" }).first().click();
    await expect(shell.getByRole("dialog", { name: "Ajouter un compte" })).toBeVisible();
    await expect.poll(shown).toBeNull();
    await shell.getByPlaceholder("Personnel, Travail, Support…").fill("Support");
    await screenshot(harness, "17-ajout-compte");
    await shell.keyboard.press("Escape");
    await expect.poll(shown).toBe(id);
  } finally {
    await harness.close();
    harness.stopFake();
  }
});

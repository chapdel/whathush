import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { addAccountViaUi, command, launch, link, screenshot, state, waitForAccount } from "./harness";

const screens = path.resolve(import.meta.dirname, "../../test-results/screens");

/** Textes visibles et attributs lisibles par un lecteur d'écran, hors noms de langue natifs. */
async function visibleTexts(page: Page): Promise<string> {
  return page.evaluate(() => {
    const clone = document.body.cloneNode(true) as HTMLElement;
    clone.querySelectorAll("[lang]:not([lang='en'])").forEach((element) => element.remove());
    const attributes = [...clone.querySelectorAll("[title],[aria-label],[placeholder]")].flatMap((element) =>
      ["title", "aria-label", "placeholder"].map((name) => element.getAttribute(name) ?? "")
    );
    return `${clone.innerText}\n${attributes.join("\n")}`;
  });
}

/** Repères d'un texte resté en français : accents, guillemets français, mots courants. */
function frenchLeftovers(text: string): string[] {
  const markers = [/[éèêàùçôîœ«»]/i, /\b(le|la|les|des|du|une|avec|pour|compte|comptes|paramètres|fermer|ajouter)\b/i];
  return text.split("\n").filter((line) => markers.some((marker) => marker.test(line)));
}

test("langue : interface entièrement en anglais, puis passage au français sans redémarrer", async () => {
  const h = await launch({ systemLanguage: "en" });
  const { app, shell } = h;
  try {
    await expect(shell.getByRole("heading", { name: "Connect WhatsApp" })).toBeVisible();
    expect(await shell.evaluate(() => document.documentElement.lang)).toBe("en-US");
    await shell.getByRole("button", { name: "Add my first account" }).click();
    await expect(shell.getByRole("dialog", { name: "Add account" })).toBeVisible();
    expect(frenchLeftovers(await visibleTexts(shell))).toEqual([]);
    await shell.getByPlaceholder("Personal, Work, Support…").fill("Work");
    await shell.getByRole("button", { name: "Add", exact: true }).click();
    const id = (await waitForAccount(app, "Work", (account) => account.lifecycle === "needs_qr")).id;
    await link(h, id, "Work");
    await expect(shell.locator('[data-account="Work"]')).toContainText("Connected");
    expect(frenchLeftovers(await visibleTexts(shell))).toEqual([]);
    await screenshot(h, "30-anglais-fenetre");

    const settingsPromise = app.waitForEvent("window");
    await shell.getByRole("button", { name: "Settings" }).click();
    const settings = await settingsPromise;
    await settings.setViewportSize({ width: 1000, height: 720 });
    await expect(settings.getByRole("heading", { name: "General" })).toBeVisible();
    fs.mkdirSync(screens, { recursive: true });
    const sections = ["General", "Appearance", "Accounts", "Schedules", "Focus", "Security", "Files and links", "Downloads", "Network", "About"];
    for (const section of sections) {
      await settings.getByRole("button", { name: section, exact: true }).click();
      await expect(settings.getByRole("heading", { name: section, exact: true })).toBeVisible();
      expect(frenchLeftovers(await visibleTexts(settings)), section).toEqual([]);
    }
    await settings.screenshot({ path: path.join(screens, "31-anglais-parametres.png") });

    // Passage au français : fenêtre principale, paramètres et menus suivent aussitôt.
    await settings.getByRole("button", { name: "General", exact: true }).click();
    await settings.getByRole("group", { name: "Interface language" }).getByRole("combobox").selectOption("fr");
    await expect(settings.getByRole("heading", { name: "Général" })).toBeVisible();
    await expect(shell.locator('[data-account="Work"]')).toContainText("Connecté");
    expect((await state(app)).language).toBe("fr");
    await expect.poll(() => settings.title()).toBe("Paramètres — WhatHush");
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((window) => window.getTitle()))).toContain("Paramètres — WhatHush");
    expect(JSON.parse(fs.readFileSync(path.join(h.userData, "preferences.json"), "utf8")).language).toBe("fr");
  } finally {
    await h.close();
    h.stopFake();
  }
});

test("langue : une installation neuve suit la langue du système, le français par défaut des tests", async () => {
  const h = await launch();
  try {
    await expect(h.shell.getByRole("heading", { name: "Connecter WhatsApp" })).toBeVisible();
    expect(await h.shell.evaluate(() => document.documentElement.lang)).toBe("fr-FR");
    await command(h.app, { type: "set-preferences", patch: { language: "en" } });
    await expect(h.shell.getByRole("heading", { name: "Connect WhatsApp" })).toBeVisible();
    const id = await (async () => {
      await h.shell.getByRole("button", { name: "Add my first account" }).click();
      await h.shell.getByPlaceholder("Personal, Work, Support…").fill("Personal");
      await h.shell.getByRole("button", { name: "Add", exact: true }).click();
      return (await waitForAccount(h.app, "Personal", (account) => account.lifecycle === "needs_qr")).id;
    })();
    await link(h, id, "Personal");
    // Les menus natifs (modèle du tray) suivent la langue.
    const labels = await h.app.evaluate(() =>
      (globalThis as any).__whathush.trayMenuModel().map((item: any) => (item.kind === "separator" ? "—" : item.label))
    );
    expect(labels.slice(-2)).toEqual(["Show", "Quit"]);
    expect(labels).toContain("Settings…");
    expect(labels).toContain("Create a diagnostic report");
    expect(labels.join("|")).not.toMatch(/Afficher|Paramètres|Quitter/);
  } finally {
    await h.close();
    h.stopFake();
  }
});

test("correcteur : dictionnaire français intégré chargé sans aucun téléchargement", async () => {
  const h = await launch();
  try {
    const id = await addAccountViaUi(h, "Personnel");
    await link(h, id, "Personnel");
    expect(await h.app.evaluate(({ session }) => session.fromPartition(`persist:wa-${(globalThis as any).__whathush.accounts.accounts()[0].id}`).getSpellCheckerLanguages())).toEqual(["fr"]);
    expect(fs.existsSync(path.join(h.userData, "Dictionaries", "fr-FR-3-0.bdic"))).toBe(true);
    await expect.poll(() => fs.readFileSync(path.join(h.userData, "logs", "app.log"), "utf8").includes('"spellcheck-ready"'), { timeout: 15_000 }).toBe(true);
    expect(fs.readFileSync(path.join(h.userData, "logs", "app.log"), "utf8")).not.toContain('"spellcheck-download"');
    // Désactivé : plus aucune langue.
    await command(h.app, { type: "set-preferences", patch: { spellcheckMode: "off" } });
    expect(await h.app.evaluate(({ session }) => session.fromPartition(`persist:wa-${(globalThis as any).__whathush.accounts.accounts()[0].id}`).isSpellCheckerEnabled())).toBe(false);
  } finally {
    await h.close();
    h.stopFake();
  }
});

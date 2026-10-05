import { expect, test } from "@playwright/test";
import { addAccountViaUi, command, launch, link, screenshot, state, waitForAccount } from "./harness";

test("paramètres : un rafraîchissement n'efface pas un horaire en cours d'édition (revue n°1)", async () => {
  const harness = await launch();
  const { app, shell } = harness;
  try {
    const id = await addAccountViaUi(harness, "Personnel");
    await link(harness, id, "Personnel");
    const settingsPromise = app.waitForEvent("window");
    await shell.getByRole("button", { name: "Paramètres" }).click();
    const settings = await settingsPromise;
    await settings.getByRole("button", { name: "Horaires" }).click();
    await settings.getByRole("button", { name: /Heures de bureau/ }).click();
    const name = settings.getByLabel("Nom");
    await name.fill("Horaire modifié, non enregistré");
    // Provoque plusieurs rafraîchissements de l'état des paramètres.
    await command(app, { type: "snooze", id, preset: { kind: "minutes", minutes: 30 } });
    await command(app, { type: "resume", id });
    await command(app, { type: "set-preferences", patch: { askDownloadLocation: true } });
    await settings.waitForTimeout(500);
    await expect(name).toHaveValue("Horaire modifié, non enregistré");
    await expect(settings.getByRole("button", { name: "Enregistrer" })).toBeEnabled();
  } finally {
    await harness.close();
    harness.stopFake();
  }
});

test("Snooze jusqu'à une date, glisser-déposer des comptes, action d'une notice", async () => {
  const harness = await launch();
  const { app, shell } = harness;
  try {
    const personnel = await addAccountViaUi(harness, "Personnel");
    await link(harness, personnel, "Personnel");
    const travail = await addAccountViaUi(harness, "Travail");
    await link(harness, travail, "Travail");

    // Snooze jusqu'à une date (menu du compte → fenêtre de choix).
    await app.evaluate((_electron, id) => (globalThis as any).__whathush.dispatchMenuAction({ type: "snooze-date", id }), travail);
    const dialog = shell.getByRole("dialog", { name: /Snooze de « Travail »/ });
    await expect(dialog).toBeVisible();
    await dialog.locator('input[type="datetime-local"]').fill("2099-01-15T09:30");
    await screenshot(harness, "18-snooze-date");
    await dialog.getByRole("button", { name: "Mettre en Snooze" }).click();
    const snoozed = await waitForAccount(app, "Travail", (account) => account.policy.mode === "snoozed");
    expect(new Date(snoozed.policy.until ?? "").getFullYear()).toBe(2099);
    await expect(shell.getByRole("dialog")).toHaveCount(0);

    // Glisser « Travail » au-dessus de « Personnel » : l'ordre (et Ctrl+1) change.
    await shell.locator('[data-account="Travail"]').dragTo(shell.locator('[data-account="Personnel"]'));
    await expect.poll(async () => (await state(app)).accounts.map((account) => account.label)).toEqual(["Travail", "Personnel"]);
    expect((await state(app)).accounts[0]?.shortcut).toBe(1);

    // Notice avec action (suggestion de mise en veille).
    await app.evaluate(
      (_electron, id) =>
        (globalThis as any).__whathush.addNotice({
          id: "ram-suggestion",
          level: "info",
          sticky: true,
          message: "L’application utilise 2,3 Go.",
          action: { label: "Mettre en veille", command: { type: "sleep-account", id } }
        }),
      personnel
    );
    await screenshot(harness, "19-suggestion-veille");
    await shell.getByRole("button", { name: "Mettre en veille" }).click();
    await waitForAccount(app, "Personnel", (account) => account.lifecycle === "sleeping");
    await expect(shell.locator(".notice", { hasText: "2,3 Go" })).toHaveCount(0);
  } finally {
    await harness.close();
    harness.stopFake();
  }
});

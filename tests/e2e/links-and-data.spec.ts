import { expect, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { addAccountViaUi, command, inView, launch, link, probe, screenshot, state, waitForAccount } from "./harness";

test("liens : navigateur système, schémas bloqués, choix du compte pour wa.me", async () => {
  const harness = await launch();
  const { app, shell } = harness;
  try {
    const personnel = await addAccountViaUi(harness, "Personnel");
    await link(harness, personnel, "Personnel");
    const travail = await addAccountViaUi(harness, "Travail");
    await link(harness, travail, "Travail");

    // Lien externe : navigateur système (enregistré en mode test), jamais dans la vue.
    await inView(app, travail, 'document.getElementById("external").click()');
    await expect.poll(async () => (await probe(app)).external).toContain("https://example.com/");

    // Schémas non autorisés : bloqués, rien n'est ouvert (cas détaillés en tests unitaires).
    const windowsBefore = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
    await inView(app, travail, 'window.open("smb://serveur/partage"); window.open("vscode://file/etc/passwd"); true');
    await shell.waitForTimeout(300);
    expect((await probe(app)).external).toEqual(["https://example.com/"]);
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(windowsBefore);

    // about:blank : refusé (on ne sait pas quelle frame l'ouvre).
    const before = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
    await inView(app, travail, 'window.open("about:blank"); true');
    await shell.waitForTimeout(300);
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(before);

    // Popup de la même origine : autorisée, avec le preload, rattachée au compte…
    await inView(app, travail, 'window.__popup = window.open("/popup", "_blank", "width=420,height=320"); true');
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(before + 1);
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().some((window) => window.webContents.getURL().endsWith("/popup") && !window.webContents.isLoading())
        )
      )
      .toBe(true);
    const popupNotify = (title: string) =>
      app.evaluate(async ({ BrowserWindow }, input) => {
        const popup = BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().endsWith("/popup"));
        if (!popup) throw new Error("popup introuvable");
        await popup.webContents.executeJavaScript(`new Notification(${JSON.stringify(input)}, { body: "depuis la popup" }); true`);
        return popup.webContents.id;
      }, title);
    const popupId = await popupNotify("Popup");
    await expect.poll(async () => (await probe(app)).notifications.map((n: { title: string }) => n.title)).toContain("Travail — Popup");
    expect((await probe(app)).notifications.at(-1)).toMatchObject({ accountId: travail, webContentsId: popupId });
    // … et soumise au Snooze du compte, comme la vue principale.
    await command(app, { type: "snooze", id: travail, preset: { kind: "minutes", minutes: 30 } });
    const count = (await probe(app)).notifications.length;
    await popupNotify("Popup en Snooze");
    await shell.waitForTimeout(400);
    expect((await probe(app)).notifications.length).toBe(count);
    await command(app, { type: "resume", id: travail });
    // … mais elle ne peut pas charger un site externe dans l'application.
    await inView(app, travail, 'window.__popup.location.href = "https://example.org/piege"; true');
    await expect.poll(async () => (await probe(app)).external).toContain("https://example.org/piege");
    expect(
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((window) => window.webContents.getURL().includes("example.org")))
    ).toBe(false);
    await app.evaluate(({ BrowserWindow }, origin) => {
      for (const window of BrowserWindow.getAllWindows()) if (window.webContents.getURL().startsWith(origin)) window.close();
    }, harness.fakeUrl);

    // wa.me avec deux comptes : la coque demande lequel utiliser.
    await inView(app, travail, 'document.getElementById("wame").click()');
    await expect(shell.getByRole("dialog", { name: "Ouvrir la conversation avec quel compte ?" })).toBeVisible();
    await expect(shell.getByText("Conversation avec le +33612345678")).toBeVisible();
    expect(await app.evaluate(() => (globalThis as any).__whathush.viewsManager().shown())).toBeNull();
    await screenshot(harness, "08-choix-du-compte");
    await shell.getByRole("dialog").getByRole("button", { name: /Personnel/ }).click();
    await expect.poll(() => inView(app, personnel, "location.href")).toContain("send?phone=33612345678");
    await expect.poll(async () => (await state(app)).activeId).toBe(personnel);
    // Revue n°3 : la fenêtre ne se rouvre pas et la vue WhatsApp redevient visible.
    await shell.waitForTimeout(500);
    await expect(shell.getByRole("dialog")).toHaveCount(0);
    expect(await app.evaluate(() => (globalThis as any).__whathush.viewsManager().shown())).toBe(personnel);
  } finally {
    await harness.close();
    harness.stopFake();
  }
});

test("téléchargements : dossier dédié, jamais d'écrasement", async () => {
  const harness = await launch();
  const { app } = harness;
  try {
    const id = await addAccountViaUi(harness, "Personnel");
    await link(harness, id, "Personnel");
    await inView(app, id, "fake.download()");
    await expect.poll(async () => (await probe(app)).downloads.length).toBe(1);
    await inView(app, id, "fake.download()");
    await expect.poll(async () => (await probe(app)).downloads.length).toBe(2);
    const files = (await probe(app)).downloads.map((download: { file: string; state: string }) => [path.basename(download.file), download.state]);
    expect(files).toEqual([
      ["rapport.txt", "completed"],
      ["rapport (1).txt", "completed"]
    ]);
    expect(fs.readFileSync(path.join(harness.userData, "downloads", "rapport.txt"), "utf8")).toBe("contenu de test\n");

    // Revue n°6 : deux téléchargements du même nom lancés ensemble ne s'écrasent pas.
    await inView(app, id, "fake.download(); fake.download(); true");
    await expect.poll(async () => (await probe(app)).downloads.length).toBe(4);
    const names = (await probe(app)).downloads.map((download: { file: string }) => path.basename(download.file));
    expect(new Set(names).size).toBe(4);
    expect(fs.readdirSync(path.join(harness.userData, "downloads")).sort()).toEqual(["rapport (1).txt", "rapport (2).txt", "rapport (3).txt", "rapport.txt"]);
  } finally {
    await harness.close();
    harness.stopFake();
  }
});

test("persistance : redémarrage sans QR, compte actif restauré, suppression purgée", async () => {
  let harness = await launch();
  const userData = harness.userData;
  const fakeUrl = harness.fakeUrl;
  const stopFake = harness.stopFake;
  let personnel: string;
  let travail: string;
  try {
    personnel = await addAccountViaUi(harness, "Personnel");
    await link(harness, personnel, "Personnel");
    travail = await addAccountViaUi(harness, "Travail");
    await link(harness, travail, "Travail");
    await command(harness.app, { type: "switch-account", id: personnel });
    await command(harness.app, { type: "snooze", id: travail, preset: { kind: "indefinitely" } });
    await command(harness.app, { type: "sleep-account", id: travail });
    await waitForAccount(harness.app, "Travail", (account) => account.lifecycle === "sleeping");
    await harness.close();

    harness = await launch({ userData, fakeUrl });
    const restored = await waitForAccount(harness.app, "Personnel", (account) => account.lifecycle === "ready");
    expect(restored.active).toBe(true);
    const sleeping = (await state(harness.app)).accounts.find((account) => account.id === travail);
    expect(sleeping).toMatchObject({ lifecycle: "sleeping", policy: { mode: "snoozed", source: "manual" } });

    // Suppression : session vidée, dossier de partition supprimé au démarrage suivant.
    const partition = path.join(userData, "Partitions", `wa-${personnel}`);
    expect(fs.existsSync(partition)).toBe(true);
    await command(harness.app, { type: "remove-account", id: personnel });
    await expect.poll(async () => (await state(harness.app)).accounts.length).toBe(1);
    const saved = JSON.parse(fs.readFileSync(path.join(userData, "accounts.json"), "utf8"));
    expect(saved.pendingPartitionDeletion).toEqual([personnel]);
    expect(fs.statSync(path.join(userData, "accounts.json")).mode & 0o777).toBe(0o600);
    expect(fs.statSync(userData).mode & 0o777).toBe(0o700);
    await harness.close();

    harness = await launch({ userData, fakeUrl });
    await expect.poll(() => fs.existsSync(partition)).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(userData, "accounts.json"), "utf8")).pendingPartitionDeletion).toEqual([]);
  } finally {
    await harness.close();
    stopFake();
  }
});

// Lot A du plan complémentaire : presse-papiers (F13), médias (F14), zoom et
// raccourcis (F1), téléchargements (F2), rapport de diagnostic (F3), thème (F11).
import { expect, test, type ElectronApplication } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { addAccountViaUi, command, inView, launch, link, pressShortcut, probe, screenshot, state, waitForAccount, type Harness } from "./harness";

const screens = path.resolve(import.meta.dirname, "../../test-results/screens");

let h: Harness & { stopFake(): void };
let personnel: string;
let travail: string;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  h = await launch();
  personnel = await addAccountViaUi(h, "Personnel");
  await link(h, personnel, "Personnel");
  travail = await addAccountViaUi(h, "Travail");
  await link(h, travail, "Travail");
});

test.afterAll(async () => {
  await h.close();
  h.stopFake();
});

async function viewZoom(app: ElectronApplication, id: string): Promise<number> {
  return app.evaluate((_electron, accountId) => (globalThis as any).__whathush.viewsManager().webContents(accountId).getZoomFactor(), id);
}

test("presse-papiers (F13) : texte, image collée, image copiée et collage en texte brut", async () => {
  const { app } = h;
  await command(app, { type: "switch-account", id: travail });
  await inView(app, travail, "fake.pastes = []; fake.focusComposer()");

  await app.evaluate(({ clipboard }) => clipboard.writeText("Bonjour depuis le presse-papiers"));
  await pressShortcut(app, travail, "V");
  await expect.poll(() => inView(app, travail, "fake.pastes.length")).toBe(1);
  expect(await inView(app, travail, "fake.pastes[0].text")).toBe("Bonjour depuis le presse-papiers");

  // Electron 44 : API du presse-papiers asynchrone, sur le modèle du W3C (ClipboardItem).
  await app.evaluate(async ({ clipboard, ClipboardItem, nativeImage }) => {
    const png = nativeImage.createFromBitmap(Buffer.alloc(8 * 8 * 4, 0x80), { width: 8, height: 8 }).toPNG();
    await clipboard.write([new ClipboardItem({ "image/png": new Blob([new Uint8Array(png)], { type: "image/png" }) })]);
  });
  await pressShortcut(app, travail, "V");
  await expect.poll(() => inView(app, travail, "fake.pastes.length")).toBe(2);
  expect(await inView(app, travail, "fake.pastes[1].files")).toEqual([expect.objectContaining({ type: "image/png" })]);

  // « Copier l'image » du menu contextuel : copyImageAt sur la photo de la conversation.
  await app.evaluate(({ clipboard }) => clipboard.clear());
  const point = await inView<{ x: number; y: number }>(app, travail, "(() => { const r = document.getElementById('photo').getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()");
  await app.evaluate((_electron, input) => (globalThis as any).__whathush.viewsManager().webContents(input.id).copyImageAt(input.x, input.y), { id: travail, ...point });
  await expect
    .poll(() =>
      app.evaluate(async ({ clipboard, nativeImage }) => {
        const item = (await clipboard.read()).find((entry) => entry.types.includes("image/png"));
        if (!item) return 0;
        const blob = await item.getType("image/png");
        return nativeImage.createFromBuffer(Buffer.from(await blob.arrayBuffer())).getSize().width;
      })
    )
    .toBe(120);

  // Ctrl+Maj+V : collage sans la mise en forme de la source.
  await inView(app, travail, "fake.focusComposer(); document.getElementById('composer').innerHTML = ''");
  await app.evaluate(({ clipboard, ClipboardItem }) => clipboard.write([new ClipboardItem({ "text/plain": "gras", "text/html": "<b>gras</b>" })]));
  await pressShortcut(app, travail, "V", ["control", "shift"]);
  await expect.poll(() => inView(app, travail, "fake.composerText()")).toBe("gras");
  expect(await inView(app, travail, "fake.composerHtml()")).not.toContain("<b>");
});

test("médias (F14) : indicateur, Pause et Reprendre, sons courts ignorés", async () => {
  const { app, shell } = h;
  await command(app, { type: "switch-account", id: personnel });
  // Un son de notification (court) ou une sonnerie (en boucle) n'est pas une lecture.
  await inView(app, personnel, "fake.play(1)");
  await inView(app, personnel, "fake.play(4, false, true).then(() => fake.audio.pause())");
  await shell.waitForTimeout(400);
  expect((await state(app)).nowPlaying).toBeNull();

  await inView(app, personnel, "fake.play(8)");
  await expect.poll(async () => (await state(app)).nowPlaying).toMatchObject({ accountId: personnel, label: "Personnel", playing: true, kind: "audio" });
  await expect(shell.getByRole("status", { name: /En cours de lecture — Personnel/ })).toBeVisible();
  await expect(shell.locator(".now-playing")).toContainText("Message vocal");
  await expect(shell.locator('[data-account="Personnel"] .account-status')).toHaveText("Lecture en cours");
  await screenshot(h, "32-lecture-en-cours");

  await shell.locator(".now-playing").getByRole("button", { name: "Pause" }).click();
  await expect.poll(() => inView(app, personnel, "fake.paused()")).toBe(true);
  await expect(shell.getByRole("status", { name: /En pause — Personnel/ })).toBeVisible();
  await shell.locator(".now-playing").getByRole("button", { name: "Reprendre" }).click();
  await expect.poll(() => inView(app, personnel, "fake.paused()")).toBe(false);

  // Bureau (MPRIS) : sans métadonnées de la page, « Message vocal — WhatHush ».
  expect(await inView(app, personnel, "JSON.stringify({ title: navigator.mediaSession.metadata?.title, artist: navigator.mediaSession.metadata?.artist })")).toBe(
    JSON.stringify({ title: "Message vocal", artist: "WhatHush" })
  );

  // Élément détaché du DOM (new Audio()) : suivi aussi.
  await inView(app, personnel, "fake.audio.pause()");
  await inView(app, travail, "fake.play(8, true)");
  await expect.poll(async () => (await state(app)).nowPlaying?.accountId).toBe(travail);
  await inView(app, travail, "fake.audio.pause()");
});

test("médias (F14) : le Snooze ne coupe pas un message vocal lancé avant de changer de compte", async () => {
  const { app } = h;
  const muted = (id: string) => app.evaluate((_electron, accountId) => (globalThis as any).__whathush.viewsManager().webContents(accountId).isAudioMuted(), id);
  await command(app, { type: "snooze", id: personnel, preset: { kind: "minutes", minutes: 60 } });
  await command(app, { type: "switch-account", id: personnel });
  await inView(app, personnel, "fake.play(10)");
  await expect.poll(async () => (await state(app)).nowPlaying?.playing).toBe(true);
  await command(app, { type: "switch-account", id: travail });
  await expect.poll(async () => (await state(app)).activeId).toBe(travail);
  await app.evaluate(() => new Promise((resolve) => setTimeout(resolve, 300)));
  expect(await muted(personnel)).toBe(false);
  // Sans lecture, le compte en Snooze caché a bien le son coupé (§12).
  await inView(app, personnel, "fake.audio.pause()");
  await expect.poll(() => muted(personnel)).toBe(true);
  await command(app, { type: "resume", id: personnel });
});

test("médias (F14) : « une seule lecture à la fois » met en pause l'autre compte", async () => {
  const { app } = h;
  await command(app, { type: "set-preferences", patch: { exclusivePlayback: true } });
  await command(app, { type: "switch-account", id: personnel });
  await inView(app, personnel, "fake.play(10)");
  await expect.poll(async () => (await state(app)).accounts.find((account) => account.id === personnel)?.playback?.playing).toBe(true);
  await command(app, { type: "switch-account", id: travail });
  await inView(app, travail, "fake.play(10)");
  await expect.poll(() => inView(app, personnel, "fake.paused()")).toBe(true);
  expect(await inView(app, travail, "fake.paused()")).toBe(false);
  await inView(app, travail, "fake.audio.pause()");
  await command(app, { type: "set-preferences", patch: { exclusivePlayback: false } });
});

test("zoom et raccourcis (F1) : Ctrl+ / Ctrl− / Ctrl+0 par compte, feuille des raccourcis, échelle", async () => {
  const { app, shell } = h;
  await command(app, { type: "switch-account", id: personnel });
  await pressShortcut(app, personnel, "=");
  await expect.poll(() => viewZoom(app, personnel)).toBeCloseTo(1.1, 5);
  await expect(shell.locator(".zoom-toast")).toHaveText("Zoom : 110 %");
  await pressShortcut(app, "shell", "=");
  await expect.poll(() => viewZoom(app, personnel)).toBeCloseTo(1.2, 5);
  expect(await viewZoom(app, travail)).toBeCloseTo(1, 5);
  expect(JSON.parse(fs.readFileSync(path.join(h.userData, "accounts.json"), "utf8")).accounts.find((account: any) => account.id === personnel).zoomPercent).toBe(120);
  await pressShortcut(app, personnel, "-");
  await expect.poll(() => viewZoom(app, personnel)).toBeCloseTo(1.1, 5);
  // AZERTY : Ctrl+à est Ctrl+0 (touche physique Digit0).
  await app.evaluate((_electron, id) => {
    const wc = (globalThis as any).__whathush.viewsManager().webContents(id);
    wc.sendInputEvent({ type: "keyDown", keyCode: "0", modifiers: ["control"] });
    wc.sendInputEvent({ type: "keyUp", keyCode: "0", modifiers: ["control"] });
  }, personnel);
  await expect.poll(() => viewZoom(app, personnel)).toBeCloseTo(1, 5);

  // Feuille des raccourcis : tous ceux de la table.
  await pressShortcut(app, personnel, "/");
  const dialog = shell.getByRole("dialog", { name: "Raccourcis clavier" });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator("dt")).toHaveCount(12);
  await expect(dialog).toContainText("Zoom avant sur le compte affiché");
  await expect(dialog).toContainText("Maj");
  await screenshot(h, "33-raccourcis");
  await shell.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  // Échelle de l'interface : la coque grandit, les vues WhatsApp se décalent d'autant.
  await command(app, { type: "set-preferences", patch: { interfaceScale: 120 } });
  await expect.poll(() => shell.evaluate(() => window.devicePixelRatio)).toBeCloseTo(1.2, 2);
  expect(await app.evaluate(() => (globalThis as any).__whathush.viewBounds().x)).toBe(Math.round(232 * 1.2));
  await screenshot(h, "34-echelle-120");
  await command(app, { type: "set-preferences", patch: { interfaceScale: 100 } });
  await expect.poll(() => app.evaluate(() => (globalThis as any).__whathush.viewBounds().x)).toBe(232);
});

test("téléchargements (F2) : historique, ouvrir, dossier, introuvable, effacer, sans historique", async () => {
  const { app, shell } = h;
  await command(app, { type: "switch-account", id: travail });
  await inView(app, travail, "fake.download('devis.pdf')");
  await inView(app, travail, "fake.download('photo.jpg')");
  await expect.poll(async () => (await probe(app)).downloads.filter((entry: any) => entry.state === "completed").length).toBe(2);
  const file = JSON.parse(fs.readFileSync(path.join(h.userData, "downloads.json"), "utf8"));
  expect(file.records.map((record: any) => record.fileName).sort()).toEqual(["devis.pdf", "photo.jpg"]);
  expect(fs.statSync(path.join(h.userData, "downloads.json")).mode & 0o777).toBe(0o600);

  const settingsPromise = app.waitForEvent("window");
  await command(app, { type: "open-settings", section: "downloads" });
  const settings = await settingsPromise;
  await settings.setViewportSize({ width: 1000, height: 720 });
  await expect(settings.getByRole("heading", { name: "Téléchargements" })).toBeVisible();
  const devis = settings.locator('[data-download="devis.pdf"]');
  await expect(devis).toContainText("Travail");
  await expect(devis).toContainText("Terminé");
  await devis.getByRole("button", { name: "Ouvrir" }).click();
  await devis.getByRole("button", { name: /Afficher dans le dossier/ }).click();
  await expect.poll(async () => (await probe(app)).opened.map((entry: any) => `${entry.action}:${path.basename(entry.file)}`)).toEqual(["open:devis.pdf", "show:devis.pdf"]);
  fs.mkdirSync(screens, { recursive: true });
  await settings.screenshot({ path: path.join(screens, "35-parametres-telechargements.png") });

  // Fichier déplacé : « Introuvable », plus de bouton Ouvrir.
  const downloads = await app.evaluate(({ app: electronApp }) => electronApp.getPath("downloads"));
  fs.rmSync(path.join(downloads, "photo.jpg"));
  await command(app, { type: "set-preferences", patch: { askDownloadLocation: false } });
  await expect(settings.locator('[data-download="photo.jpg"]')).toContainText("Introuvable");
  await expect(settings.locator('[data-download="photo.jpg"]').getByRole("button", { name: "Ouvrir" })).toHaveCount(0);

  await settings.getByRole("button", { name: "Effacer l’historique" }).click();
  await expect(settings.getByText("Aucun téléchargement pour l’instant.")).toBeVisible();

  // Sans historique : rien n'est écrit, même pendant un téléchargement.
  await settings.locator('select[name="downloads-retention"]').selectOption("0");
  await inView(app, travail, "fake.download('secret.txt')");
  await expect.poll(async () => (await probe(app)).downloads.length).toBe(3);
  expect(JSON.parse(fs.readFileSync(path.join(h.userData, "downloads.json"), "utf8")).records).toEqual([]);
  await settings.close();
  await expect(shell.locator(".downloads-indicator")).toHaveCount(0);
});

test("rapport de diagnostic (F3) : fichier caviardé, rien n'est envoyé, page des tickets", async () => {
  const { app } = h;
  await inView(app, travail, "fake.notify('Marie', 'Texte confidentiel de la notification', 'diag')");
  await expect.poll(async () => (await probe(app)).notifications.some((entry: any) => entry.body.includes("confidentiel"))).toBe(true);
  const settingsPromise = app.waitForEvent("window");
  await command(app, { type: "open-settings", section: "about" });
  const settings = await settingsPromise;
  await settings.getByRole("button", { name: "Créer un rapport de diagnostic" }).click();
  await expect.poll(async () => (await probe(app)).opened.filter((entry: any) => entry.file.includes("diagnostic")).length).toBe(1);
  const report = (await probe(app)).opened.find((entry: any) => entry.file.includes("diagnostic")).file as string;
  expect(path.basename(report)).toMatch(/^whathush-diagnostic-\d{8}-\d{6}\.txt$/);
  const content = fs.readFileSync(report, "utf8");
  expect(content).toContain("WhatHush diagnostic report");
  expect(content).toContain("Accounts (2)");
  expect(content).toContain("Account 1 : ready");
  expect(content).not.toMatch(/Personnel|Travail/);
  expect(content).not.toContain("confidentiel");
  expect(content).not.toContain(path.dirname(h.userData).startsWith("/home/") ? path.dirname(h.userData) : "/home/");
  expect(fs.statSync(report).mode & 0o777).toBe(0o600);
  await expect(settings.getByText(/Rapport de diagnostic créé/)).toBeVisible();

  await settings.getByRole("button", { name: "Signaler un problème" }).click();
  await expect.poll(async () => (await probe(app)).external.some((url: string) => url.startsWith("https://github.com/chapdel/whathush/issues/new?title="))).toBe(true);
  await settings.close();
});

test("thème (F11) : l'aide « Défaut du système » ne s'affiche qu'une fois par compte", async () => {
  const { app } = h;
  const accounts = JSON.parse(fs.readFileSync(path.join(h.userData, "accounts.json"), "utf8")).accounts;
  expect(accounts.every((account: any) => account.themeHintShown)).toBe(true);
  expect((await state(app)).notices.filter((notice) => notice.id === "theme-hint")).toHaveLength(1);
  await command(app, { type: "dismiss-notice", id: "theme-hint" });
  // Nouvelle liaison du même compte : pas de nouvelle aide.
  await inView(app, travail, "fake.logout()");
  await waitForAccount(app, "Travail", (account) => account.lifecycle === "needs_qr");
  await inView(app, travail, "fake.link()");
  await waitForAccount(app, "Travail", (account) => account.lifecycle === "ready");
  await app.evaluate(() => new Promise((resolve) => setTimeout(resolve, 300)));
  expect((await state(app)).notices.filter((notice) => notice.id === "theme-hint")).toHaveLength(0);
});

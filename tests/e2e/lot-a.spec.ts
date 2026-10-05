// Lot A du plan complémentaire : presse-papiers (F13), médias (F14), zoom et
// raccourcis (F1), téléchargements (F2), rapport de diagnostic (F3), thème (F11).
// Un lancement par test : aucun état partagé, un échec n'emporte pas les suivants.
import { expect, test, type ElectronApplication } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { addAccountViaUi, command, inView, launch, link, pressShortcut, probe, screenshot, state, waitForAccount, type Harness } from "./harness";

const screens = path.resolve(import.meta.dirname, "../../test-results/screens");

async function setup(labels: string[]): Promise<{ h: Harness & { stopFake(): void }; ids: string[] }> {
  const h = await launch();
  const ids: string[] = [];
  for (const label of labels) {
    const id = await addAccountViaUi(h, label);
    await link(h, id, label);
    ids.push(id);
  }
  return { h, ids };
}

async function viewZoom(app: ElectronApplication, id: string): Promise<number> {
  return app.evaluate((_electron, accountId) => (globalThis as any).__whathush.viewsManager().webContents(accountId).getZoomFactor(), id);
}

const accountsFile = (h: Harness) => JSON.parse(fs.readFileSync(path.join(h.userData, "accounts.json"), "utf8"));
/** Fichier pas encore écrit : historique vide (expect.poll ne réessaie pas sur une exception). */
const downloadsFile = (h: Harness) => {
  const file = path.join(h.userData, "downloads.json");
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { records: [] };
};

test("presse-papiers (F13) : texte, image collée, image copiée et collage en texte brut", async () => {
  const { h, ids } = await setup(["Travail"]);
  const { app } = h;
  const [travail] = ids as [string];
  try {
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

    // Image de la conversation copiée sous le pointeur (l'entrée du menu contextuel qui
    // déclenche cette action est vérifiée en test unitaire, services.test.ts).
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
  } finally {
    await h.close();
    h.stopFake();
  }
});

test("médias (F14) : indicateur, Pause et Reprendre, sons courts et sonneries ignorés", async () => {
  const { h, ids } = await setup(["Personnel", "Travail"]);
  const { app, shell } = h;
  const [personnel, travail] = ids as [string, string];
  try {
    await command(app, { type: "switch-account", id: personnel });
    // Un son de notification (court) et une sonnerie (en boucle) jouent sans être signalés.
    await inView(app, personnel, "fake.play(1)");
    await inView(app, personnel, "fake.play(4, false, true).then(() => fake.audio.pause())");
    // Barrière positive : la vraie lecture suivante est le premier et le seul rapport reçu.
    await inView(app, personnel, "fake.play(8)");
    await expect.poll(async () => (await state(app)).nowPlaying).toMatchObject({ accountId: personnel, label: "Personnel", playing: true, kind: "audio" });
    expect((await probe(app)).playbackReports).toBe(1);
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

    // Barre compacte : bouton Pause seul.
    await command(app, { type: "set-preferences", patch: { sidebarCollapsed: true } });
    await expect(shell.locator(".now-playing-compact")).toBeVisible();
    await screenshot(h, "32b-lecture-compacte");
  } finally {
    await h.close();
    h.stopFake();
  }
});

test("médias (F14) : le Snooze ne coupe pas un message vocal lancé avant de changer de compte", async () => {
  const { h, ids } = await setup(["Personnel", "Travail"]);
  const { app } = h;
  const [personnel, travail] = ids as [string, string];
  const muted = (id: string) => app.evaluate((_electron, accountId) => (globalThis as any).__whathush.viewsManager().webContents(accountId).isAudioMuted(), id);
  try {
    await command(app, { type: "snooze", id: personnel, preset: { kind: "minutes", minutes: 60 } });
    await command(app, { type: "switch-account", id: personnel });
    await inView(app, personnel, "fake.play(10)");
    await expect.poll(async () => (await state(app)).nowPlaying?.playing).toBe(true);
    await command(app, { type: "switch-account", id: travail });
    await expect.poll(async () => (await state(app)).activeId).toBe(travail);
    expect(await muted(personnel)).toBe(false);
    // Pause : sans lecture, le compte en Snooze caché a bien le son coupé (§12).
    await command(app, { type: "media-control", id: personnel, action: "pause" });
    await expect.poll(() => inView(app, personnel, "fake.paused()")).toBe(true);
    await expect.poll(() => muted(personnel)).toBe(true);
    // « Reprendre » depuis l'application : lecture de l'utilisateur, jamais coupée.
    await command(app, { type: "media-control", id: personnel, action: "play" });
    await expect.poll(() => inView(app, personnel, "fake.paused()")).toBe(false);
    await expect.poll(() => muted(personnel)).toBe(false);
  } finally {
    await h.close();
    h.stopFake();
  }
});

test("médias (F14) : « une seule lecture à la fois » met en pause l'autre compte", async () => {
  const { h, ids } = await setup(["Personnel", "Travail"]);
  const { app } = h;
  const [personnel, travail] = ids as [string, string];
  try {
    await command(app, { type: "set-preferences", patch: { exclusivePlayback: true } });
    await command(app, { type: "switch-account", id: personnel });
    await inView(app, personnel, "fake.play(10)");
    await expect.poll(async () => (await state(app)).accounts.find((account) => account.id === personnel)?.playback?.playing).toBe(true);
    await command(app, { type: "switch-account", id: travail });
    await inView(app, travail, "fake.play(10)");
    await expect.poll(() => inView(app, personnel, "fake.paused()")).toBe(true);
    expect(await inView(app, travail, "fake.paused()")).toBe(false);
  } finally {
    await h.close();
    h.stopFake();
  }
});

test("zoom et raccourcis (F1) : par compte, conservé à la recréation de la vue, Ctrl+molette, feuille, échelle", async () => {
  const { h, ids } = await setup(["Personnel", "Travail"]);
  const { app, shell } = h;
  const [personnel, travail] = ids as [string, string];
  try {
    await command(app, { type: "switch-account", id: personnel });
    await pressShortcut(app, personnel, "=");
    await expect.poll(() => viewZoom(app, personnel)).toBeCloseTo(1.1, 5);
    await expect(shell.locator(".zoom-toast")).toHaveText("Zoom : 110 %");
    await pressShortcut(app, "shell", "=");
    await expect.poll(() => viewZoom(app, personnel)).toBeCloseTo(1.2, 5);
    expect(await viewZoom(app, travail)).toBeCloseTo(1, 5);
    expect(accountsFile(h).accounts.find((account: any) => account.id === personnel).zoomPercent).toBe(120);

    // Vue détruite puis recréée (veille, réveil) : le zoom enregistré est réappliqué.
    await command(app, { type: "sleep-account", id: personnel });
    await waitForAccount(app, "Personnel", (account) => account.lifecycle === "sleeping");
    await command(app, { type: "wake-account", id: personnel });
    await waitForAccount(app, "Personnel", (account) => account.lifecycle === "ready");
    expect(await viewZoom(app, personnel)).toBeCloseTo(1.2, 5);

    // Ctrl+molette : Electron le signale, l'application zoome.
    await app.evaluate((_electron, id) => (globalThis as any).__whathush.viewsManager().webContents(id).emit("zoom-changed", {}, "out"), personnel);
    await expect.poll(() => viewZoom(app, personnel)).toBeCloseTo(1.1, 5);
    await pressShortcut(app, personnel, "0");
    await expect.poll(() => viewZoom(app, personnel)).toBeCloseTo(1, 5);

    // Feuille des raccourcis : toute la table, y compris en barre compacte (touches visibles).
    await command(app, { type: "set-preferences", patch: { sidebarCollapsed: true } });
    await pressShortcut(app, personnel, "/");
    const dialog = shell.getByRole("dialog", { name: "Raccourcis clavier" });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator("dt")).toHaveCount(12);
    await expect(dialog).toContainText("Zoom avant sur le compte affiché");
    await expect(dialog.locator("kbd").first()).toBeVisible();
    await expect(dialog.locator("kbd", { hasText: "Maj" }).first()).toBeVisible();
    await screenshot(h, "33-raccourcis-compact");
    await shell.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await command(app, { type: "set-preferences", patch: { sidebarCollapsed: false } });

    // Échelle de l'interface : la coque grandit, les vues WhatsApp se décalent d'autant.
    await command(app, { type: "set-preferences", patch: { interfaceScale: 120 } });
    await expect.poll(() => shell.evaluate(() => window.devicePixelRatio)).toBeCloseTo(1.2, 2);
    expect(await app.evaluate(() => (globalThis as any).__whathush.viewBounds().x)).toBe(Math.round(232 * 1.2));
    await screenshot(h, "34-echelle-120");
  } finally {
    await h.close();
    h.stopFake();
  }
});

test("téléchargements (F2) : en cours visible, historique, ouvrir, dossier, introuvable, effacer, sans historique", async () => {
  const { h, ids } = await setup(["Travail"]);
  const { app, shell } = h;
  const [travail] = ids as [string];
  try {
    // Pendant le téléchargement : indicateur et entrée « en cours » dans l'historique.
    await inView(app, travail, "fake.downloadSlow('long.bin', 2500)");
    await expect(shell.locator(".downloads-indicator")).toBeVisible();
    await expect(shell.locator(".downloads-indicator")).toContainText("1 téléchargement en cours");
    await expect.poll(() => downloadsFile(h).records.map((record: any) => `${record.fileName}:${record.state}`)).toEqual(["long.bin:progressing"]);
    await screenshot(h, "35a-telechargement-en-cours");
    await expect.poll(() => downloadsFile(h).records[0]?.state, { timeout: 15_000 }).toBe("completed");
    await expect(shell.locator(".downloads-indicator")).toHaveCount(0);

    await inView(app, travail, "fake.download('devis.pdf')");
    await inView(app, travail, "fake.download('photo.jpg')");
    await expect.poll(async () => (await probe(app)).downloads.filter((entry: any) => entry.state === "completed").length).toBe(3);
    expect(downloadsFile(h).records.map((record: any) => record.fileName).sort()).toEqual(["devis.pdf", "long.bin", "photo.jpg"]);
    expect(fs.statSync(path.join(h.userData, "downloads.json")).mode & 0o777).toBe(0o600);

    const settingsPromise = app.waitForEvent("window");
    await command(app, { type: "open-settings", section: "downloads" });
    const settings = await settingsPromise;
    await settings.setViewportSize({ width: 1000, height: 720 });
    await expect(settings.getByRole("heading", { name: "Téléchargements" })).toBeVisible();
    const devis = settings.locator('[data-download="devis.pdf"]');
    await expect(devis).toContainText("Travail");
    await expect(devis).toContainText("Terminé");
    await devis.getByRole("button", { name: "Ouvrir : devis.pdf" }).click();
    await devis.getByRole("button", { name: /Afficher dans le dossier/ }).click();
    await expect.poll(async () => (await probe(app)).opened.map((entry: any) => `${entry.action}:${path.basename(entry.file)}`)).toEqual(["open:devis.pdf", "show:devis.pdf"]);
    fs.mkdirSync(screens, { recursive: true });
    await settings.screenshot({ path: path.join(screens, "35-parametres-telechargements.png") });

    // Fichier déplacé : « Introuvable » au retour sur la fenêtre, plus de bouton Ouvrir.
    const downloads = await app.evaluate(({ app: electronApp }) => electronApp.getPath("downloads"));
    fs.rmSync(path.join(downloads, "photo.jpg"));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().endsWith("settings.html"))!.emit("focus"));
    await expect(settings.locator('[data-download="photo.jpg"]')).toContainText("Introuvable");
    await expect(settings.locator('[data-download="photo.jpg"]').getByRole("button", { name: /^Ouvrir/ })).toHaveCount(0);

    await settings.getByRole("button", { name: "Effacer l’historique" }).click();
    await expect(settings.getByText("Aucun téléchargement pour l’instant.")).toBeVisible();

    // Sans historique : rien n'est écrit, même pendant un téléchargement.
    await settings.locator('select[name="downloads-retention"]').selectOption("0");
    await expect.poll(() => JSON.parse(fs.readFileSync(path.join(h.userData, "preferences.json"), "utf8")).downloadsHistoryDays).toBe(0);
    await inView(app, travail, "fake.downloadSlow('secret.bin', 2000)");
    await expect(shell.locator(".downloads-indicator")).toBeVisible();
    expect(downloadsFile(h).records).toEqual([]);
    await expect(settings.locator('[data-download="secret.bin"]')).toContainText("En cours");
    await expect(shell.locator(".downloads-indicator")).toHaveCount(0, { timeout: 15_000 });
    expect(downloadsFile(h).records).toEqual([]);
    await settings.close();
  } finally {
    await h.close();
    h.stopFake();
  }
});

test("rapport de diagnostic (F3) : fichier créé sans données de compte, rien n'est envoyé, page des tickets", async () => {
  const { h, ids } = await setup(["Personnel", "Travail"]);
  const { app } = h;
  const [, travail] = ids as [string, string];
  try {
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
    expect(fs.statSync(report).mode & 0o777).toBe(0o600);
    await expect(settings.getByText(/Rapport de diagnostic créé/)).toBeVisible();

    await settings.getByRole("button", { name: "Signaler un problème" }).click();
    await expect.poll(async () => (await probe(app)).external.some((url: string) => url.startsWith("https://github.com/chapdel/whathush/issues/new?title="))).toBe(true);
    await settings.close();
  } finally {
    await h.close();
    h.stopFake();
  }
});

test("thème (F11) : l'aide « Défaut du système » ne s'affiche qu'une fois par compte", async () => {
  const { h, ids } = await setup(["Personnel", "Travail"]);
  const { app } = h;
  const [, travail] = ids as [string, string];
  try {
    expect(accountsFile(h).accounts.every((account: any) => account.themeHintShown)).toBe(true);
    expect((await state(app)).notices.filter((notice) => notice.id === "theme-hint")).toHaveLength(1);
    await command(app, { type: "dismiss-notice", id: "theme-hint" });
    // Nouvelle liaison du même compte : pas de nouvelle aide.
    await inView(app, travail, "fake.logout()");
    await waitForAccount(app, "Travail", (account) => account.lifecycle === "needs_qr");
    await inView(app, travail, "fake.link()");
    await waitForAccount(app, "Travail", (account) => account.lifecycle === "ready");
    // Barrière positive : une information ajoutée après la liaison arrive bien ; l'aide du
    // thème n'est pas revenue (seul l'avertissement de déconnexion simulée l'accompagne).
    await app.evaluate(() => (globalThis as any).__whathush.addNotice({ id: "marqueur", level: "info", sticky: true, message: "marqueur" }));
    await expect.poll(async () => (await state(app)).notices.map((notice) => notice.id)).toEqual([`logout-${travail}`, "marqueur"]);
  } finally {
    await h.close();
    h.stopFake();
  }
});

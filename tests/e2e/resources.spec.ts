// Économies de ressources : WhatsApp masqué quand personne ne regarde (fenêtre non
// présentée, absence), mode économie (relèves), recyclage, état poussé seulement s'il
// change, correcteur sans dictionnaire, réglages.
// La visibilité réelle des pages (document.visibilityState, faussée par Playwright) est
// vérifiée par tests/native ; ici, la vue affichée par le ViewManager.
// Un lancement par test : aucun état partagé, un échec n'emporte pas les suivants.
import { expect, test, type ElectronApplication } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { addAccountViaUi, command, inView, launch, link, probe, screenshot, state, waitForAccount, type Harness } from "./harness";

type Launched = Harness & { stopFake(): void };

/** Délais raccourcis (mode économie, recyclage, mesures, présence). */
const TIMINGS = {
  economy: { dozeAfterHiddenMs: 1500, relaySettleMs: 1500, relayQuietMs: 500, relayMaxMs: 20_000, trayAfterMs: 1500 },
  economyTickMs: 300,
  economyIntervalMs: 2500,
  presencePollMs: { present: 300, away: 200 }
};

async function setup(labels: string[], timings: object = TIMINGS): Promise<{ h: Launched; ids: string[] }> {
  const h = await launch({ env: { WHATHUSH_TEST_TIMINGS: JSON.stringify(timings) } });
  const ids: string[] = [];
  for (const label of labels) {
    const id = await addAccountViaUi(h, label);
    await link(h, id, label);
    ids.push(id);
  }
  return { h, ids };
}

const shown = (app: ElectronApplication) => app.evaluate(() => (globalThis as any).__whathush.viewsManager().shown());
const hasView = (app: ElectronApplication, id: string) => app.evaluate((_electron, accountId) => (globalThis as any).__whathush.viewsManager().has(accountId), id);
const logText = (h: Harness) => fs.readFileSync(path.join(h.userData, "logs", "app.log"), "utf8");
const accountsFile = (h: Harness) => JSON.parse(fs.readFileSync(path.join(h.userData, "accounts.json"), "utf8"));

test("fenêtre non présentée (réduite sous Wayland) : WhatsApp masqué, verrou « fenêtre masquée » après 10 s", async () => {
  const { h, ids } = await setup(["Personnel"]);
  const [id] = ids as [string];
  try {
    await command(h.app, { type: "set-lock-code", current: null, next: "2468" });
    await command(h.app, { type: "set-lock-options", options: { onHide: true } });
    expect(await shown(h.app)).toBe(id);
    // Ce que la sonde d'images de la coque envoie quand le compositeur cesse d'afficher la fenêtre.
    await h.shell.evaluate(() => (window as any).whathush.command({ type: "presentation", presented: false }));
    await expect.poll(() => shown(h.app)).toBeNull();
    expect((await state(h.app)).lock.locked).toBe(false);
    await expect.poll(async () => (await state(h.app)).lock.locked, { timeout: 15_000 }).toBe(true);

    await h.shell.evaluate(() => (window as any).whathush.command({ type: "presentation", presented: true }));
    await command(h.app, { type: "unlock", code: "2468" });
    await expect.poll(() => shown(h.app)).toBe(id);

    // Fenêtre de retour avant le délai : pas de verrou.
    await h.shell.evaluate(() => (window as any).whathush.command({ type: "presentation", presented: false }));
    await expect.poll(() => shown(h.app)).toBeNull();
    await h.shell.evaluate(() => (window as any).whathush.command({ type: "presentation", presented: true }));
    await expect.poll(() => shown(h.app)).toBe(id);
    await new Promise((resolve) => setTimeout(resolve, 11_000));
    expect((await state(h.app)).lock.locked).toBe(false);
  } finally {
    await h.close();
    h.stopFake();
  }
});

test("sonde de présentation : seulement avec une page WhatsApp au premier plan ou le verrou au masquage", async () => {
  const { h } = await setup([]);
  try {
    const probing = async () => (await state(h.app)).probePresentation;
    // Aucun compte : rien à surveiller (chaque image demandée réveillerait le processus graphique).
    expect(await probing()).toBe(false);
    const id = await addAccountViaUi(h, "Personnel");
    await link(h, id, "Personnel");
    await expect.poll(probing).toBe(true);
    // Compte affiché endormi : pas de page.
    await command(h.app, { type: "sleep-account", id });
    await expect.poll(probing).toBe(false);
    // Le verrou doit suivre la fenêtre : la sonde reprend, même sans page.
    await command(h.app, { type: "set-lock-code", current: null, next: "2468" });
    await command(h.app, { type: "set-lock-options", options: { onHide: true } });
    await expect.poll(probing).toBe(true);
    // Verrouillé : plus rien à protéger.
    await command(h.app, { type: "lock-now" });
    await expect.poll(probing).toBe(false);
  } finally {
    await h.close();
    h.stopFake();
  }
});

test("absence : WhatsApp masqué après l'inactivité choisie, réaffiché au premier geste", async () => {
  const { h, ids } = await setup(["Personnel"]);
  const [id] = ids as [string];
  try {
    expect((await command(h.app, { type: "set-preferences", patch: { awayHideMinutes: 2 } }), await shown(h.app))).toBe(id);
    await h.app.evaluate(() => ((globalThis as any).__whathush.probe.idleSeconds = 119));
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(await shown(h.app)).toBe(id);
    await h.app.evaluate(() => ((globalThis as any).__whathush.probe.idleSeconds = 121));
    await expect.poll(() => shown(h.app)).toBeNull();
    // Masqué, le compte notifie toujours.
    await inView(h.app, id, "fake.notify('Marie', 'Tu es là ?', 'chat-marie')");
    await expect.poll(async () => (await probe(h.app)).notifications.length).toBe(1);
    await h.app.evaluate(() => ((globalThis as any).__whathush.probe.idleSeconds = 0));
    await expect.poll(() => shown(h.app)).toBe(id);
    expect(logText(h)).toContain('"user-away"');
    expect(logText(h)).toContain('"user-back"');

    // « Jamais » : plus aucun masquage.
    await command(h.app, { type: "set-preferences", patch: { awayHideMinutes: 0 } });
    await h.app.evaluate(() => ((globalThis as any).__whathush.probe.idleSeconds = 9999));
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(await shown(h.app)).toBe(id);
  } finally {
    await h.close();
    h.stopFake();
  }
});

test("absence pendant une lecture : le compte affiché reste visible, masqué une fois la lecture en pause", async () => {
  const { h, ids } = await setup(["Personnel"]);
  const [id] = ids as [string];
  try {
    await command(h.app, { type: "set-preferences", patch: { awayHideMinutes: 2 } });
    await inView(h.app, id, "fake.play(60)");
    await expect.poll(async () => (await state(h.app)).accounts.find((account) => account.id === id)?.playback?.playing).toBe(true);
    // Une vidéo regardée sans toucher au clavier n'est pas une absence.
    await h.app.evaluate(() => ((globalThis as any).__whathush.probe.idleSeconds = 600));
    await expect.poll(() => logText(h)).toContain('"user-away"');
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(await shown(h.app)).toBe(id);
    await inView(h.app, id, "fake.audio.pause()");
    await expect.poll(() => shown(h.app)).toBeNull();
  } finally {
    await h.close();
    h.stopFake();
  }
});

test("mode économie : le compte caché s'endort, relève en arrière-plan, synthèse des non-lus sans notification", async () => {
  const { h, ids } = await setup(["Personnel", "Travail"]);
  const [personnel, travail] = ids as [string, string];
  try {
    await command(h.app, { type: "switch-account", id: personnel });
    await inView(h.app, travail, "fake.setUnread(1)");
    await command(h.app, { type: "update-account", id: travail, patch: { delivery: "periodic" } });
    expect(accountsFile(h).accounts.find((account: any) => account.id === travail).delivery).toBe("periodic");

    // Caché : endormi (page et service worker libérés), non-lus conservés, rien d'écrit.
    await expect.poll(() => hasView(h.app, travail)).toBe(false);
    const dozing = await waitForAccount(h.app, "Travail", (account) => account.economy?.dozing === true);
    expect(dozing).toMatchObject({ lifecycle: "sleeping", unread: 1 });
    expect(accountsFile(h).accounts.find((account: any) => account.id === travail).sleeping).toBe(false);
    await expect(h.shell.locator(".account", { hasText: "Travail" }).locator(".account-status")).toContainText(/Relève à/);
    await screenshot(h, "economie-sidebar");

    // Relève : la page revient (cachée), la fausse page affiche 3 non-lus sans notifier.
    await expect.poll(() => hasView(h.app, travail), { timeout: 10_000 }).toBe(true);
    expect(await shown(h.app)).toBe(personnel);
    await expect.poll(() => hasView(h.app, travail), { timeout: 15_000 }).toBe(false);
    const digest = (await probe(h.app)).notifications.find((notification: any) => notification.accountId === travail);
    expect(digest).toMatchObject({ title: "Travail", body: "Nouveaux messages · 3 non lus" });

    // Affiché : réveillé tout de suite, et plus jamais endormi tant qu'il l'est.
    await command(h.app, { type: "switch-account", id: travail });
    await expect.poll(() => shown(h.app)).toBe(travail);
    await new Promise((resolve) => setTimeout(resolve, 4000));
    expect(await shown(h.app)).toBe(travail);

    // Repassé en continu : le compte caché reste chargé.
    await command(h.app, { type: "update-account", id: travail, patch: { delivery: "realtime" } });
    await command(h.app, { type: "switch-account", id: personnel });
    await new Promise((resolve) => setTimeout(resolve, 4000));
    expect(await hasView(h.app, travail)).toBe(true);
  } finally {
    await h.close();
    h.stopFake();
  }
});

test("économie maximale dans la barre système : tous les comptes dorment, la fenêtre affichée les réveille", async () => {
  const { h, ids } = await setup(["Personnel", "Travail"]);
  const [personnel, travail] = ids as [string, string];
  try {
    await command(h.app, { type: "switch-account", id: personnel });
    await command(h.app, { type: "set-preferences", patch: { economy: { inTray: true } } });
    await h.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.hide());
    await expect.poll(async () => [await hasView(h.app, personnel), await hasView(h.app, travail)], { timeout: 10_000 }).toEqual([false, false]);
    await h.app.evaluate(() => (globalThis as any).__whathush.showMainWindow());
    await expect.poll(() => shown(h.app), { timeout: 10_000 }).toBe(personnel);
    await expect.poll(() => hasView(h.app, travail), { timeout: 10_000 }).toBe(true);
  } finally {
    await h.close();
    h.stopFake();
  }
});

test("recyclage : une page cachée qui a gonflé est recréée pendant une absence", async () => {
  // Utilisateur présent : jamais avant 10 min cachée ; absent : dès 0,5 s.
  const timings = { ...TIMINGS, monitorMs: { normal: 400, settings: 400 }, recycle: { minMB: 1, growthFactor: 0, hiddenMs: 500, longHiddenMs: 600_000, everyMs: 600_000, baselineAfterMs: 300 } };
  const { h, ids } = await setup(["Personnel", "Travail"], timings);
  const [personnel, travail] = ids as [string, string];
  try {
    await command(h.app, { type: "switch-account", id: personnel });
    const page = () => h.app.evaluate((_electron, accountId) => (globalThis as any).__whathush.viewsManager().webContents(accountId)?.id ?? null, travail);
    const before = await page();
    await h.app.evaluate(() => ((globalThis as any).__whathush.probe.idleSeconds = 9999));
    await expect.poll(() => logText(h).includes('"account-recycled"'), { timeout: 15_000 }).toBe(true);
    await expect.poll(page).not.toBe(before);
    await waitForAccount(h.app, "Travail", (account) => account.lifecycle === "ready");
    // Le compte affiché n'est jamais recyclé.
    expect(logText(h)).not.toContain(`"recycle","data":{"id":"${personnel}"`);
  } finally {
    await h.close();
    h.stopFake();
  }
});

test("au repos, l'état n'est renvoyé à la coque que s'il change", async () => {
  const { h } = await setup(["Personnel", "Travail"], { ...TIMINGS, monitorMs: { normal: 300, settings: 300 } });
  try {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    await h.app.evaluate(({ BrowserWindow }) => {
      const contents = BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().startsWith("app://renderer/index.html"))!.webContents;
      const original = contents.send.bind(contents);
      (globalThis as any).__sent = 0;
      contents.send = (channel: string, ...args: unknown[]) => {
        if (channel === "shell:state") (globalThis as any).__sent += 1;
        return original(channel, ...args);
      };
    });
    // Mesures toutes les 300 ms : la mémoire change, la coque ne l'affiche pas.
    await new Promise((resolve) => setTimeout(resolve, 5000));
    expect(await h.app.evaluate(() => (globalThis as any).__sent)).toBe(0);
    // Un vrai changement arrive bien.
    await command(h.app, { type: "toggle-veil" });
    await expect.poll(() => h.app.evaluate(() => (globalThis as any).__sent)).toBe(1);
  } finally {
    await h.close();
    h.stopFake();
  }
});

test("titre de la fenêtre : le nombre de non-lus survit à un rechargement de la coque", async () => {
  const { h, ids } = await setup(["Personnel"]);
  const [id] = ids as [string];
  try {
    const title = () => h.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().startsWith("app://renderer/index.html"))?.getTitle());
    await inView(h.app, id, "document.getElementById('unread').click()");
    const unread = async () => (await state(h.app)).accounts.find((account) => account.id === id)?.unread ?? 0;
    await expect.poll(unread).toBeGreaterThan(0);
    const expected = `(${await unread()}) WhatHush`;
    await expect.poll(title).toBe(expected);
    // Coque rechargée (après un plantage, par exemple) : le compte reste dans le titre.
    await h.shell.reload();
    await expect.poll(title).toBe(expected);
  } finally {
    await h.close();
    h.stopFake();
  }
});

test("correcteur désactivé : aucun dictionnaire chargé pour un nouveau compte", async () => {
  const h = await launch();
  try {
    await command(h.app, { type: "set-preferences", patch: { spellcheckMode: "off" } });
    const id = await addAccountViaUi(h, "Personnel");
    await link(h, id, "Personnel");
    await new Promise((resolve) => setTimeout(resolve, 2000));
    expect(logText(h)).not.toContain('"spellcheck-ready"');
    // Réactivé : le dictionnaire se charge sans recharger la page.
    await command(h.app, { type: "set-preferences", patch: { spellcheckMode: "system" } });
    await expect.poll(() => logText(h).includes('"spellcheck-ready"'), { timeout: 15_000 }).toBe(true);
  } finally {
    await h.close();
    h.stopFake();
  }
});

test("paramètres : économie d'énergie et réception des messages", async () => {
  const { h, ids } = await setup(["Personnel"]);
  const [id] = ids as [string];
  try {
    const settingsPromise = h.app.waitForEvent("window");
    await command(h.app, { type: "open-settings", accountId: id });
    const settings = await settingsPromise;
    await settings.waitForURL("**/settings.html");
    await settings.getByRole("radio", { name: "Mode économie" }).click();
    await expect.poll(() => accountsFile(h).accounts[0].delivery).toBe("periodic");
    await expect(settings.getByText(/relève ses messages toutes les 30 min/)).toBeVisible();
    await settings.screenshot({ path: path.resolve("test-results/screens/parametres-reception.png") });

    await settings.getByRole("button", { name: "Général" }).click();
    await expect(settings.getByText("Économie d’énergie")).toBeVisible();
    await settings.locator("select[name=away-hide]").selectOption("15");
    await settings.locator("select[name=economy-interval]").selectOption("60");
    await expect.poll(() => JSON.parse(fs.readFileSync(path.join(h.userData, "preferences.json"), "utf8"))).toMatchObject({ awayHideMinutes: 15, economy: { intervalMinutes: 60 } });
    await settings.screenshot({ path: path.resolve("test-results/screens/parametres-energie.png") });
  } finally {
    await h.close();
    h.stopFake();
  }
});

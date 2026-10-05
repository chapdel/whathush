import { expect, test } from "@playwright/test";
import { addAccountViaUi, command, inView, launch, link, pressShortcut, probe, screenshot, state, waitForAccount, type Harness } from "./harness";

let harness: Harness & { stopFake(): void };
let personnel: string;
let travail: string;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  harness = await launch();
  personnel = await addAccountViaUi(harness, "Personnel");
  await link(harness, personnel, "Personnel");
  travail = await addAccountViaUi(harness, "Travail");
  await link(harness, travail, "Travail");
});

test.afterAll(async () => {
  await harness.close();
  harness.stopFake();
});

const accountRow = (label: string) => harness.shell.locator(`[data-account="${label}"]`);

test("deux comptes isolés, non-lus et bascule", async () => {
  const { app } = harness;
  await expect(accountRow("Personnel").locator(".badge").first()).toHaveText("3");

  // Stockage isolé : chaque partition a son propre localStorage.
  const idPersonnel = await inView<string>(app, personnel, "fake.pageId()");
  const idTravail = await inView<string>(app, travail, "fake.pageId()");
  expect(idPersonnel).not.toBe(idTravail);

  // Raccourcis depuis la coque, puis depuis la vue WhatsApp qui a le focus (cas réel).
  await pressShortcut(app, "shell", "1");
  await expect.poll(async () => (await state(app)).activeId).toBe(personnel);
  await pressShortcut(app, personnel, "Tab");
  await expect.poll(async () => (await state(app)).activeId).toBe(travail);
  await pressShortcut(app, travail, "Tab", ["control", "shift"]);
  await expect.poll(async () => (await state(app)).activeId).toBe(personnel);
  await pressShortcut(app, personnel, "2");
  await expect.poll(async () => (await state(app)).activeId).toBe(travail);

  await accountRow("Personnel").click();
  await expect.poll(async () => (await state(app)).activeId).toBe(personnel);
  // Seule la vue du compte affiché est visible. La règle « page hidden » est
  // vérifiée par tests/native (Playwright émule le focus et fausse visibilityState).
  expect(await app.evaluate(() => (globalThis as any).__whathush.viewsManager().shown())).toBe(personnel);

  await expect.poll(async () => (await state(app)).totalUnread).toBe(6);
  await screenshot(harness, "03-deux-comptes");
});

test("notifications : interception, préfixe du compte et clic", async () => {
  const { app } = harness;
  await inView(app, travail, 'fake.notify("Marie", "On se voit demain ?", "chat-marie")');
  await expect.poll(async () => (await probe(app)).notifications.length).toBe(1);
  const [shown] = (await probe(app)).notifications;
  expect(shown).toMatchObject({ accountId: travail, title: "Travail — Marie", body: "On se voit demain ?", isCall: false });

  // Clic : le bon compte est affiché et la page reçoit le clic (elle remet ses non-lus à zéro).
  await app.evaluate(
    (_electron, { id, webContentsId, notificationId }) => (globalThis as any).__whathush.openFromNotification(id, webContentsId, notificationId),
    { id: travail, webContentsId: shown.webContentsId, notificationId: shown.id }
  );
  await expect.poll(async () => (await state(app)).activeId).toBe(travail);
  await expect.poll(() => inView(app, travail, "fake.clicks.join()")).toBe("chat-marie");
  await waitForAccount(app, "Travail", (account) => account.unread === 0);
});

test("Snooze manuel : plus de notification, état affiché", async () => {
  const { app } = harness;
  const before = (await probe(app)).notifications.length;
  await command(app, { type: "snooze", id: travail, preset: { kind: "minutes", minutes: 30 } });
  await waitForAccount(app, "Travail", (account) => account.policy.mode === "snoozed" && account.policy.source === "manual");
  await inView(app, travail, 'fake.notify("Marie", "Encore un message", "chat-marie")');
  await harness.shell.waitForTimeout(500);
  expect((await probe(app)).notifications.length).toBe(before);
  await expect(accountRow("Travail").locator(".account-status")).toContainText("Snooze · 30 min");
  await screenshot(harness, "04-snooze");

  await command(app, { type: "resume", id: travail });
  await waitForAccount(app, "Travail", (account) => account.policy.mode === "normal");
  await inView(app, travail, 'fake.notify("Marie", "De retour", "chat-marie")');
  await expect.poll(async () => (await probe(app)).notifications.length).toBe(before + 1);
});

test("Focus « appels uniquement » : messages bloqués, appels transmis", async () => {
  const { app } = harness;
  const profileId = "5f0c3a1e-8b2d-4c6e-9f10-a1b2c3d4e5f6";
  await command(app, { type: "save-focus-profile", profile: { id: profileId, name: "Réunion", modes: { [travail]: "calls-only" }, othersMode: "snoozed" } });
  await command(app, { type: "activate-focus", profileId, minutes: 60 });
  await waitForAccount(app, "Travail", (account) => account.policy.mode === "calls-only" && account.policy.source === "focus");
  await waitForAccount(app, "Personnel", (account) => account.policy.mode === "snoozed" && account.policy.source === "focus");

  const before = (await probe(app)).notifications.length;
  await inView(app, travail, 'fake.notify("Marie", "Un message", "chat-marie")');
  await inView(app, travail, 'fake.notify("Paul", "Appel vocal entrant", "call-paul")');
  await expect.poll(async () => (await probe(app)).notifications.length).toBe(before + 1);
  const last = (await probe(app)).notifications.at(-1);
  expect(last).toMatchObject({ isCall: true, title: "Travail — Paul" });
  await expect(harness.shell.locator(".focus-chip")).toContainText("Réunion");
  await screenshot(harness, "05-focus");

  await command(app, { type: "activate-focus", profileId: null, minutes: null });
  await waitForAccount(app, "Travail", (account) => account.policy.mode === "normal");
});

test("appel en cours : détecté et protège de la veille", async () => {
  const { app } = harness;
  await inView(app, travail, "fake.mic()");
  await waitForAccount(app, "Travail", (account) => account.inCall);
  await command(app, { type: "sleep-account", id: travail });
  expect((await state(app)).accounts.find((account) => account.id === travail)?.lifecycle).toBe("ready");
  await inView(app, travail, "fake.stop()");
  await waitForAccount(app, "Travail", (account) => !account.inCall);
});

test("veille profonde puis réveil sans QR code", async () => {
  const { app, shell } = harness;
  await command(app, { type: "switch-account", id: personnel });
  await command(app, { type: "sleep-account", id: personnel });
  await waitForAccount(app, "Personnel", (account) => account.lifecycle === "sleeping");
  expect(await app.evaluate(() => (globalThis as any).__whathush.viewsManager().ids())).not.toContain(personnel);
  await expect(shell.getByRole("heading", { name: /est en veille/ })).toBeVisible();
  await screenshot(harness, "06-veille");

  await shell.getByRole("button", { name: "Réveiller" }).click();
  await waitForAccount(app, "Personnel", (account) => account.lifecycle === "ready");
});

test("crash du processus d'un compte : reprise automatique", async () => {
  const { app } = harness;
  const pid = await app.evaluate((_electron, id) => (globalThis as any).__whathush.viewsManager().processId(id), travail);
  expect(pid).toBeGreaterThan(0);
  process.kill(pid, "SIGKILL");
  await waitForAccount(app, "Travail", (account) => account.lifecycle === "crashed");
  await waitForAccount(app, "Travail", (account) => account.lifecycle === "ready");
  // Les autres comptes n'ont pas bougé.
  expect((await state(app)).accounts.find((account) => account.id === personnel)?.lifecycle).toBe("ready");
});

test("déconnexion à distance : QR requis et avertissement", async () => {
  const { app, shell } = harness;
  await command(app, { type: "switch-account", id: travail });
  await inView(app, travail, "fake.logout()");
  await waitForAccount(app, "Travail", (account) => account.lifecycle === "needs_qr");
  await expect(shell.locator(".notice", { hasText: "a été déconnecté" })).toBeVisible();
  await screenshot(harness, "07-deconnexion");
  await link(harness, travail, "Travail");
});

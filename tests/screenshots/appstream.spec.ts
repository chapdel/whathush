// Captures des métadonnées AppStream, en anglais, sur la fausse page WhatsApp en mode
// vitrine (conversations fictives) : packaging/screenshots/*.png, référencées par
// packaging/linux/io.github.chapdel.mcdesk.metainfo.xml.

import { expect, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { command, inView, launch, screenshot, state, waitForAccount } from "../e2e/harness";

const output = path.resolve(import.meta.dirname, "../../packaging/screenshots");

test("captures AppStream", async () => {
  const h = await launch({ systemLanguage: "en" });
  const { app, shell } = h;
  try {
    const accounts = {} as Record<"Work" | "Personal" | "Volunteering", string>;
    for (const [label, profile] of [["Work", "work"], ["Personal", "personal"], ["Volunteering", "personal"]] as const) {
      await command(app, { type: "add-account", label });
      const id = (await waitForAccount(app, label, (account) => account.lifecycle === "needs_qr")).id;
      await inView(app, id, "fake.link()");
      await waitForAccount(app, label, (account) => account.lifecycle === "ready");
      await inView(app, id, `fake.showcase(${JSON.stringify(profile)})`);
      accounts[label] = id;
    }
    // Un compte en Snooze, un autre en veille profonde : les états se voient dans la barre.
    await command(app, { type: "snooze", id: accounts.Personal, preset: { kind: "minutes", minutes: 60 } });
    await command(app, { type: "sleep-account", id: accounts.Volunteering });
    await command(app, { type: "switch-account", id: accounts.Work });
    await waitForAccount(app, "Volunteering", (account) => account.lifecycle === "sleeping");
    for (const notice of (await state(app)).notices) await command(app, { type: "dismiss-notice", id: notice.id });
    await expect.poll(async () => (await state(app)).notices.length).toBe(0);
    await expect(shell.locator('[data-account="Work"]')).toBeVisible();

    const shots: string[] = [];
    const save = (file: string, name: string) => {
      fs.mkdirSync(output, { recursive: true });
      fs.renameSync(file, path.join(output, name));
      shots.push(name);
    };

    save(await screenshot(h, "appstream-accounts"), "accounts.png");

    // Thème sombre : la coque et la page WhatsApp suivent. Playwright impose son propre
    // schéma de couleurs aux pages qu'il pilote : on lui donne le même.
    const colorScheme = async (theme: "light" | "dark") => {
      await command(app, { type: "set-preferences", patch: { theme } });
      await shell.emulateMedia({ colorScheme: theme });
      for (const page of app.windows()) if (page.url().startsWith(h.fakeUrl)) await page.emulateMedia({ colorScheme: theme });
    };
    await colorScheme("dark");
    await expect.poll(() => inView(app, accounts.Work, "matchMedia('(prefers-color-scheme: dark)').matches")).toBe(true);
    save(await screenshot(h, "appstream-dark"), "dark.png");
    await colorScheme("light");

    // Horaires : « Office hours » appliqué au compte Work.
    const scheduleId = crypto.randomUUID();
    await command(app, {
      type: "save-schedule",
      schedule: { id: scheduleId, name: "Office hours", defaultMode: "snoozed", rules: [{ days: [1, 2, 3, 4, 5], start: "09:00", end: "18:00", mode: "normal" }] }
    });
    await command(app, { type: "update-account", id: accounts.Work, patch: { scheduleId } });
    const settingsPromise = app.waitForEvent("window");
    await command(app, { type: "open-settings", section: "schedules" });
    const settings = await settingsPromise;
    await settings.setViewportSize({ width: 1000, height: 720 });
    await expect(settings.getByRole("heading", { name: "Schedules", exact: true })).toBeVisible();
    await expect(settings.getByText("Office hours").first()).toBeVisible();
    await settings.screenshot({ path: path.join(output, "schedules.png") });
    shots.push("schedules.png");
    await settings.close();

    // Verrouillage par code : les vues WhatsApp sont masquées, seule la coque est visible.
    await command(app, { type: "set-lock-code", current: null, next: "2468" });
    await command(app, { type: "lock-now" });
    await expect(shell.locator("#lock-status")).toBeAttached();
    await shell.screenshot({ path: path.join(output, "lock.png") });
    shots.push("lock.png");

    expect(shots).toEqual(["accounts.png", "dark.png", "schedules.png", "lock.png"]);
  } finally {
    await h.close();
    h.stopFake();
  }
});

// Harnais e2e (§39) : lance l'application construite contre la fausse page
// WhatsApp, sans fenêtre (ozone headless), dans un dossier de données jetable.

import { _electron as electron, expect, type ElectronApplication, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ShellState } from "../../src/shared/ipc";
// @ts-expect-error module JavaScript sans déclaration de types
import { startFakeWhatsApp } from "../../scripts/fake-whatsapp.mjs";

const root = path.resolve(import.meta.dirname, "../..");

export interface Harness {
  app: ElectronApplication;
  shell: Page;
  userData: string;
  fakeUrl: string;
  close(): Promise<void>;
}

export async function launch(options: { userData?: string; fakeUrl?: string; platform?: "headless" | "wayland" | "x11"; scaleFactor?: number; screenSize?: string; tray?: boolean } = {}): Promise<Harness & { stopFake(): void }> {
  const fake = options.fakeUrl ? { url: options.fakeUrl, close: () => undefined } : await startFakeWhatsApp();
  const userData = options.userData ?? fs.mkdtempSync(path.join(os.tmpdir(), "whathush-e2e-"));
  const app = await electron.launch({
    args: [root, `--ozone-platform=${options.platform ?? "headless"}`, `--ozone-override-screen-size=${options.screenSize ?? "1440,920"}`, ...(options.scaleFactor ? [`--force-device-scale-factor=${options.scaleFactor}`] : [])],
    env: {
      ...process.env,
      WHATHUSH_TEST: "1",
      WHATHUSH_TARGET_URL: fake.url,
      WHATHUSH_USER_DATA: userData,
      WHATHUSH_TRAY: options.tray ? "1" : "0"
    }
  });
  const shell = await app.firstWindow();
  await shell.waitForLoadState("domcontentloaded");
  return {
    app,
    shell,
    userData,
    fakeUrl: fake.url,
    stopFake: () => fake.close(),
    close: async () => {
      await app.close();
    }
  };
}

export async function state(app: ElectronApplication): Promise<ShellState> {
  return app.evaluate(() => (globalThis as any).__whathush.shellState());
}

export async function probe<T = any>(app: ElectronApplication): Promise<T> {
  return app.evaluate(() => JSON.parse(JSON.stringify((globalThis as any).__whathush.probe)));
}

export async function command(app: ElectronApplication, payload: Record<string, unknown>): Promise<void> {
  await app.evaluate(async (_electron, input) => (globalThis as any).__whathush.handleCommand(input), payload);
}

/** Exécute du code dans la vue WhatsApp d'un compte (la fausse page expose `fake`). */
export async function inView<T = unknown>(app: ElectronApplication, accountId: string, code: string): Promise<T> {
  return app.evaluate(
    async (_electron, { id, source }) => {
      const wc = (globalThis as any).__whathush.viewsManager().webContents(id);
      if (!wc) throw new Error(`pas de vue pour ${id}`);
      return wc.executeJavaScript(source, true);
    },
    { id: accountId, source: code }
  );
}

export async function waitForAccount(app: ElectronApplication, label: string, predicate: (account: ShellState["accounts"][number]) => boolean): Promise<ShellState["accounts"][number]> {
  let found: ShellState["accounts"][number] | undefined;
  await expect
    .poll(
      async () => {
        found = (await state(app)).accounts.find((account) => account.label === label);
        return found ? predicate(found) : false;
      },
      { timeout: 30_000 }
    )
    .toBe(true);
  return found as ShellState["accounts"][number];
}

/** Ajoute un compte par l'interface, comme un utilisateur. */
export async function addAccountViaUi(harness: Harness, label: string): Promise<string> {
  const { shell, app } = harness;
  const welcome = shell.getByRole("button", { name: "Ajouter mon premier compte" });
  if (await welcome.isVisible()) await welcome.click();
  else await shell.getByRole("button", { name: "Ajouter un compte" }).first().click();
  await shell.getByPlaceholder("Personnel, Travail, Support…").fill(label);
  await shell.getByRole("button", { name: "Ajouter", exact: true }).click();
  const account = await waitForAccount(app, label, (candidate) => candidate.lifecycle === "needs_qr");
  return account.id;
}

/** Lie un compte sur la fausse page (équivalent du scan du QR code). */
export async function link(harness: Harness, accountId: string, label: string): Promise<void> {
  await inView(harness.app, accountId, "fake.link()");
  await waitForAccount(harness.app, label, (account) => account.lifecycle === "ready");
}

/**
 * Capture de ce que voit l'utilisateur : la coque, avec la vue WhatsApp affichée
 * incrustée à sa place (les WebContentsView sont des couches natives séparées).
 */
export async function screenshot(harness: Harness, name: string): Promise<string> {
  const dir = path.join(root, "test-results", "screens");
  fs.mkdirSync(dir, { recursive: true });
  const shellFile = path.join(dir, `${name}.shell.png`);
  await harness.shell.screenshot({ path: shellFile });
  const view = await harness.app.evaluate(async () => {
    const application = (globalThis as any).__whathush;
    const views = application.viewsManager();
    const id = views.shown();
    if (!id) return null;
    const wc = views.webContents(id);
    const image = await wc.capturePage();
    const bounds = application.viewBounds();
    return { png: image.toPNG().toString("base64"), bounds };
  });
  const output = path.join(dir, `${name}.png`);
  if (!view) {
    fs.renameSync(shellFile, output);
    return output;
  }
  const viewFile = path.join(dir, `${name}.view.png`);
  fs.writeFileSync(viewFile, Buffer.from(view.png, "base64"));
  try {
    // Les bounds sont en DIP, les PNG en pixels physiques (HiDPI).
    const shellPixels = fs.readFileSync(shellFile).readUInt32BE(16);
    const shellWidth = await harness.shell.evaluate(() => innerWidth);
    const scale = shellPixels / shellWidth;
    execFileSync("magick", [shellFile, viewFile, "-geometry", `+${Math.round(view.bounds.x * scale)}+${Math.round(view.bounds.y * scale)}`, "-composite", output]);
    fs.rmSync(shellFile);
    fs.rmSync(viewFile);
  } catch {
    // ImageMagick absent (CI) : on garde les deux captures séparées.
    fs.renameSync(shellFile, output);
  }
  return output;
}

/**
 * Raccourci clavier par le chemin d'un vrai clavier (sendInputEvent) : le clavier
 * synthétique de Playwright (CDP) ne déclenche pas before-input-event.
 * target : « shell » ou l'identifiant du compte dont la vue a le focus.
 */
export async function pressShortcut(app: ElectronApplication, target: string, keyCode: string, modifiers: string[] = ["control"]): Promise<void> {
  await app.evaluate(
    ({ BrowserWindow }, input) => {
      const application = (globalThis as any).__whathush;
      const wc = input.target === "shell" ? BrowserWindow.getAllWindows()[0]?.webContents : application.viewsManager().webContents(input.target);
      wc.sendInputEvent({ type: "keyDown", keyCode: input.keyCode, modifiers: input.modifiers });
      wc.sendInputEvent({ type: "keyUp", keyCode: input.keyCode, modifiers: input.modifiers });
    },
    { target, keyCode, modifiers }
  );
}

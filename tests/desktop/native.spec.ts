import { expect, test } from "@playwright/test";
import { addAccountViaUi, command, launch, link, pressShortcut, screenshot, state } from "../e2e/harness";

for (const platform of ["wayland", "x11"] as const) {
  test(`bureau courant / ${platform} : fenêtre native, comptes, paramètres et tray`, async () => {
    test.skip(platform === "wayland" ? !process.env.WAYLAND_DISPLAY : !process.env.DISPLAY, "Session graphique indisponible");
    const h = await launch({ platform, tray: true });
    try {
      const id = await addAccountViaUi(h, "Test desktop");
      await link(h, id, "Test desktop");
      const window = await h.app.evaluate(({ BrowserWindow, app }) => ({
        visible: BrowserWindow.getAllWindows()[0]!.isVisible(),
        ozone: app.commandLine.getSwitchValue("ozone-platform"),
        bounds: BrowserWindow.getAllWindows()[0]!.getBounds(),
        content: BrowserWindow.getAllWindows()[0]!.getContentBounds()
      }));
      expect(window.visible).toBe(true);
      expect(window.ozone).toBe(platform);
      expect(window.content.width).toBeGreaterThanOrEqual(800);
      const settingsPromise = h.app.waitForEvent("window");
      await pressShortcut(h.app, id, ",");
      const settings = await settingsPromise;
      await settings.waitForURL("**/settings.html");
      await expect(settings.getByRole("heading", { name: "Général" })).toBeVisible();
      await settings.close();
      if ((await state(h.app)).trayAvailable) {
        await command(h.app, { type: "set-preferences", patch: { closeToTray: true } });
        await h.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close());
        await expect.poll(() => h.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isVisible())).toBe(false);
        await h.app.evaluate(() => (globalThis as any).__whathush.showMainWindow());
        await expect.poll(() => h.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isVisible())).toBe(true);
      }
      await screenshot(h, `desktop-${platform}`);
      console.log(JSON.stringify({ desktop: process.env.XDG_CURRENT_DESKTOP, platform, tray: (await state(h.app)).trayAvailable, window }));
    } finally { await h.close(); h.stopFake(); }
  });
}

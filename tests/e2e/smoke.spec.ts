import { expect, test } from "@playwright/test";
import { addAccountViaUi, launch, screenshot, state } from "./harness";

test("démarrage : écran d'accueil puis premier compte", async () => {
  const harness = await launch();
  try {
    await expect(harness.shell.getByRole("heading", { name: "Connecter WhatsApp" })).toBeVisible();
    await screenshot(harness, "01-accueil");
    const id = await addAccountViaUi(harness, "Personnel");
    expect((await state(harness.app)).activeId).toBe(id);
    await screenshot(harness, "02-liaison-qr");
  } finally {
    await harness.close();
    harness.stopFake();
  }
});

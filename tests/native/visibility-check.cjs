// Injecté dans le processus principal (NODE_OPTIONS=--require) par run.mjs.
// Vérifie la règle de visibilité sans Playwright : Playwright émule le
// focus des pages qu'il pilote, ce qui fausse document.visibilityState.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** Attend une condition plutôt qu'une durée fixe (machines lentes). */
async function until(condition, timeout = 15000) {
  const start = Date.now();
  for (;;) {
    if (await condition()) return true;
    if (Date.now() - start > timeout) return false;
    await sleep(100);
  }
}

(async () => {
  let application;
  for (let i = 0; i < 300 && !(application = globalThis.__whathush); i++) await sleep(100);
  await sleep(1000);
  const a = application.accounts.add({ label: "A" });
  const b = application.accounts.add({ label: "B" });
  const views = application.viewsManager();
  await until(async () => [a.id, b.id].every((id) => views.webContents(id) && !views.webContents(id).isLoading()));
  await until(async () => (await Promise.all([a.id, b.id].map((id) => views.webContents(id).executeJavaScript("typeof fake === 'object'").catch(() => false)))).every(Boolean));
  for (const id of [a.id, b.id]) await views.webContents(id).executeJavaScript("fake.link()");
  await until(() => [a.id, b.id].every((id) => application.accounts.runtime(id)?.lifecycle === "ready"));

  const read = async () => ({
    a: await views.webContents(a.id).executeJavaScript("document.visibilityState"),
    b: await views.webContents(b.id).executeJavaScript("document.visibilityState")
  });
  // Attendre l'état attendu (au plus 15 s), puis le relever : un échec garde l'état réel.
  const settle = async (a, b) => {
    await until(async () => {
      const state = await read();
      return state.a === a && state.b === b;
    });
    return read();
  };
  application.accounts.switchTo(a.id);
  const afterA = await settle("visible", "hidden");
  application.accounts.switchTo(b.id);
  const afterB = await settle("hidden", "visible");
  application.accounts.setModal(true);
  const duringModal = await settle("hidden", "hidden");
  application.accounts.setModal(false);
  const afterModal = await settle("hidden", "visible");
  // Verrouillé, aucune page WhatsApp n'est visible, même celle du compte affiché.
  await application.lock.setCode(null, "1234");
  application.lock.trigger("manual");
  const duringLock = await settle("hidden", "hidden");
  await application.lock.unlock("1234");
  const afterUnlock = await settle("hidden", "visible");

  // Une page cachée en Snooze qui lance un son d'elle-même reste coupée (son
  // origine se mesure à la vraie visibilité, que Playwright fausserait).
  application.policy.snooze(a.id, { kind: "minutes", minutes: 60 });
  await until(() => views.webContents(a.id).isAudioMuted());
  await views.webContents(a.id).executeJavaScript("fake.play(8)");
  await until(() => application.playback.forAccount(a.id, Date.now())?.playing === true);
  await sleep(300);
  const hiddenPlayback = { muted: views.webContents(a.id).isAudioMuted(), userStarted: application.playback.forAccount(a.id, Date.now())?.userStarted ?? null };
  console.log("RESULT " + JSON.stringify({ afterA, afterB, duringModal, afterModal, duringLock, afterUnlock, hiddenPlayback }));
  process.exit(0);
})();

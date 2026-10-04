// Injecté dans le processus principal (NODE_OPTIONS=--require) par run.mjs.
// Vérifie la règle de visibilité du §9 sans Playwright : Playwright émule le
// focus des pages qu'il pilote, ce qui fausse document.visibilityState.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  let application;
  for (let i = 0; i < 300 && !(application = globalThis.__whathush); i++) await sleep(100);
  await sleep(1000);
  const a = application.accounts.add({ label: "A" });
  const b = application.accounts.add({ label: "B" });
  await sleep(3000);
  const views = application.viewsManager();
  for (const id of [a.id, b.id]) await views.webContents(id).executeJavaScript("fake.link()");
  await sleep(2500);

  const read = async () => ({
    a: await views.webContents(a.id).executeJavaScript("document.visibilityState"),
    b: await views.webContents(b.id).executeJavaScript("document.visibilityState")
  });
  application.accounts.switchTo(a.id);
  await sleep(1500);
  const afterA = await read();
  application.accounts.switchTo(b.id);
  await sleep(1500);
  const afterB = await read();
  application.accounts.setModal(true);
  await sleep(1500);
  const duringModal = await read();
  application.accounts.setModal(false);
  await sleep(1500);
  const afterModal = await read();
  // F6 : verrouillé, aucune page WhatsApp n'est visible, même celle du compte affiché.
  await application.lock.setCode(null, "1234");
  application.lock.trigger("manual");
  await sleep(1500);
  const duringLock = await read();
  await application.lock.unlock("1234");
  await sleep(1500);
  const afterUnlock = await read();
  console.log("RESULT " + JSON.stringify({ afterA, afterB, duringModal, afterModal, duringLock, afterUnlock }));
  process.exit(0);
})();

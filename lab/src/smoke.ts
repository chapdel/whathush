// Smoke test automatisé contre la fausse page WhatsApp (npm run smoke).
// Il vérifie la mécanique du lab ; il ne remplace pas les tests manuels avec
// de vrais comptes (protocole de lab/README.md).

import fs from "node:fs";

interface SmokeAccount {
  id: string;
  label: string;
  sleeping: boolean;
}

interface SmokeRuntime {
  view: { webContents: Electron.WebContents } | null;
  lifecycle: string;
  unread: number | null;
  pageVisibility: string | null;
  envCount: number;
  lastEnv: { userAgent: string; brands: string[]; notificationOverridden: boolean; scriptsBeforeOverride: number } | null;
  notifyCount: number;
  lastNotifyId: number | null;
}

export interface SmokeContext {
  addAccount(label: string): SmokeAccount;
  switchTo(id: string): void;
  sleepAccount(id: string): void;
  wakeAccount(id: string): void;
  killRenderer(id: string): void;
  runtimeOf(id: string): SmokeRuntime;
  findAccount(id: string | null): SmokeAccount | undefined;
  partitionDir(id: string): string;
  shellEval(code: string): Promise<unknown>;
  shellErrors(): number;
  logFile: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean, timeoutMs = 8000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(100);
  }
  return predicate();
}

async function waitForAsync(predicate: () => Promise<boolean>, timeoutMs = 8000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(100);
  }
  return predicate();
}

async function pageId(runtime: SmokeRuntime): Promise<string | null> {
  if (!runtime.view) return null;
  const value = await runtime.view.webContents.executeJavaScript("localStorage.getItem('labPageId')");
  return typeof value === "string" ? value : null;
}

const short = (value: string | null | undefined) => (value ? value.slice(0, 8) : String(value));

export async function runSmoke(ctx: SmokeContext): Promise<boolean> {
  const results: Array<{ name: string; ok: boolean; detail: string }> = [];
  const check = (name: string, ok: boolean, detail = "") => results.push({ name, ok, detail });

  try {
    const a = ctx.addAccount("Smoke A");
    const b = ctx.addAccount("Smoke B");
    ctx.switchTo(a.id);
    const ra = ctx.runtimeOf(a.id);
    const rb = ctx.runtimeOf(b.id);

    check(
      "Chargement des deux comptes",
      await waitFor(() => ra.lifecycle === "loaded" && rb.lifecycle === "loaded"),
      `A=${ra.lifecycle} B=${rb.lifecycle}`
    );

    await waitFor(() => ra.lastEnv !== null && rb.lastEnv !== null);
    const userAgent = ra.lastEnv?.userAgent ?? "";
    const brands = ra.lastEnv?.brands ?? [];
    check("User-Agent Chrome sans « Electron »", userAgent.includes("Chrome/") && !/Electron/i.test(userAgent), userAgent);
    check("Client Hints sans « Electron »", !brands.some((brand) => /Electron/i.test(brand)), brands.join(", "));
    check(
      "Notification remplacée avant les scripts de la page",
      ra.lastEnv?.notificationOverridden === true && ra.lastEnv?.scriptsBeforeOverride === 0,
      `remplacée=${ra.lastEnv?.notificationOverridden} scriptsAvant=${ra.lastEnv?.scriptsBeforeOverride}`
    );

    check(
      "Notifications interceptées dans les deux comptes",
      await waitFor(() => ra.notifyCount > 0 && rb.notifyCount > 0),
      `A=${ra.notifyCount} B=${rb.notifyCount}`
    );
    check("Non-lus lus depuis le titre", await waitFor(() => ra.unread === 3 && rb.unread === 3), `A=${ra.unread} B=${rb.unread}`);
    check("Compte affiché : page visible", await waitFor(() => ra.pageVisibility === "visible"), `A=${ra.pageVisibility}`);
    check("Compte caché : page hidden", await waitFor(() => rb.pageVisibility === "hidden"), `B=${rb.pageVisibility}`);

    const shellRows = async () => Number(await ctx.shellEval("document.querySelectorAll('#accounts li').length"));
    check("Coque : les deux comptes affichés dans la barre latérale", await waitForAsync(async () => (await shellRows()) === 2), `lignes=${await shellRows()}`);
    const shellBadges = async () =>
      String(await ctx.shellEval("[...document.querySelectorAll('#accounts .badge')].map((b) => b.textContent).join(',')"));
    check("Coque : badges de non-lus", await waitForAsync(async () => (await shellBadges()) === "3,3"), await shellBadges());

    if (ra.view && ra.lastNotifyId !== null) ra.view.webContents.send("wa:notification-click", ra.lastNotifyId);
    check("Clic sur notification renvoyé à la page", await waitFor(() => ra.unread === 0), `A non-lus=${ra.unread}`);

    ctx.switchTo(b.id);
    check(
      "Bascule : A passe hidden, B visible",
      await waitFor(() => ra.pageVisibility === "hidden" && rb.pageVisibility === "visible"),
      `A=${ra.pageVisibility} B=${rb.pageVisibility}`
    );

    const idA = await pageId(ra);
    const idB = await pageId(rb);
    check("Stockage isolé entre comptes", idA !== null && idB !== null && idA !== idB, `A=${short(idA)} B=${short(idB)}`);
    check(
      "Une partition par compte sur disque",
      fs.existsSync(ctx.partitionDir(a.id)) && fs.existsSync(ctx.partitionDir(b.id)),
      ctx.partitionDir(a.id)
    );

    const envBeforeSleep = ra.envCount;
    ctx.sleepAccount(a.id);
    check("Veille : vue détruite", ra.view === null && ctx.findAccount(a.id)?.sleeping === true);
    ctx.wakeAccount(a.id);
    const woke = await waitFor(() => ra.envCount > envBeforeSleep && ra.lifecycle === "loaded");
    const idAfterWake = woke ? await pageId(ra) : null;
    check("Réveil : page rechargée, stockage conservé", woke && idAfterWake === idA, `avant=${short(idA)} après=${short(idAfterWake)}`);

    const envBeforeCrash = rb.envCount;
    ctx.killRenderer(b.id);
    check(
      "Crash : recréation automatique",
      await waitFor(() => rb.envCount > envBeforeCrash && rb.lifecycle === "loaded", 10_000),
      `état=${rb.lifecycle}`
    );
    check("Coque : aucune erreur JavaScript", ctx.shellErrors() === 0, `erreurs=${ctx.shellErrors()}`);
  } catch (error) {
    check("Exception pendant le smoke test", false, String(error));
  }

  console.log("\nSmoke test — Feasibility Lab");
  for (const result of results) {
    console.log(`${result.ok ? "✔" : "✘"} ${result.name}${result.detail ? `  (${result.detail})` : ""}`);
  }
  const passed = results.filter((result) => result.ok).length;
  const allOk = passed === results.length;
  console.log(`\n${passed}/${results.length} OK${allOk ? "" : ` — journal : ${ctx.logFile}`}`);
  return allOk;
}

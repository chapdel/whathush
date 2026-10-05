// Sonde sans compte (npm run probe) : charge le vrai web.whatsapp.com dans une
// partition jetable et relève ce qui est observable avant toute connexion.
// Diagnostic de lab uniquement : la lecture du texte de la page (niveau 3) n'a
// pas sa place dans le produit.

import fs from "node:fs";
import path from "node:path";
import type { LogEntry } from "./shared";

interface ProbeRuntime {
  view: { webContents: Electron.WebContents } | null;
  lifecycle: string;
  unread: number | null;
  pageVisibility: string | null;
  lastEnv: { userAgent: string; brands: string[]; notificationOverridden: boolean; scriptsBeforeOverride: number } | null;
  notifyCount: number;
}

export interface ProbeContext {
  addAccount(label: string): { id: string };
  runtimeOf(id: string): ProbeRuntime;
  serviceWorkers(id: string): Array<{ scope: string; scriptUrl: string }>;
  permissionChecks(id: string): string[];
  recentLogs(): LogEntry[];
  outDir: string;
  uaOverride: boolean;
}

const SETTLE_MS = Number(process.env.LAB_PROBE_SETTLE_MS ?? 20_000);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function runProbe(ctx: ProbeContext): Promise<void> {
  const account = ctx.addAccount("Probe");
  const runtime = ctx.runtimeOf(account.id);

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && runtime.lifecycle !== "loaded" && runtime.lifecycle !== "failed") await sleep(200);
  // Laisser l'application WhatsApp démarrer (chargement des scripts, service worker, QR).
  await sleep(SETTLE_MS);

  const wc = runtime.view?.webContents;
  const label = ctx.uaOverride ? "ua-chrome" : "ua-electron";
  const report: Record<string, unknown> = { mode: label, lifecycle: runtime.lifecycle, env: runtime.lastEnv };

  if (wc && !wc.isDestroyed()) {
    report.page = await wc.executeJavaScript(`({
      url: location.href,
      title: document.title,
      text: (document.body ? document.body.innerText : "").replace(/\\s+/g, " ").trim().slice(0, 400),
      canvases: document.querySelectorAll("canvas").length,
      serviceWorkerControlled: Boolean(navigator.serviceWorker && navigator.serviceWorker.controller),
      notificationPermission: typeof Notification === "function" ? Notification.permission : null
    })`);
    report.serviceWorkerRegistrations = await wc.executeJavaScript(
      "navigator.serviceWorker ? navigator.serviceWorker.getRegistrations().then((rs) => rs.map((r) => r.scope)) : []"
    );
    const image = await wc.capturePage();
    const screenshot = path.join(ctx.outDir, `probe-${label}.png`);
    fs.writeFileSync(screenshot, image.toPNG());
    report.screenshot = screenshot;
  }

  report.runningServiceWorkers = ctx.serviceWorkers(account.id);
  report.permissionChecks = ctx.permissionChecks(account.id);
  report.permissionRequests = ctx
    .recentLogs()
    .filter((entry) => entry.event === "permission-request")
    .map((entry) => entry.data);
  report.notifications = runtime.notifyCount;
  report.swNotifications = ctx.recentLogs().filter((entry) => entry.event === "sw-notification").length;
  report.warnings = ctx
    .recentLogs()
    .filter((entry) => entry.level !== "info")
    .map((entry) => `${entry.event} ${JSON.stringify(entry.data ?? "")}`.slice(0, 300));

  console.log("\nSonde WhatsApp Web (sans compte)");
  console.log(JSON.stringify(report, null, 2));
}

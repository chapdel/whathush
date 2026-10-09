// Banc de mesure des ressources (npm run bench) : lance l'application construite dans
// un profil jetable, sans fenêtre, et relève /proc pour tout son arbre de processus :
// processeur, mémoire (PSS, swap compris : la part réelle de chaque processus), réveils par seconde.
//
//   npm run bench                         → tous les scénarios
//   npm run bench -- --scenario hidden    → socle | hidden | visible | minimized | away | economy | tray | startup
//                                            (plusieurs : --scenario socle,hidden)
//   npm run bench -- --check              → échoue au-delà des seuils de non-régression (CI)
//   npm run bench -- --real               → web.whatsapp.com (non connecté) au lieu de la page synthétique
//   npm run bench -- --app <dossier>      → une autre construction (comparaison)
//   npm run bench -- --app <dossier> --legacy → construction antérieure à la 0.3.0 (fichiers v2)
//
// Page synthétique : DOM et activité d'un compte connecté (≈ 6 700 nœuds, présence,
// horodatages, conversation qui remonte, WebSocket). Résultats dans test-results/bench/.

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import electron from "electron";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? (argv[index + 1] && !argv[index + 1].startsWith("--") ? argv[index + 1] : true) : fallback;
};
const appDir = path.resolve(option("app", root));
const real = option("real", false) === true;
const legacy = option("legacy", false) === true;
const only = String(option("scenario", "all")).split(",");
const check = option("check", false) === true;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const CLK_TCK = 100;

// Scénarios en mode test (test: true) : délais raccourcis et absence simulée ; la
// construction comparée tourne dans le même mode.
const QUICK = { economy: { dozeAfterHiddenMs: 15_000, trayAfterMs: 15_000, relaySettleMs: 10_000, relayQuietMs: 5_000 }, economyTickMs: 2_000, economyIntervalMs: 30 * 60_000, presencePollMs: { present: 1000, away: 1000 } };
const SCENARIOS = {
  socle: { accounts: 0, settle: 20, duration: 60, label: "Socle sans compte" },
  hidden: { accounts: 4, settle: 40, duration: 90, hide: true, label: "4 comptes, fenêtre dans la barre système" },
  visible: { accounts: 2, settle: 30, duration: 60, label: "2 comptes, fenêtre affichée" },
  minimized: { accounts: 2, settle: 30, duration: 60, unpresent: true, label: "2 comptes, fenêtre réduite (non présentée)" },
  away: { accounts: 2, settle: 30, duration: 60, away: true, test: true, label: "2 comptes, utilisateur absent" },
  economy: { accounts: 4, settle: 45, duration: 60, periodic: true, test: true, label: "4 comptes dont 3 en mode économie" },
  tray: { accounts: 4, settle: 45, duration: 60, hide: true, inTray: true, test: true, label: "4 comptes, économie maximale dans la barre système" },
  startup: { accounts: 4, settle: 45, duration: 10, label: "Démarrage de 4 comptes" }
};

// --- Page servie --------------------------------------------------------------------------
async function serve() {
  const page = fs.readFileSync(path.join(root, "tests", "fixtures", "heavy-whatsapp", "index.html"));
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end(page);
  });
  // WebSocket minimale : poignée de main, puis la connexion reste ouverte (comme WhatsApp).
  server.on("upgrade", (request, socket) => {
    const accept = crypto.createHash("sha1").update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.on("data", () => undefined);
    socket.on("error", () => undefined);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${server.address().port}/?chats=300`, close: () => server.close() };
}

// --- Profil jetable ---------------------------------------------------------------------------
function profile(dir, count, scenario) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const now = Date.now();
  const accounts = Array.from({ length: count }, (_, index) => {
    const id = crypto.randomUUID();
    return {
      id, label: `Compte ${index + 1}`, color: "#5a5fc4", order: index, partition: `persist:wa-${id}`,
      notifications: { enabled: true, sound: true, showPreview: true, badge: true, includeInTotal: true, badgeWhileSnoozed: true },
      sleeping: false, createdAt: new Date(now).toISOString(), lastOpenedAt: new Date(now - index * 60_000).toISOString(), zoomPercent: 100,
      permissions: { microphone: "allow", camera: "allow", location: "deny", screenShare: "ask" }, proxyMode: "inherit", proxy: null, themeHintShown: true,
      ...(legacy ? {} : { delivery: scenario.periodic && index > 0 ? "periodic" : "realtime" })
    };
  });
  fs.writeFileSync(path.join(dir, "accounts.json"), JSON.stringify({ schemaVersion: legacy ? 2 : 3, accounts, pendingPartitionDeletion: [] }));
  fs.writeFileSync(path.join(dir, "preferences.json"), JSON.stringify({
    schemaVersion: legacy ? 2 : 3, launchAtLogin: false, closeToTray: true, startMinimized: false, theme: "system", spellcheckLanguages: [], handleWhatsappLinks: false,
    sidebarCollapsed: false, askDownloadLocation: false, onboardingDone: true, language: "fr", interfaceScale: 100, spellcheckMode: "system", downloadsHistoryDays: 30,
    privacyVeil: { onBlur: false, onScreenShare: false, blurMessages: false }, proxy: { mode: "system", server: null }, trayCountStyle: "number", exclusivePlayback: false,
    ...(legacy ? {} : { awayHideMinutes: 5, economy: { intervalMinutes: 30, inTray: Boolean(scenario.inTray) } })
  }));
  return accounts.map((account) => account.id);
}

// --- /proc ----------------------------------------------------------------------------------------
const read = (file) => {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
};
function stat(pid) {
  const raw = read(`/proc/${pid}/stat`);
  if (!raw) return null;
  const fields = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
  return { ppid: Number(fields[1]), ticks: Number(fields[11]) + Number(fields[12]) };
}
/** Part réelle du processus en mémoire, swap compris (machine chargée : une partie peut y être). */
function pss(pid) {
  const raw = read(`/proc/${pid}/smaps_rollup`) ?? "";
  return (Number(/^Pss:\s+(\d+)/m.exec(raw)?.[1] ?? 0) + Number(/^SwapPss:\s+(\d+)/m.exec(raw)?.[1] ?? 0)) / 1024;
}
function wakeups(pid) {
  let total = 0;
  for (const task of (() => { try { return fs.readdirSync(`/proc/${pid}/task`); } catch { return []; } })()) {
    const raw = read(`/proc/${pid}/task/${task}/status`) ?? "";
    total += Number(/^voluntary_ctxt_switches:\s+(\d+)/m.exec(raw)?.[1] ?? 0) + Number(/^nonvoluntary_ctxt_switches:\s+(\d+)/m.exec(raw)?.[1] ?? 0);
  }
  return total;
}
function tree(rootPid) {
  const children = new Map();
  for (const name of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    const info = stat(Number(name));
    if (info) children.set(info.ppid, [...(children.get(info.ppid) ?? []), Number(name)]);
  }
  const result = [];
  const queue = [rootPid];
  while (queue.length) {
    const pid = queue.shift();
    result.push(pid);
    queue.push(...(children.get(pid) ?? []));
  }
  return result;
}
function sample(rootPid, withDetail) {
  const procs = new Map();
  for (const pid of tree(rootPid)) {
    const info = stat(pid);
    if (info) procs.set(pid, { ticks: info.ticks, ...(withDetail ? { pss: pss(pid), wakeups: wakeups(pid) } : {}) });
  }
  return { at: Date.now(), procs };
}
function role(pid, mainPid, pages, ids) {
  const command = (read(`/proc/${pid}/cmdline`) ?? "").split("\0").join(" ");
  if (pid === mainPid) return "principal";
  if (/^\S*gdbus\b/.test(command)) return "gdbus";
  const type = /--type=(\S+)/.exec(command)?.[1];
  if (type === "renderer") {
    const page = pages.find((entry) => entry.pid === pid);
    if (!page) return "service worker";
    if (page.url.startsWith("app://renderer/index.html")) return "coque";
    if (page.url.startsWith("app://renderer/settings.html")) return "paramètres";
    return page.account ? "pages WhatsApp" : "autre page";
  }
  if (type === "gpu-process") return "GPU";
  if (type === "utility") return `utilitaire (${(/--utility-sub-type=(\S+)/.exec(command)?.[1] ?? "?").split(".")[0]})`;
  if (type === "zygote") return "zygotes";
  return type ?? "autre";
}

async function run(name, scenario, target) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "whathush-bench-"));
  const userData = path.join(work, "data");
  const ids = profile(userData, scenario.accounts, scenario);
  const probeOut = path.join(work, "probe.json");
  const env = {
    ...process.env,
    WHATHUSH_USER_DATA: userData,
    WHATHUSH_TRAY: "0",
    NODE_OPTIONS: `--require ${path.join(root, "scripts", "bench-probe.cjs")}`,
    BENCH_PROBE_OUT: probeOut,
    BENCH_FINAL_AT: String(scenario.settle + scenario.duration - 3),
    ...(scenario.hide ? { BENCH_HIDE_AT: "5" } : {}),
    ...(scenario.away ? { BENCH_AWAY_AT: String(scenario.settle - 10) } : {}),
    ...(scenario.unpresent ? { BENCH_UNPRESENT_AT: String(scenario.settle - 10) } : {}),
    ...(scenario.test ? { WHATHUSH_TEST: "1", WHATHUSH_TEST_TIMINGS: JSON.stringify(QUICK) } : {}),
    LANGUAGE: "fr_FR:fr",
    LANG: "fr_FR.UTF-8"
  };
  if (!scenario.test) delete env.WHATHUSH_TEST;
  if (target) env.WHATHUSH_TARGET_URL = target;
  else delete env.WHATHUSH_TARGET_URL;
  const child = spawn(electron, [appDir, "--ozone-platform=headless", "--ozone-override-screen-size=1440,920", "--password-store=basic"], { env, stdio: "ignore", detached: true });
  const start = Date.now();
  const elapsed = () => (Date.now() - start) / 1000;

  // Installation : pic de processeur (fenêtres de 3 s) et de mémoire.
  let previous = sample(child.pid, false);
  let startupPeakMB = 0;
  let startupMaxCpu = 0;
  while (elapsed() < scenario.settle) {
    await sleep(3000);
    const current = sample(child.pid, true);
    let ticks = 0;
    for (const [pid, proc] of current.procs) ticks += proc.ticks - (previous.procs.get(pid)?.ticks ?? proc.ticks);
    startupMaxCpu = Math.max(startupMaxCpu, (ticks / CLK_TCK / ((current.at - previous.at) / 1000)) * 100);
    startupPeakMB = Math.max(startupPeakMB, [...current.procs.values()].reduce((sum, proc) => sum + proc.pss, 0));
    previous = current;
  }
  const startupCpuSeconds = [...previous.procs.values()].reduce((sum, proc) => sum + proc.ticks, 0) / CLK_TCK;

  const first = sample(child.pid, true);
  while (elapsed() < scenario.settle + scenario.duration) await sleep(1000);
  const last = sample(child.pid, true);
  const probe = JSON.parse(read(probeOut) ?? '{"pages":[]}');
  const seconds = (last.at - first.at) / 1000;
  const roles = new Map();
  for (const [pid, proc] of last.procs) {
    const name = role(pid, child.pid, probe.pages ?? [], ids);
    const before = first.procs.get(pid);
    const entry = roles.get(name) ?? { processes: 0, cpu: 0, pssMB: 0, wakeups: 0 };
    entry.processes += 1;
    entry.cpu += before ? ((proc.ticks - before.ticks) / CLK_TCK / seconds) * 100 : 0;
    entry.pssMB += proc.pss;
    entry.wakeups += before ? (proc.wakeups - before.wakeups) / seconds : 0;
    roles.set(name, entry);
  }
  try {
    process.kill(child.pid, "SIGTERM");
  } catch {
    // déjà terminé
  }
  await sleep(3000);
  for (const pid of tree(child.pid)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // déjà terminé
    }
  }
  fs.rmSync(work, { recursive: true, force: true });
  const total = [...roles.values()].reduce((sum, entry) => ({ processes: sum.processes + entry.processes, cpu: sum.cpu + entry.cpu, pssMB: sum.pssMB + entry.pssMB, wakeups: sum.wakeups + entry.wakeups }), { processes: 0, cpu: 0, pssMB: 0, wakeups: 0 });
  return { name, label: scenario.label, total, roles: Object.fromEntries(roles), startup: { cpuSeconds: startupCpuSeconds, peakMB: startupPeakMB, maxCpuPercent: startupMaxCpu }, pages: probe.detail ?? null };
}

// --- Rapport ----------------------------------------------------------------------------------------
const load = Number(fs.readFileSync("/proc/loadavg", "utf8").split(" ")[0]);
if (load > os.availableParallelism()) console.warn(`⚠ machine chargée (charge ${load}) : les mesures de processeur seront bruitées`);
const pages = real ? null : await serve();
const results = [];
for (const [name, scenario] of Object.entries(SCENARIOS)) {
  if (!only.includes("all") && !only.includes(name)) continue;
  process.stdout.write(`… ${scenario.label}\n`);
  results.push(await run(name, scenario, real ? null : pages.url));
}
pages?.close();

const fixed = (value, digits = 1) => (Math.round(value * 10 ** digits) / 10 ** digits).toFixed(digits);
for (const result of results) {
  console.log(`\n${result.label}`);
  console.log(`  total : ${result.total.processes} processus, ${fixed(result.total.cpu, 2)} % CPU, ${Math.round(result.total.pssMB)} Mo, ${Math.round(result.total.wakeups)} réveils/s`);
  if (result.name === "startup") console.log(`  démarrage : ${fixed(result.startup.cpuSeconds)} s de CPU, pic ${Math.round(result.startup.peakMB)} Mo, jusqu'à ${fixed(result.startup.maxCpuPercent / 100)} cœur(s)`);
  for (const [name, entry] of Object.entries(result.roles).sort((a, b) => b[1].pssMB - a[1].pssMB)) {
    console.log(`  ${name.padEnd(28)} ${String(entry.processes).padStart(2)} × ${fixed(entry.cpu, 2).padStart(6)} % ${String(Math.round(entry.pssMB)).padStart(5)} Mo ${String(Math.round(entry.wakeups)).padStart(5)} réveils/s`);
  }
}
const outDir = path.join(root, "test-results", "bench");
fs.mkdirSync(outDir, { recursive: true });
const file = path.join(outDir, `bench-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
fs.writeFileSync(file, `${JSON.stringify({ app: appDir, real, legacy, load, results }, null, 2)}\n`);
console.log(`\n→ ${path.relative(root, file)}`);

// --- Seuils (--check) -------------------------------------------------------------------------------
// Non-régression en CI. Seuils larges (machines partagées, mesures bruitées) : ils ne relèvent
// que les vraies dérives, processus en trop (gdbus…), socle qui grossit ou s'agite, pages
// cachées qui restent actives. (Socle mesuré : 7 processus, ~270 Mo, 0,2 % de CPU, 16 réveils/s.)
const LIMITS = {
  socle: { processes: 8, pssMB: 400, cpu: 1, wakeups: 60 },
  hidden: { pagesCpu: 2, pagesHidden: true },
  minimized: { pagesHidden: true },
  economy: { pageProcesses: 1 },
  tray: { pageProcesses: 0 }
};
if (check) {
  const failures = [];
  for (const result of results) {
    const limit = LIMITS[result.name];
    if (!limit) continue;
    const pagesRole = result.roles["pages WhatsApp"] ?? { processes: 0, cpu: 0 };
    const over = (label, value, max) => value > max && failures.push(`${result.label} : ${label} ${fixed(value, 2)} > ${max}`);
    if (limit.processes !== undefined) over("processus", result.total.processes, limit.processes);
    if (limit.pssMB !== undefined) over("Mo", result.total.pssMB, limit.pssMB);
    if (limit.cpu !== undefined) over("% CPU", result.total.cpu, limit.cpu);
    if (limit.wakeups !== undefined) over("réveils/s", result.total.wakeups, limit.wakeups);
    if (limit.pagesCpu !== undefined) over("% CPU des pages WhatsApp", pagesRole.cpu, limit.pagesCpu);
    if (limit.pageProcesses !== undefined) over("pages WhatsApp en vie", pagesRole.processes, limit.pageProcesses);
    if (limit.pagesHidden) {
      const visible = (result.pages ?? []).filter((page) => /^https?:/.test(page.url) && page.visibility !== "hidden");
      if (visible.length > 0) failures.push(`${result.label} : ${visible.length} page(s) WhatsApp non masquée(s)`);
    }
  }
  for (const failure of failures) console.log(`✘ ${failure}`);
  if (failures.length > 0) process.exit(1);
  console.log("✔ seuils respectés");
}

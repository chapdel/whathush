// Build : esbuild pour le processus principal et les preloads (un seul fichier par
// preload, exigé par le sandbox), Vite pour l'interface React.

import { execFileSync } from "node:child_process";
import { build as esbuild } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build as viteBuild } from "vite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");

fs.rmSync(dist, { recursive: true, force: true });

// Processus principal minifié ; les mises à jour de l'AppImage (electron-updater et ses
// dépendances) dans un bundle séparé, chargé seulement par l'AppImage.
await esbuild({
  absWorkingDir: root,
  entryPoints: { "main/index": "src/main/index.ts", "main/updates": "src/main/updates.ts" },
  outdir: dist,
  // package.json déclare "type": "module" : le bundle CommonJS doit porter l'extension .cjs.
  outExtension: { ".js": ".cjs" },
  bundle: true,
  minify: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["electron"],
  sourcemap: "linked",
  logLevel: "warning"
});

await esbuild({
  absWorkingDir: root,
  entryPoints: { "preload/shell": "src/preload/shell.ts", "preload/whatsapp": "src/preload/whatsapp.ts" },
  outdir: dist,
  bundle: true,
  minify: true,
  platform: "browser",
  format: "cjs",
  target: "chrome140",
  external: ["electron"],
  logLevel: "warning"
});

await viteBuild({ configFile: path.join(root, "vite.config.ts"), logLevel: "warn" });

fs.cpSync(path.join(root, "build", "app-assets"), path.join(dist, "assets"), { recursive: true });
// Dictionnaires embarqués (français, anglais) et leur notice de licence.
fs.cpSync(path.join(root, "build", "dictionaries"), path.join(dist, "dictionaries"), { recursive: true });

// Empreinte du build : l'auto-test des paquets l'affiche, ce qui permet de vérifier
// qu'un paquet contient bien ce build et pas une version restée en cache.
function git(args) {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}
const buildInfo = {
  commit: git(["rev-parse", "--short", "HEAD"]) || "inconnu",
  dirty: git(["status", "--porcelain"]).length > 0,
  builtAt: new Date().toISOString()
};
fs.writeFileSync(path.join(dist, "build-info.json"), `${JSON.stringify(buildInfo, null, 2)}\n`);
console.log("build terminé → dist/");

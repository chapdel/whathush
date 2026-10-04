// Build : esbuild pour le processus principal et les preloads (un seul fichier par
// preload, exigé par le sandbox), Vite pour l'interface React.

import { build as esbuild } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build as viteBuild } from "vite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");

fs.rmSync(dist, { recursive: true, force: true });

await esbuild({
  absWorkingDir: root,
  entryPoints: { "main/index": "src/main/index.ts" },
  outdir: dist,
  // package.json déclare "type": "module" : le bundle CommonJS doit porter l'extension .cjs.
  outExtension: { ".js": ".cjs" },
  bundle: true,
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
  platform: "browser",
  format: "cjs",
  target: "chrome140",
  external: ["electron"],
  logLevel: "warning"
});

await viteBuild({ configFile: path.join(root, "vite.config.ts"), logLevel: "warn" });

fs.cpSync(path.join(root, "build", "app-assets"), path.join(dist, "assets"), { recursive: true });
console.log("build terminé → dist/");

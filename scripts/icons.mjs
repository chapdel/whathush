// Icônes du tray avec le nombre de non-lus (F4). Le processus principal ne sait pas
// dessiner du texte sans dépendance : les variantes sont générées ici, une fois,
// avec ImageMagick (rendu librsvg), et versionnées dans build/app-assets.
//
//   npm run icons

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const assets = path.join(root, "build", "app-assets");
const base = fs.readFileSync(path.join(root, "build", "icon.svg"), "utf8");

// Pastille rouge en haut à droite, assez grande pour un chiffre lisible à 22–32 px.
function badge(label) {
  const wide = label.length > 1;
  const shape = wide
    ? `<rect x="196" y="8" width="308" height="232" rx="116" fill="#e5372f" stroke="#fff" stroke-width="20"/>`
    : `<circle cx="384" cy="128" r="120" fill="#e5372f" stroke="#fff" stroke-width="20"/>`;
  const x = wide ? 350 : 384;
  const size = wide ? 168 : 196;
  return `${shape}<text x="${x}" y="128" dy=".36em" text-anchor="middle" font-family="Noto Sans, DejaVu Sans, Liberation Sans, sans-serif" font-weight="700" font-size="${size}" fill="#fff">${label}</text>`;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "whathush-icons-"));
const labels = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "9+"];
for (const label of labels) {
  const svg = base.replace("</svg>", `${badge(label)}\n</svg>`);
  const source = path.join(tmp, "icon.svg");
  fs.writeFileSync(source, svg);
  const name = label === "9+" ? "tray-9plus" : `tray-${label}`;
  for (const [size, suffix] of [[32, ""], [64, "@2x"]]) {
    execFileSync("magick", ["-background", "none", "-density", "384", source, "-resize", `${size}x${size}`, "-depth", "8", path.join(assets, `${name}${suffix}.png`)]);
  }
}
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`icônes du tray générées : ${labels.length} × 2 → build/app-assets/`);

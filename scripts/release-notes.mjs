// Notes d'une release GitHub, tirées des métadonnées AppStream : une seule source
// pour Flathub, les logithèques et GitHub. Usage : node scripts/release-notes.mjs 0.2.0

import fs from "node:fs";

const version = process.argv[2];
if (!version) {
  console.error("usage : node scripts/release-notes.mjs <version>");
  process.exit(2);
}
const xml = fs.readFileSync(new URL("../packaging/linux/io.github.chapdel.mcdesk.metainfo.xml", import.meta.url), "utf8");
const release = xml.match(new RegExp(`<release version="${version.replaceAll(".", "\\.")}"[^>]*>([\\s\\S]*?)</release>`));
if (!release) {
  console.error(`version ${version} absente des métadonnées AppStream : ajoutez son <release>`);
  process.exit(1);
}

const decode = (text) =>
  text
    .replace(/\s+/g, " ")
    .trim()
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
// Seulement l'anglais : les traductions portent un attribut xml:lang.
const blocks = [...release[1].matchAll(/<(p|li)>([\s\S]*?)<\/\1>/g)].map(([, tag, text]) => (tag === "li" ? `- ${decode(text)}` : decode(text)));
if (blocks.length === 0) {
  console.error(`la version ${version} n'a pas de description en anglais`);
  process.exit(1);
}

console.log(
  [
    blocks.join("\n\n"),
    "The AppImage updates itself; the other formats update through their package manager. Checksums are in `SHA256SUMS`.",
    "Independent project, not affiliated with WhatsApp LLC or Meta Platforms."
  ].join("\n\n")
);

#!/bin/bash
# Prépare les fichiers du dépôt Flathub pour la version de package.json : le manifeste,
# dont la source locale devient le tag Git publié (avec son commit), les sources npm
# et flathub.json. Usage : packaging/flatpak/prepare-flathub.sh <dossier>
#   Première soumission : PR vers la branche new-pr de github.com/flathub/flathub.
#   Ensuite : commit dans github.com/flathub/io.github.chapdel.mcdesk.
set -euo pipefail

root=$(cd "$(dirname "$0")/../.." && pwd)
target=$(realpath "${1:?usage : packaging/flatpak/prepare-flathub.sh <dossier>}")
version=$(node -p "require('$root/package.json').version")
commit=$(git -C "$root" rev-parse "v$version^{commit}" 2>/dev/null) || { echo "tag v$version introuvable : créer et pousser le tag d'abord" >&2; exit 1; }
git -C "$root" ls-remote --exit-code --tags origin "v$version" >/dev/null || { echo "tag v$version absent de GitHub : git push origin v$version" >&2; exit 1; }

mkdir -p "$target"
python3 - "$root/packaging/flatpak/io.github.chapdel.mcdesk.yml" "$target/io.github.chapdel.mcdesk.yml" "$version" "$commit" <<'PY'
import re, sys
source, output, version, commit = sys.argv[1:]
manifest = open(source, encoding="utf-8").read()
local = re.search(r"      # Local source.*?\n      - type: dir\n.*?(?=\n      - generated-sources\.json)", manifest, re.S)
if not local:
    sys.exit("source locale introuvable dans le manifeste")
git = f"""      - type: git
        url: https://github.com/chapdel/whathush.git
        tag: v{version}
        commit: {commit}
        x-checker-data:
          type: git
          tag-pattern: ^v([\\d.]+)$"""
manifest = manifest[: local.start()] + git + manifest[local.end() :]
# Les commentaires d'en-tête décrivent l'usage local : le dépôt Flathub n'en a pas besoin.
manifest = re.sub(r"\A(#.*\n)+\n", "", manifest)
open(output, "w", encoding="utf-8").write(manifest)
PY
cp "$root/packaging/flatpak/generated-sources.json" "$root/packaging/flatpak/flathub.json" "$target/"
echo "Fichiers Flathub de la version $version (commit ${commit:0:7}) prêts dans $target."

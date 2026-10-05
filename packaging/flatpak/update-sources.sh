#!/bin/bash
# Régénère generated-sources.json : les dépendances npm du build Flatpak, qui se fait
# hors ligne. À relancer après chaque changement de package-lock.json.
#   pipx install "git+https://github.com/flatpak/flatpak-builder-tools.git#subdirectory=node"
set -euo pipefail
cd "$(dirname "$0")/../.."

"${FLATPAK_NODE_GENERATOR:-flatpak-node-generator}" npm package-lock.json \
  -o packaging/flatpak/generated-sources.json \
  --node-sdk-extension org.freedesktop.Sdk.Extension.node22//26.08

# Les navigateurs de Playwright ne servent qu'aux tests, et aucune dépendance ne les
# télécharge à l'installation : inutile de les faire télécharger au build Flathub.
python3 - <<'PY'
import json, pathlib
path = pathlib.Path("packaging/flatpak/generated-sources.json")
sources = json.loads(path.read_text())
kept = [s for s in sources if "ms-playwright" not in (s.get("dest") or "") and "ms-playwright" not in " ".join(s.get("commands", []))]
path.write_text(json.dumps(kept, indent=4) + "\n")
print(f"{len(kept)} sources ({len(sources) - len(kept)} de Playwright retirées)")
PY

#!/bin/bash
# Prépare le paquet AUR whathush-bin pour la version de package.json, une fois sa
# release GitHub publiée : sommes des sources téléchargées et .SRCINFO, calculés
# dans un conteneur Arch Linux (podman), puisque makepkg n'existe pas hors d'Arch.
#
#   git clone ssh://aur@aur.archlinux.org/whathush-bin.git ../whathush-bin
#   packaging/aur/update.sh ../whathush-bin
#   cd ../whathush-bin && git add PKGBUILD .SRCINFO && git commit -m "Update to X.Y.Z" && git push
#
# WHATHUSH_AUR_LOCAL=1 utilise l'archive de release/ au lieu de la release publiée
# (essai du script avant publication ; les sommes obtenues ne valent pas pour l'AUR).
set -euo pipefail

root=$(cd "$(dirname "$0")/../.." && pwd)
target=$(realpath "${1:?usage : packaging/aur/update.sh <dossier du clone AUR>}")
version=$(node -p "require('$root/package.json').version")
appid=io.github.chapdel.mcdesk
grep -q "^pkgver=$version$" "$root/packaging/aur/PKGBUILD" || { echo "pkgver du PKGBUILD différent de $version : à mettre à jour d'abord" >&2; exit 1; }

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cp "$root/packaging/aur/PKGBUILD" "$work/"
if [ "${WHATHUSH_AUR_LOCAL:-0}" = 1 ]; then
  cp "$root/release/whathush-$version.tar.gz" "$work/"
  cp "$root/packaging/linux/$appid.desktop" "$root/packaging/linux/$appid.metainfo.xml" "$work/"
  cp "$root/build/icons/512x512.png" "$work/$appid.png"
fi

# makepkg refuse root : il travaille sur une copie appartenant à « builder », puis
# root (l'utilisateur courant, hors du conteneur) recopie le résultat.
podman run --rm --security-opt label=disable -v "$work":/out docker.io/library/archlinux:latest bash -c '
  set -e
  pacman -Sy --noconfirm --needed base-devel pacman-contrib >/dev/null 2>&1
  useradd -m builder
  cp -a /out /home/builder/pkg && chown -R builder /home/builder/pkg
  cd /home/builder/pkg
  sudo -u builder updpkgsums >/dev/null 2>&1
  sudo -u builder makepkg --printsrcinfo > .SRCINFO
  cp PKGBUILD .SRCINFO /out/'

cp "$work/PKGBUILD" "$work/.SRCINFO" "$target/"
cp "$work/PKGBUILD" "$root/packaging/aur/PKGBUILD"
echo "PKGBUILD et .SRCINFO $version prêts dans $target ; sommes reportées dans packaging/aur/PKGBUILD."

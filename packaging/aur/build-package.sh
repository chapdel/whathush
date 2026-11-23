#!/bin/bash
# Construit le paquet pacman (.pkg.tar.zst) de packaging/aur/PKGBUILD dans un
# conteneur Arch Linux, et le dépose dans release/ : c'est le fichier d'installation
# Arch Linux / Omarchy joint aux releases (sudo pacman -U ./whathush-…pkg.tar.zst).
#
#   packaging/aur/build-package.sh            sources de release/ (avant publication)
#   packaging/aur/build-package.sh --published sources de la release GitHub publiée,
#                                              vérifiées par les sommes du PKGBUILD
#
# Le paquet porte le nom de l'AUR (whathush-bin) : l'un remplace l'autre.
# Conteneurs : docker, ou podman à défaut (WHATHUSH_CONTAINER pour forcer).
set -euo pipefail

root=$(cd "$(dirname "$0")/../.." && pwd)
version=$(node -p "require('$root/package.json').version")
appid=io.github.chapdel.whathush
grep -q "^pkgver=$version$" "$root/packaging/aur/PKGBUILD" || { echo "pkgver du PKGBUILD différent de $version : à mettre à jour d'abord" >&2; exit 1; }
engine=${WHATHUSH_CONTAINER:-$(command -v docker || command -v podman)}

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cp "$root/packaging/aur/PKGBUILD" "$work/"
if [ "${1:-}" = --published ]; then
  checksums=verify
else
  # Archive et fichiers locaux à la place des téléchargements : les sommes du
  # PKGBUILD sont celles de la release précédente, recalculées sur ces fichiers.
  checksums=update
  cp "$root/release/whathush-$version.tar.gz" "$work/"
  cp "$root/packaging/linux/$appid.desktop" "$root/packaging/linux/$appid.metainfo.xml" "$work/"
  cp "$root/build/icons/512x512.png" "$work/$appid.png"
fi

# makepkg refuse root : il travaille sur une copie appartenant à « builder ».
"$engine" run --rm --security-opt label=disable -e CHECKSUMS="$checksums" -v "$work":/out \
  docker.io/library/archlinux:latest bash -c '
  set -e
  pacman -Syu --noconfirm --needed base-devel pacman-contrib >/dev/null
  useradd -m builder
  cp -a /out /home/builder/pkg && chown -R builder /home/builder/pkg
  cd /home/builder/pkg
  [ "$CHECKSUMS" = update ] && sudo -u builder updpkgsums >/dev/null 2>&1
  sudo -u builder PKGEXT=.pkg.tar.zst makepkg --nodeps --noconfirm >/dev/null
  cp ./*.pkg.tar.zst /out/'

mkdir -p "$root/release"
cp "$work"/*.pkg.tar.zst "$root/release/"
ls "$root/release"/*.pkg.tar.zst

# WhatHush

Client desktop Linux multi-comptes pour WhatsApp Web : plusieurs comptes isolés côte à côte, Snooze, Focus, horaires, veille profonde et intégration au bureau.

- Nom de code : **Whatsapp**. Nom public candidat : **WhatHush**, à valider par une revue de marque avant toute publication (plan §38).
- Projet indépendant, non affilié à WhatsApp LLC ni à Meta Platforms. L’application affiche le WhatsApp Web officiel ; elle ne réimplémente aucun protocole.
- Plan de référence : [`plan-client-whatsapp-linux.md`](plan-client-whatsapp-linux.md). Les numéros §N cités dans le code y renvoient.

## Fonctionnalités

| Fonction | Plan | Comment |
|---|---|---|
| Comptes multiples isolés | §4 | une partition Chromium `persist:wa-<uuid>` par compte, durcie par une seule fabrique |
| Bascule instantanée | §9 | `Ctrl+1…9`, `Ctrl+Tab`, `Ctrl+Shift+Tab`, y compris quand WhatsApp a le focus ; ordre réglable par glisser-déposer |
| Pas d’accusés de lecture parasites | §9 | seule la vue affichée est visible ; les autres sont `hidden` pour leur page |
| Notifications par compte | §10 | `window.Notification` intercepté, nom du compte en préfixe, clic → bon compte et bonne conversation |
| Non-lus et badge global | §11 | titre de la page, total dans la barre latérale, le tray et le lanceur |
| Snooze | §12 | 30 min, 1 h, 4 h, demain matin, lundi, jusqu’à une date, jusqu’à réactivation ; son de la page coupé |
| Horaires et Focus | §13 à §15 | priorités manuel > Focus > horaire ; changements d’heure et de fuseau gérés sans redémarrer |
| Veille profonde | §16 | la vue est détruite, la session reste ; réveil sans QR code ; jamais pendant un appel |
| Ressources | §17 | RAM par compte, veille automatique optionnelle, suggestion de mise en veille au-delà de 2 Go, démarrage échelonné |
| Appels | §18, §19 | micro, caméra et partage d’écran détectés, appel signalé dans la barre latérale et le tray ; partage via le portail sous Wayland, avec choix de l’écran sous X11 |
| Tray | §21 | menu complet ; détection de GNOME sans AppIndicator et repli |
| Liens | §23 | navigateur système pour http/https/mailto, schémas dangereux bloqués, `wa.me` → choix du compte |
| Téléchargements | §22 | dossier Téléchargements, jamais d’écrasement, jamais d’ouverture automatique |
| Reprise après crash | §32 | recréation 1 s, 5 s, 30 s, puis arrêt et bouton « Recharger » |
| Détection QR / déconnexion | §35 | adaptateur isolé, lecture seule, mode dégradé s’il ne répond pas |

Ajoutées en 0.2.0 ([plan complémentaire](docs/plan-fonctionnalites-complementaires.md), F1 à F14) :

| Fonction | Plan | Comment |
|---|---|---|
| Français et anglais | F12 | langue du système par défaut, réglable ; catalogue typé ; entrée de bureau et AppStream traduites |
| Presse-papiers | F13 | texte et images, « Copier l’image », « Coller comme texte brut » (Ctrl+Maj+V) |
| « En cours de lecture » | F14 | message vocal suivi par l’API standard, Pause / Reprendre dans la barre latérale et le tray, MPRIS ; le Snooze ne coupe plus une lecture lancée par l’utilisateur |
| Zoom et raccourcis | F1 | zoom par compte (Ctrl+ / Ctrl− / Ctrl+0, Ctrl+molette), taille de l’interface, feuille des raccourcis (Ctrl+/) |
| Téléchargements | F2 | historique avec rétention (ou aucun), ouvrir, afficher dans le dossier, fichier introuvable signalé |
| Rapport de diagnostic | F3 | fichier caviardé à joindre soi-même ; rien n’est envoyé |
| Non-lus sur l’icône du tray | F4 | nombre (1 à 9, 9+), point ou rien |
| Correcteur hors ligne | F5 | dictionnaires français et anglais embarqués ; autres langues téléchargées depuis Google seulement sur choix explicite |
| Verrouillage par code | F6 | au démarrage, fenêtre masquée, inactivité, verrouillage de la session ; délai croissant ; « Code oublié » efface les sessions |
| Voile de confidentialité | F7 | Ctrl+Maj+H, perte de focus, partage d’écran ; flou message par message en option expérimentale |
| Autorisations par compte | F8 | micro, caméra, localisation, partage d’écran : autoriser, demander, refuser |
| Proxy | F9 | HTTP, HTTPS, SOCKS5, global ou par compte, avec identifiants chiffrés ; relais local pour SOCKS5 authentifié |
| Photos des notifications | F10 | téléchargées par le processus principal depuis `*.whatsapp.net` seulement |
| Thème de WhatsApp | F11 | aide, une fois par compte, pour régler WhatsApp sur « Défaut du système » |

## Installer

Les paquets se construisent dans `release/` (voir « Paquets »).

```bash
# AppImage
chmod +x release/WhatHush-0.2.0-x86_64.AppImage && ./release/WhatHush-0.2.0-x86_64.AppImage
# Debian / Ubuntu (installe aussi le profil AppArmor d’Ubuntu 24.04+)
sudo apt install ./release/whathush_0.2.0_amd64.deb
# Fedora
sudo dnf install ./release/whathush-0.2.0.x86_64.rpm
# Flatpak (paquet local)
flatpak install --user release/WhatHush-0.2.0.flatpak
```

Au premier lancement, ajoutez un compte puis scannez le QR code depuis le téléphone (WhatsApp → Appareils connectés). Chaque compte occupe un appareil lié (4 au maximum par numéro).

## Développer

```bash
npm install
npm start            # construit puis lance l’application sur le vrai web.whatsapp.com
npm run demo         # la lance sur une fausse page WhatsApp locale (sans compte)
```

Données : `~/.config/mcdesk/` (dossier en 0700 ; `~/.config/mcdesk-demo/` pour la démo). Journaux : `logs/app.log`, sans aucun contenu de message.

## Tests

| Commande | Ce qu’elle vérifie |
|---|---|
| `npm run typecheck` | types de tout le projet |
| `npm test` | 201 tests unitaires : politique, expiration Snooze/Focus, fuseaux, machine à états, gestionnaire de comptes, liens, stockage et migrations v1 → v2, menus, IPC, protocole `app://`, autostart ; catalogues de langue, raccourcis, lecture des médias, historique, autorisations, verrou, rapport, proxy et relais SOCKS5 (contre un faux proxy amont), identifiants chiffrés, voile, rapport caviardé, menu contextuel, menus du tray, photos, correcteur |
| `npm run test:e2e` | 47 tests de bout en bout (Playwright pilote Electron, sans fenêtre, contre la fausse page), dont clavier, dialogues, resize, thèmes et HiDPI, interface en anglais, presse-papiers, lecture, zoom, téléchargements, rapport, verrou, voile, autorisations, proxy HTTP et SOCKS5, photos ; captures dans `test-results/screens/` |
| `npm run test:native` | la règle de visibilité du §9, mesurée sans Playwright (Playwright émule le focus des pages et fausserait le résultat), y compris pendant le verrouillage, et le Snooze d’un son lancé par une page cachée |
| `npm run build && ./node_modules/.bin/playwright test --config playwright.native.config.ts` | fenêtres et tray sur le bureau courant, backends Wayland et X11 selon la session disponible ; utilise des comptes locaux de test |
| `cd lab && npm run smoke` | le Feasibility Lab (phase 0) |
| `npm run icons` | régénère les icônes du tray avec nombre (ImageMagick) |

L’[audit UI/UX](docs/ui-ux-audit.md) décrit les défauts observés, les corrections et les limites de validation. Le backend X11 lancé depuis KDE Wayland passe par XWayland ; les captures automatisées utilisent la fausse page WhatsApp.

## Paquets

```bash
npm run build && npx electron-builder --linux AppImage tar.gz     # sur la machine
# .deb et .rpm : fpm a besoin de libcrypt.so.1 (absente de Fedora 44) et rpmbuild,
# d’où un conteneur :
podman run --rm --security-opt label=disable -v "$PWD":/work -w /work \
  registry.fedoraproject.org/fedora:44 bash -c \
  "dnf install -y nodejs rpm-build libxcrypt-compat && npx electron-builder --linux rpm deb --prepackaged release/linux-unpacked"
# Flatpak
# --disable-cache : sans lui, flatpak-builder peut réutiliser un ancien build en cache
flatpak run org.flatpak.Builder --user --force-clean --disable-cache --state-dir=release/.flatpak-builder \
  --repo=release/flatpak-repo release/flatpak-build packaging/flatpak/io.github.chapdel.mcdesk.yml
flatpak build-bundle release/flatpak-repo release/WhatHush-0.2.0.flatpak io.github.chapdel.mcdesk
```

`whathush --self-test` démarre réellement l’application empaquetée (fuses actives), vérifie que l’interface s’affiche et imprime un bilan JSON, dont l’empreinte du build (`build` : commit, date). Comparer cette empreinte à `dist/build-info.json` garantit que le paquet contient le build attendu, et pas une version restée en cache.

| Format | Vérification faite |
|---|---|
| AppImage | auto-test avec rendu de l’interface |
| `.deb` | installé dans Ubuntu 24.04 : dépendances, fichiers, entrée de bureau, profil AppArmor, auto-test avec rendu |
| `.rpm` | installé dans Fedora 44 : dépendances, entrée de bureau valide, auto-test avec rendu |
| AUR (`packaging/aur/PKGBUILD`) | `makepkg` (sommes vérifiées) puis `pacman -U` dans Arch Linux, auto-test avec rendu |
| Flatpak | construit avec la base Electron 25.08 et zypak, installé, auto-test avec rendu dans le vrai bac à sable, désinstallé |

Le binaire empaqueté porte les fuses Electron du §26 (pas de `RunAsNode`, ni de `NODE_OPTIONS`, ni de `--inspect` ; chiffrement des cookies ; application chargée seulement depuis l’ASAR).

## Architecture

```text
src/
  shared/              constantes, identité, schémas zod, contrat IPC, formats d’affichage
  main/core/           logique pure, sans Electron : politique, fuseaux, états, liens,
                       permissions, menus, ressources, adaptateur
  main/storage/        fichiers de configuration : écriture atomique, migrations
  main/sessions/       fabrique de sessions durcies (§4, §26)
  main/views/          WebContentsView, règle de visibilité (§9)
  main/accounts/       cycle de vie des comptes, reprise après crash (§2, §32)
  main/notifications/  interception et affichage (§10)
  main/policy/         Snooze, Focus, horaires appliqués (§12 à §15)
  main/links/          routage des liens et des popups (§23)
  main/whatsapp-adapter/  seul code qui lit le contenu de WhatsApp (§35)
  main/security/       verrouillage par code (F6)
  main/privacy/        voile de confidentialité (F7)
  main/proxy/          proxy et relais SOCKS5 local (F9)
  main/diagnostic/     rapport de diagnostic (F3)
  shared/i18n/         catalogues français et anglais (F12)
  main/app.ts          assemblage, état de l’UI, commandes, IPC
  preload/             coque (API typée) et vues WhatsApp (interception)
  renderer/            interface React : barre latérale, accueil, modales, paramètres
tests/                 unitaires, e2e (fausse page WhatsApp), natifs
packaging/             entrée de bureau, AppStream, PKGBUILD, manifeste Flatpak
lab/                   Feasibility Lab (phase 0), projet séparé
```

## Plan complémentaire

[`docs/plan-fonctionnalites-complementaires.md`](docs/plan-fonctionnalites-complementaires.md) : les quatorze fonctions de la 0.2.0, ce qui a été fait, les écarts avec le plan et ce qui reste à confirmer au Lab.

## Ce qui reste de votre côté

1. **Tests avec de vrais comptes** (`lab/README.md`, `lab/RESULTS.md`) : appels, notifications réelles, latence, accusés de lecture, déconnexion à distance. Ils confirmeront les points marqués expérimentaux : la reconnaissance des notifications d’appel (mode « appels uniquement »), les repères de l’interface des conversations et du flou des messages dans l’adaptateur, la forme des photos de notification, MPRIS, le verrouillage de session sous GNOME et KDE, le trousseau pour les identifiants de proxy (liste complète dans le plan complémentaire).
2. **Licence** : à choisir (MIT, GPL-3.0-or-later…). Les paquets indiquent « non licencié » en attendant.
3. **Identifiant de l’application** : `io.github.chapdel.mcdesk` suppose le compte GitHub `chapdel` ; à confirmer avant toute publication (il fixe le dossier de données Flatpak).
4. **Revue de marque** du nom WhatHush (§38).
5. **Publication** : dépôt GitHub, releases signées, Flathub (captures d’écran AppStream requises), dépôts APT/RPM, AUR. Rien n’a été publié.

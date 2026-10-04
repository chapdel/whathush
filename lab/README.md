# Feasibility Lab — phase 0

Prototype **jetable** pour dérouler la matrice du §40 du plan (`../plan-client-whatsapp-linux.md`) avant d’écrire la vraie application. Il n’a pas d’UI soignée : une barre latérale, les vues WhatsApp, et un journal en bas.

Ce que le lab met déjà en œuvre (repris du plan) :

| Mécanisme | Plan | Où regarder |
|---|---|---|
| Une partition `persist:wa-<uuid>` par compte, durcie par une seule fabrique | §4 | `sessionFor()` dans `src/main.ts` |
| User-Agent Chrome sans « Electron » | §5 | événement `page-env` |
| Interception de `window.Notification` + clic → bon compte | §10 | `src/preload-whatsapp.ts`, événements `notification`, `notification-click` |
| Compteur de non-lus via le titre | §11 | événement `unread` |
| Snooze simple (tout couper) | §12 | bouton Snooze, événement `notification-dropped-snooze` |
| Visibilité des comptes cachés (accusés de lecture) | §9 | événement `page-visibility` (⚠ si une page cachée se croit visible) |
| Veille / réveil, RAM par compte | §16, §17 | boutons, `logs/metrics-*.csv` |
| Reprise après crash avec backoff | §32 | bouton « Simuler crash », événement `render-process-gone` |
| Liste blanche des permissions, refus journalisés | §26 | événements `permission-request`, `permission-check` |
| Partage d’écran via `desktopCapturer` / portail | §20 | événements `display-media-*` |
| Liens externes filtrés (http, https, mailto) | §23 | événements `open-external`, `blocked-url` |
| Détection micro / caméra / partage (wrapper `getUserMedia`) | §19 | événement `media`, icônes 🎤 📷 🖥 |

## Installation

```bash
cd lab
npm install
```

Node 22 ou plus récent.

## Commandes

| Commande | Usage |
|---|---|
| `npm start` | vrais comptes WhatsApp, plateforme par défaut |
| `npm run start:wayland` | Wayland natif + IME (`--enable-wayland-ime`) |
| `npm run start:x11` | X11 / XWayland |
| `npm run start:fake` | fausse page WhatsApp locale (pas de vrai compte) |
| `npm run smoke` | test automatique contre la fausse page, sans fenêtre |
| `npm run smoke:visible` | idem, avec la fenêtre (vraie session graphique) |
| `npm run probe` | charge le vrai web.whatsapp.com **sans compte** dans un dossier jetable : User-Agent, service worker, permissions demandées, capture d’écran (`LAB_PROBE_OUT=<dossier>`) |
| `LAB_UA=electron npm run probe` | idem avec le User-Agent par défaut d’Electron, pour comparaison |

Variables d’environnement :

| Variable | Effet |
|---|---|
| `LAB_PERMISSIVE=1` | accorde toutes les permissions (toujours journalisées) : utile si WhatsApp casse à cause d’un refus |
| `LAB_LOG_CONTENT=1` | journalise le titre et le texte des notifications. **Uniquement avec des comptes de test** |
| `LAB_TARGET_URL=…` | charge une autre URL que `https://web.whatsapp.com/` |

Raccourcis : `Ctrl+1…9` et `Ctrl+Tab` pour changer de compte, `F12` pour les DevTools du compte affiché, clic droit → « Inspecter l’élément ».

## Données et journaux

| Mode | Dossier |
|---|---|
| vrais comptes | `~/.config/feasibility-lab/` |
| fausse page | `~/.config/feasibility-lab-fake/` |
| smoke test | dossier temporaire, supprimé si tout passe |

Dans chaque dossier, `logs/` contient, pour chaque lancement :

- `lab-<date>.jsonl` : un événement JSON par ligne ;
- `metrics-<date>.csv` : RAM et CPU par compte toutes les 5 s, plus le total de l’application.

Exemples :

```bash
grep '"event":"notification"' ~/.config/feasibility-lab/logs/lab-*.jsonl
grep '"level":"warn"' ~/.config/feasibility-lab/logs/lab-*.jsonl
```

Le dossier `~/.config/feasibility-lab/Partitions/` contient les sessions WhatsApp : quiconque le copie peut réutiliser les comptes. À la fin du lab, supprimer les comptes dans le lab **et** les appareils liés depuis les téléphones (WhatsApp → Appareils connectés), puis supprimer le dossier.

## Protocole de test

Reporter chaque résultat dans `RESULTS.md`. Chaque compte ajouté occupe un « appareil lié » sur le téléphone (4 maximum par numéro).

| # | Test | Comment faire | Quoi regarder |
|---|---|---|---|
| 1 | Chargement | `npm start`, ajouter un compte, scanner le QR | pas d’écran « navigateur non supporté » ; `page-env` sans `problems` |
| 2 | Appel audio | d’abord dans Chrome sur web.whatsapp.com, puis dans le lab : appeler et se faire appeler depuis un autre téléphone | `permission-request` media, `media start/stop`, `window-open-allowed` (popup d’appel ?) |
| 3 | Interception | recevoir un message sur un compte **caché** | notification système préfixée par le nom du compte. Une notification **sans préfixe** a contourné le proxy : chercher `sw-notification` |
| 4 | Clic | cliquer la notification | le lab affiche le bon compte et WhatsApp ouvre la conversation |
| 5 | Accusés de lecture | compte B : ouvrir la conversation avec X ; passer sur A ; X envoie un message | sur le téléphone de X, pas de coches bleues tant qu’on ne revient pas sur B ; `page-visibility` de B = `hidden` |
| 6 | Multi-partitions | 2, 3 puis 5 comptes (5 numéros) | chaque compte reste connecté, aucun ne déconnecte un autre |
| 7 | Redémarrage | fermer puis relancer le lab | aucun QR demandé |
| 8 | Veille / réveil | « Mettre en veille », attendre 10 s, « Réveiller » | baisse de RAM dans `metrics-*.csv` ; aucun QR au réveil |
| 9 | Latence en arrière-plan | laisser un compte caché 1 h, puis 8 h ; envoyer un message depuis un autre téléphone | écart entre l’envoi et l’horodatage de `notification` dans le journal (< 5 s) |
| 10 | Bascule | `Ctrl+1` / `Ctrl+2` répétés | ressenti (pas de flash) ; `switch` donne le temps côté main seulement |
| 11 | RAM | 1, 3, 5 comptes, 10 min de stabilisation chacun | `metrics-*.csv` |
| 12 | Message vocal | enregistrer un vocal | `permission-request` media audio accordé, 🎤 pendant l’enregistrement |
| 13 | Coller / glisser | copier une image puis `Ctrl+V` dans une conversation ; glisser un fichier | `permission-check` refusés (`clipboard-read` ?) |
| 14 | Vidéo | appel vidéo | 📷, image dans les deux sens |
| 15 | Partage d’écran | pendant un appel vidéo, partager l’écran ; avec `start:wayland` puis `start:x11` | `display-media-request` / `display-media-sources` ; nombre de sélecteurs affichés |
| 16 | Reconnaissance des appels | appel entrant sur un compte caché, avec `LAB_LOG_CONTENT=1` sur un compte de test | texte et `tag` de la notification d’appel ; `audio` audible=true prolongé |
| 17 | Déconnexion à distance | depuis le téléphone : Appareils connectés → déconnecter le lab | ce que montre la vue ; aucun événement générique attendu (confirme le besoin de l’adaptateur, §35) |
| 18 | Suspend / resume | mettre le PC en veille 10 min ou plus | `system-suspend`, `system-resume`, `post-resume-check` 30 s après ; message reçu après le réveil |
| 19 | IME / emoji | `start:wayland` puis `start` ; saisie avec fcitx5 / ibus, sélecteur d’emoji du bureau | caractères saisis correctement |
| 20 | Endurance 72 h | laisser tourner avec 3 comptes | courbe de RAM dans `metrics-*.csv` |
| 21 | GNOME sans AppIndicator | — | hors lab : le lab n’a pas de tray, à tester en phase 3 |

Les tests propres à GNOME (et les variantes X11 natives) demandent une autre machine ou une VM : ce poste est sous KDE Plasma / Wayland.

## Constats de mise en place

Sonde sur le vrai web.whatsapp.com, sans compte (2026-10-04) :

- **User-Agent d’Electron par défaut : refusé.** WhatsApp affiche « WhatsApp works with Google Chrome 100+ ». Avec le User-Agent du §5 (Chrome 152, sans « Electron ») : écran QR normal. Les Client Hints (`Not?A_Brand`, `Chromium`) ne mentionnent pas Electron dans les deux cas.
- L’override de `window.Notification` est en place avant le moindre script WhatsApp (`readyState` = `loading`, 0 script).
- WhatsApp enregistre un service worker (`https://web.whatsapp.com/sw.js`) qui contrôle la page dès le chargement.
- Au chargement, WhatsApp demande `persistent-storage` (désormais accordée : elle protège la session contre l’éviction du stockage) et vérifie `background-sync` (refusée pour l’instant, à surveiller).
- Electron 44 tourne en **Wayland natif par défaut** : il démarre sans `DISPLAY`, alors qu’en forçant X11 il échoue.

Mécanique du lab :

- Smoke test contre la fausse page : 18/18 (User-Agent, Client Hints, override de `Notification` avant les scripts de la page, interception, non-lus, visibilité, clic, isolation du stockage, veille/réveil, reprise après crash, UI de la coque).
- `webContents.forcefullyCrashRenderer()` n’est pas utilisable ici : le processus de rendu affiche « Crashing because hung » mais reste vivant (plus de 15 s observées) et `render-process-gone` n’arrive pas. Cause non vérifiée (probablement le traitement du vidage mémoire par le système). Le lab simule donc les crashs par `SIGKILL`. Conséquence pour le §32 : un vrai crash pourrait être détecté avec retard sur Fedora ; à surveiller.

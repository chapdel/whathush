// Identité de l'application.
//
// - PRODUCT_NAME : nom affiché. Nom public candidat, à valider par la revue de
//   marque avant toute publication ; seul ce fichier change en cas de renommage.
// - APP_ID et DATA_DIR_NAME portent les données de l'utilisateur (dossier de
//   configuration, identifiant Flatpak) : neutres et stables, ils ne suivent pas
//   le nom affiché. APP_ID est provisoire tant que le compte GitHub qui hébergera
//   le projet n'est pas confirmé (format io.github.<compte>.<id>, exigé par Flathub).

export const PRODUCT_NAME = "WhatHush";
export const CODENAME = "Whatsapp";
export const EXECUTABLE_NAME = "whathush";
export const APP_ID = "io.github.chapdel.mcdesk";
export const DATA_DIR_NAME = "mcdesk";
/** Page des tickets, provisoire comme APP_ID tant que le dépôt n'est pas confirmé. */
export const ISSUES_URL = "https://github.com/chapdel/whathush/issues/new";

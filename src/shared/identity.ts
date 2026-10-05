// Identité de l'application.
//
// - PRODUCT_NAME : nom affiché ; seul ce fichier change en cas de renommage.
// - APP_ID suit le dépôt GitHub (io.github.<compte>.<dépôt>, exigé par Flathub) ;
//   il fixe le dossier de données du Flatpak et ne doit plus changer.
// - DATA_DIR_NAME porte le dossier de configuration hors Flatpak : stable, il ne
//   suit ni le nom affiché ni l'identifiant.

export const PRODUCT_NAME = "WhatHush";
export const CODENAME = "Whatsapp";
export const EXECUTABLE_NAME = "whathush";
export const APP_ID = "io.github.chapdel.whathush";
export const DATA_DIR_NAME = "mcdesk";
/** Page des tickets du dépôt GitHub. */
export const ISSUES_URL = "https://github.com/chapdel/whathush/issues/new";

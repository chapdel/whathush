// Opérations pures sur la liste des comptes. Chaque fonction renvoie un
// nouveau fichier ; l'écriture sur disque est l'affaire du Store.

import { LABEL_MAX_LENGTH, leastUsedAccountColor, MAX_ACCOUNTS, partitionFor } from "../../shared/constants";
import { t } from "../../shared/i18n";
import type { AccountConfig, AccountPermissions, AccountsFile, NotificationSettings } from "../../shared/schemas";

export const DEFAULT_NOTIFICATIONS: NotificationSettings = {
  enabled: true,
  sound: true,
  showPreview: true,
  badge: true,
  includeInTotal: true,
  badgeWhileSnoozed: true
};

/** Appels permis, localisation refusée, partage d'écran toujours demandé. */
export const DEFAULT_PERMISSIONS: AccountPermissions = {
  microphone: "allow",
  camera: "allow",
  location: "deny",
  screenShare: "ask"
};

export function emptyAccountsFile(): AccountsFile {
  return { schemaVersion: 2, accounts: [], pendingPartitionDeletion: [] };
}

export interface NewAccountInput {
  label: string;
  color?: string;
  icon?: string;
}

export function addAccount(
  file: AccountsFile,
  input: NewAccountInput,
  now: Date,
  id: string = globalThis.crypto.randomUUID()
): { file: AccountsFile; account: AccountConfig } {
  if (file.accounts.length >= MAX_ACCOUNTS) throw new Error(t("error.tooManyAccounts", { max: MAX_ACCOUNTS }));
  const label = input.label.trim().slice(0, LABEL_MAX_LENGTH);
  if (!label) throw new Error(t("error.emptyLabel"));
  const timestamp = now.toISOString();
  const account: AccountConfig = {
    id,
    label,
    color: input.color ?? leastUsedAccountColor(file.accounts.map((account) => account.color)),
    ...(input.icon ? { icon: input.icon } : {}),
    order: file.accounts.length,
    partition: partitionFor(id),
    notifications: { ...DEFAULT_NOTIFICATIONS },
    sleeping: false,
    createdAt: timestamp,
    lastOpenedAt: timestamp,
    zoomPercent: 100,
    permissions: { ...DEFAULT_PERMISSIONS },
    proxyMode: "inherit",
    proxy: null,
    themeHintShown: false
  };
  return { file: { ...file, accounts: [...file.accounts, account] }, account };
}

/** Retire le compte et programme la suppression de sa partition au prochain démarrage. */
export function removeAccount(file: AccountsFile, id: string): AccountsFile {
  if (!file.accounts.some((account) => account.id === id)) return file;
  const accounts = file.accounts.filter((account) => account.id !== id).map((account, order) => ({ ...account, order }));
  const pending = file.pendingPartitionDeletion.includes(id)
    ? file.pendingPartitionDeletion
    : [...file.pendingPartitionDeletion, id];
  return { ...file, accounts, pendingPartitionDeletion: pending };
}

/** Réordonne selon la liste d'identifiants donnée ; les comptes absents gardent leur ordre relatif, à la fin. */
export function reorderAccounts(file: AccountsFile, orderedIds: readonly string[]): AccountsFile {
  const byId = new Map(file.accounts.map((account) => [account.id, account]));
  const listed = orderedIds.flatMap((id) => {
    const account = byId.get(id);
    if (!account) return [];
    byId.delete(id);
    return [account];
  });
  const rest = file.accounts.filter((account) => byId.has(account.id));
  return { ...file, accounts: [...listed, ...rest].map((account, order) => ({ ...account, order })) };
}

export function updateAccount(
  file: AccountsFile,
  id: string,
  update: (account: AccountConfig) => AccountConfig
): AccountsFile {
  return { ...file, accounts: file.accounts.map((account) => (account.id === id ? update(account) : account)) };
}

/** Comptes par ordre d'affichage : le n-ième répond à Ctrl+n. */
export function accountsInOrder(file: AccountsFile): AccountConfig[] {
  return [...file.accounts].sort((a, b) => a.order - b.order);
}

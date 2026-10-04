// Opérations pures sur la liste des comptes (§6 à §8). Chaque fonction renvoie un
// nouveau fichier ; l'écriture sur disque est l'affaire du Store.

import { LABEL_MAX_LENGTH, MAX_ACCOUNTS, partitionFor } from "../../shared/constants";
import type { AccountConfig, AccountsFile, NotificationSettings } from "../../shared/schemas";

export const DEFAULT_NOTIFICATIONS: NotificationSettings = {
  enabled: true,
  sound: true,
  showPreview: true,
  badge: true,
  includeInTotal: true,
  badgeWhileSnoozed: true
};

export function emptyAccountsFile(): AccountsFile {
  return { schemaVersion: 1, accounts: [], pendingPartitionDeletion: [] };
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
  if (file.accounts.length >= MAX_ACCOUNTS) throw new Error(`limite de ${MAX_ACCOUNTS} comptes atteinte`);
  const label = input.label.trim().slice(0, LABEL_MAX_LENGTH);
  if (!label) throw new Error("le nom du compte est vide");
  const timestamp = now.toISOString();
  const account: AccountConfig = {
    id,
    label,
    ...(input.color ? { color: input.color } : {}),
    ...(input.icon ? { icon: input.icon } : {}),
    order: file.accounts.length,
    partition: partitionFor(id),
    notifications: { ...DEFAULT_NOTIFICATIONS },
    sleeping: false,
    createdAt: timestamp,
    lastOpenedAt: timestamp
  };
  return { file: { ...file, accounts: [...file.accounts, account] }, account };
}

/** Retire le compte et programme la suppression de sa partition au prochain démarrage (§8). */
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

/** Comptes par ordre d'affichage : le n-ième répond à Ctrl+n (§9). */
export function accountsInOrder(file: AccountsFile): AccountConfig[] {
  return [...file.accounts].sort((a, b) => a.order - b.order);
}

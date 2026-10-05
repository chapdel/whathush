import { describe, expect, it } from "vitest";
import { accountsInOrder, addAccount, emptyAccountsFile, removeAccount, reorderAccounts } from "../../src/main/core/accounts";
import { AccountsFileSchema } from "../../src/shared/schemas";

const NOW = new Date("2026-10-04T12:00:00Z");
const IDS = [
  "3e6d9227-1b2c-4d3e-8f40-1a2b3c4d5e6f",
  "c41f7751-2c3d-4e4f-9a51-2b3c4d5e6f70",
  "097ac32b-3d4e-4f50-ab62-3c4d5e6f7081"
] as const;

function threeAccounts() {
  let file = emptyAccountsFile();
  for (const [index, label] of ["Personnel", "Travail", "Support"].entries()) {
    file = addAccount(file, { label }, NOW, IDS[index]).file;
  }
  return file;
}

describe("addAccount", () => {
  it("crée un compte valide avec sa partition et son ordre", () => {
    const { file, account } = addAccount(emptyAccountsFile(), { label: "  Travail  ", color: "#25a366" }, NOW, IDS[0]);
    expect(account).toMatchObject({
      id: IDS[0],
      label: "Travail",
      color: "#25a366",
      order: 0,
      partition: `persist:wa-${IDS[0]}`,
      sleeping: false,
      createdAt: "2026-10-04T12:00:00.000Z"
    });
    expect(AccountsFileSchema.safeParse(file).success).toBe(true);
  });

  it("refuse un nom vide", () => {
    expect(() => addAccount(emptyAccountsFile(), { label: "   " }, NOW)).toThrow();
  });

  it("génère des identifiants distincts", () => {
    const first = addAccount(emptyAccountsFile(), { label: "A" }, NOW);
    const second = addAccount(first.file, { label: "B" }, NOW);
    expect(second.account.id).not.toBe(first.account.id);
    expect(AccountsFileSchema.safeParse(second.file).success).toBe(true);
  });
});

describe("removeAccount", () => {
  it("retire le compte, renumérote et programme la purge de la partition", () => {
    const file = removeAccount(threeAccounts(), IDS[0]);
    expect(file.accounts.map((account) => [account.label, account.order])).toEqual([
      ["Travail", 0],
      ["Support", 1]
    ]);
    expect(file.pendingPartitionDeletion).toEqual([IDS[0]]);
    expect(AccountsFileSchema.safeParse(file).success).toBe(true);
  });

  it("ignore un identifiant inconnu", () => {
    const file = threeAccounts();
    expect(removeAccount(file, "00000000-0000-4000-8000-000000000000")).toBe(file);
  });
});

describe("reorderAccounts", () => {
  it("applique l'ordre donné et met les oubliés à la fin", () => {
    const file = reorderAccounts(threeAccounts(), [IDS[2], IDS[0]]);
    expect(accountsInOrder(file).map((account) => account.label)).toEqual(["Support", "Personnel", "Travail"]);
  });
});

describe("AccountsFileSchema", () => {
  it("refuse une partition qui ne correspond pas à l'identifiant", () => {
    const file = threeAccounts();
    const tampered = { ...file, accounts: file.accounts.map((account, index) => (index === 0 ? { ...account, partition: "persist:autre" } : account)) };
    expect(AccountsFileSchema.safeParse(tampered).success).toBe(false);
  });

  it("refuse les identifiants en double et les clés inconnues", () => {
    const file = threeAccounts();
    const first = file.accounts[0]!;
    expect(AccountsFileSchema.safeParse({ ...file, accounts: [...file.accounts, first] }).success).toBe(false);
    expect(AccountsFileSchema.safeParse({ ...file, extra: true }).success).toBe(false);
  });
});

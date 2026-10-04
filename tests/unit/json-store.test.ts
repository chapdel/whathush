import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { addAccount } from "../../src/main/core/accounts";
import { accountsDocument } from "../../src/main/storage/documents";
import { readJsonDocument, writeJsonDocument, type JsonDocument } from "../../src/main/storage/json-store";

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "json-store-test-"));
  file = path.join(dir, "accounts.json");
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("readJsonDocument / writeJsonDocument", () => {
  it("renvoie les valeurs par défaut si le fichier n'existe pas", () => {
    expect(readJsonDocument(file, accountsDocument)).toEqual({ status: "missing", data: accountsDocument.defaults() });
  });

  it("relit ce qu'il a écrit, en 0600 et sans fichier temporaire résiduel", () => {
    const { file: data } = addAccount(accountsDocument.defaults(), { label: "Travail" }, new Date("2026-10-04T12:00:00Z"));
    writeJsonDocument(file, accountsDocument, data);
    expect(readJsonDocument(file, accountsDocument)).toEqual({ status: "ok", data });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(dir)).toEqual(["accounts.json"]);
  });

  it("refuse d'écrire des données invalides", () => {
    const invalid = { ...accountsDocument.defaults(), schemaVersion: 2 } as unknown as ReturnType<typeof accountsDocument.defaults>;
    expect(() => writeJsonDocument(file, accountsDocument, invalid)).toThrow();
    expect(fs.existsSync(file)).toBe(false);
  });

  it("met de côté un fichier JSON illisible au lieu de l'écraser", () => {
    fs.writeFileSync(file, "{ pas du json");
    const result = readJsonDocument(file, accountsDocument, new Date("2026-10-04T12:00:00Z"));
    expect(result.status).toBe("corrupt");
    if (result.status === "corrupt") {
      expect(result.data).toEqual(accountsDocument.defaults());
      expect(fs.readFileSync(result.backupPath, "utf8")).toBe("{ pas du json");
    }
  });

  it("met de côté un fichier qui ne respecte pas le schéma", () => {
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, accounts: [{ id: "x" }], pendingPartitionDeletion: [] }));
    const result = readJsonDocument(file, accountsDocument);
    expect(result.status).toBe("corrupt");
  });

  it("signale un fichier d'une version plus récente sans le toucher", () => {
    const content = JSON.stringify({ schemaVersion: 7, accounts: [] });
    fs.writeFileSync(file, content);
    expect(readJsonDocument(file, accountsDocument)).toMatchObject({ status: "too-new", version: 7 });
    expect(fs.readFileSync(file, "utf8")).toBe(content);
    expect(fs.readdirSync(dir)).toEqual(["accounts.json"]);
  });
});

describe("migrations", () => {
  const Schema = z.strictObject({ schemaVersion: z.literal(2), name: z.string(), tags: z.array(z.string()) });
  const doc: JsonDocument<z.infer<typeof Schema>> = {
    schema: Schema,
    currentVersion: 2,
    migrations: {
      0: (data) => ({ ...data, schemaVersion: 1, name: String(data.title ?? ""), title: undefined }),
      1: (data) => ({ schemaVersion: 2, name: data.name, tags: [] })
    },
    defaults: () => ({ schemaVersion: 2, name: "", tags: [] })
  };

  it("enchaîne les migrations jusqu'à la version courante", () => {
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 0, title: "ancien" }));
    expect(readJsonDocument(file, doc)).toEqual({ status: "migrated", data: { schemaVersion: 2, name: "ancien", tags: [] } });
  });

  it("considère comme corrompu un fichier dont la migration est absente", () => {
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: -1 }));
    expect(readJsonDocument(file, doc).status).toBe("corrupt");
  });

  it("détecte une migration qui oublie de changer schemaVersion", () => {
    const broken = { ...doc, migrations: { ...doc.migrations, 1: (data: Record<string, unknown>) => data } };
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, name: "x" }));
    const result = readJsonDocument(file, broken);
    expect(result.status).toBe("corrupt");
    if (result.status === "corrupt") expect(result.error).toContain("schemaVersion");
  });
});

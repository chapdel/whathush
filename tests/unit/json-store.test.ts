import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { addAccount } from "../../src/main/core/accounts";
import { accountsDocument, preferencesDocument } from "../../src/main/storage/documents";
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
    const invalid = { ...accountsDocument.defaults(), schemaVersion: 3 } as unknown as ReturnType<typeof accountsDocument.defaults>;
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

// Fichiers v1 réels, tels qu'écrits par la version 0.1.0.
describe("migration v1 → v2 des fichiers de l'application", () => {
  const V1_ACCOUNTS = {
    schemaVersion: 1,
    accounts: [
      {
        id: "4f0c1d2e-3b4a-4c5d-8e6f-7a8b9c0d1e2f",
        label: "Travail",
        color: "#5a5fc4",
        icon: "briefcase",
        order: 0,
        partition: "persist:wa-4f0c1d2e-3b4a-4c5d-8e6f-7a8b9c0d1e2f",
        notifications: { enabled: true, sound: true, showPreview: false, badge: true, includeInTotal: true, badgeWhileSnoozed: true },
        manualOverride: { mode: "snoozed", until: null },
        sleeping: false,
        createdAt: "2026-10-04T08:00:00.000Z",
        lastOpenedAt: "2026-10-04T09:00:00.000Z"
      }
    ],
    pendingPartitionDeletion: []
  };
  const V1_PREFERENCES = {
    schemaVersion: 1,
    launchAtLogin: false,
    closeToTray: true,
    startMinimized: false,
    theme: "dark",
    spellcheckLanguages: ["fr"],
    handleWhatsappLinks: false,
    sidebarCollapsed: true,
    askDownloadLocation: false,
    onboardingDone: true
  };

  it("ajoute zoom, permissions, proxy et aide du thème à chaque compte, sans rien perdre", () => {
    fs.writeFileSync(file, JSON.stringify(V1_ACCOUNTS));
    const result = readJsonDocument(file, accountsDocument);
    expect(result.status).toBe("migrated");
    expect(result.data.schemaVersion).toBe(2);
    expect(result.data.accounts[0]).toEqual({
      ...V1_ACCOUNTS.accounts[0],
      zoomPercent: 100,
      permissions: { microphone: "allow", camera: "allow", location: "deny", screenShare: "ask" },
      proxyMode: "inherit",
      proxy: null,
      themeHintShown: true
    });
  });

  it("garde le français et le correcteur déjà choisi d'une installation existante", () => {
    const prefs = path.join(dir, "preferences.json");
    fs.writeFileSync(prefs, JSON.stringify(V1_PREFERENCES));
    const result = readJsonDocument(prefs, preferencesDocument);
    expect(result.status).toBe("migrated");
    expect(result.data).toMatchObject({
      ...V1_PREFERENCES,
      schemaVersion: 2,
      language: "fr",
      interfaceScale: 100,
      spellcheckMode: "custom",
      downloadsHistoryDays: 30,
      privacyVeil: { onBlur: false, onScreenShare: false, blurMessages: false },
      proxy: { mode: "system", server: null },
      trayCountStyle: "number",
      exclusivePlayback: false
    });
  });

  it("désactive le correcteur migré si aucune langue n'était choisie", () => {
    const prefs = path.join(dir, "preferences.json");
    fs.writeFileSync(prefs, JSON.stringify({ ...V1_PREFERENCES, spellcheckLanguages: [] }));
    expect(readJsonDocument(prefs, preferencesDocument).data.spellcheckMode).toBe("off");
  });

  it("une installation neuve suit la langue du système", () => {
    expect(preferencesDocument.defaults().language).toBe("system");
  });
});

import { describe, expect, it } from "vitest";
import { CRASH_WINDOW_MS, hasWebContents, onRendererGone, transition } from "../../src/main/core/lifecycle";

describe("transition", () => {
  it("suit le parcours nominal d'un compte", () => {
    expect(transition("sleeping", "wake")).toBe("loading");
    expect(transition("loading", "link-required")).toBe("needs_qr");
    expect(transition("needs_qr", "linked")).toBe("ready");
    expect(transition("ready", "network-lost")).toBe("offline");
    expect(transition("offline", "network-restored")).toBe("ready");
    expect(transition("ready", "remote-logout")).toBe("needs_qr");
    expect(transition("ready", "sleep")).toBe("sleeping");
  });

  it("gère le crash depuis tout état qui a une WebContents", () => {
    for (const state of ["loading", "needs_qr", "ready", "offline"] as const) {
      expect(transition(state, "renderer-gone")).toBe("crashed");
    }
    expect(transition("crashed", "recreate")).toBe("loading");
  });

  it("un compte jamais relié passe de hors ligne au QR", () => {
    expect(transition("offline", "link-required")).toBe("needs_qr");
  });

  it("refuse les événements sans objet", () => {
    expect(transition("sleeping", "renderer-gone")).toBeNull();
    expect(transition("sleeping", "linked")).toBeNull();
    expect(transition("ready", "wake")).toBeNull();
    expect(transition("crashed", "network-restored")).toBeNull();
  });

  it("sait quels états ont une WebContents", () => {
    expect(hasWebContents("ready")).toBe(true);
    expect(hasWebContents("sleeping")).toBe(false);
    expect(hasWebContents("crashed")).toBe(false);
  });
});

describe("onRendererGone", () => {
  it("recrée avec un délai croissant puis abandonne au 4e crash en 5 minutes", () => {
    let crashes: number[] = [];
    const delays: Array<number | "give-up"> = [];
    for (const now of [0, 10_000, 20_000, 30_000]) {
      const result = onRendererGone(crashes, now);
      crashes = result.crashTimes;
      delays.push(result.decision.action === "recreate" ? result.decision.delayMs : "give-up");
    }
    expect(delays).toEqual([1_000, 5_000, 30_000, "give-up"]);
  });

  it("oublie les crashs sortis de la fenêtre de 5 minutes", () => {
    const old = [0, 1_000, 2_000];
    const result = onRendererGone(old, CRASH_WINDOW_MS + 2_001);
    expect(result.crashTimes).toEqual([CRASH_WINDOW_MS + 2_001]);
    expect(result.decision).toEqual({ action: "recreate", delayMs: 1_000 });
  });
});

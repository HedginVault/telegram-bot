import { describe, expect, it } from "vitest";
import { type FormOp, type Screen, createIdStore, decodeScreen, encodeScreen } from "../src/ui";
import { VAULT } from "./fixtures";

const ID = "AbC_-012345";
const ops: FormOp[] = [
  { op: "side" },
  { op: "shape", index: 2 },
  { op: "lpSide", index: 0 },
  { op: "lpSide", index: 2 },
  { op: "amountPick", index: 0 },
  { op: "amountPick", index: 2 },
  { op: "quote" },
  { op: "review" },
  { op: "slippage", bps: 300 },
  { op: "share", bps: 10_000 },
  { op: "range", bps: 500 },
  { op: "ask", field: "token" },
  { op: "ask", field: "amountY" },
  { op: "token", index: 3 },
  { op: "pool", index: 5 },
  { op: "empty" },
  { op: "market", index: 15 },
  { op: "orderType" },
  { op: "postOnly" },
  { op: "reduceOnly" },
  { op: "usdc" },
  { op: "ask", field: "minWithdrawalShares" },
];
const screens: Screen[] = [
  { kind: "vaults" },
  { kind: "newVault" },
  ...(
    [
      "vault",
      "strategies",
      "newSwap",
      "newLp",
      "navHistory",
      "requests",
      "strategyHistory",
      "settings",
      "editSettings",
      "phoenix",
      "phoenixDeposit",
      "phoenixWithdraw",
      "newOrder",
      "trackToken",
    ] as const
  ).map((kind) => ({ kind, vault: VAULT })),
  { kind: "position", refId: ID },
  { kind: "addLp", refId: ID },
  { kind: "form", formId: ID },
  { kind: "swapQuote", formId: ID },
  { kind: "confirm", actionId: ID },
  { kind: "execute", actionId: ID },
  ...ops.map((op) => ({ kind: "formOp" as const, formId: ID, op })),
];

describe("screen callback data", () => {
  it("round-trips every screen within Telegram's 64-byte limit", () => {
    for (const screen of screens) {
      const data = encodeScreen(screen);
      expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64);
      expect(decodeScreen(data)).toEqual(screen);
    }
  });

  it("rejects data no button of ours produces", () => {
    for (const data of ["", "v:", "v:not-base58-0OIl", `x:${VAULT}`, `o:${ID}:sl0`, `o:${ID}:sl99999`, `o:${ID}:ask99`, `o:${ID}:hack`, `o:${ID}:mk16`, `o:${ID}:shape`, `o:${ID}:sp3`, `o:${ID}:ls3`, `o:${ID}:ap3`, `h:${VAULT}`, `f:${ID}x`, "c:../etc/pass", `vaults:${VAULT}`]) {
      expect(decodeScreen(data)).toBeUndefined();
    }
  });
});

describe("id store", () => {
  it("issues distinct ids and hands an entry out once with take", () => {
    const store = createIdStore<string>();
    const a = store.put("x");
    expect(store.put("x")).not.toBe(a);
    expect(store.take(a)).toBe("x");
    expect(store.take(a)).toBeUndefined();
  });

  it("evicts the oldest entry past its limit", () => {
    const store = createIdStore<number>(2);
    const first = store.put(1);
    const second = store.put(2);
    store.put(3);
    expect(store.get(first)).toBeUndefined();
    expect(store.get(second)).toBe(2);
  });
});

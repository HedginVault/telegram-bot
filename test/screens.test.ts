import { describe, expect, it } from "vitest";
import { type Screen, createIdStore, decodeScreen, encodeScreen, percentOf } from "../src/screens";
import { SOL, USDC, VAULT } from "./fixtures";

const screens: Screen[] = [
  { kind: "vaults" },
  { kind: "vault", vault: VAULT },
  { kind: "holdings", vault: VAULT },
  { kind: "strategies", vault: VAULT },
  { kind: "quotePick", vault: VAULT },
  { kind: "quoteAmount", pairId: "AbC_-012345" },
  { kind: "quote", pairId: "AbC_-012345", percent: 100, slippageBps: 300 },
  { kind: "lpPools", vault: VAULT },
  { kind: "lpRange", draftId: "AbC_-012345" },
  { kind: "lpAmount", draftId: "AbC_-012345" },
  { kind: "position", refId: "AbC_-012345" },
  { kind: "confirm", actionId: "AbC_-012345" },
  { kind: "execute", actionId: "AbC_-012345" },
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
    for (const data of ["", "v:", "v:not-base58-0OIl", `x:${VAULT}`, "qq:AbC_-012345:33:50", "qq:AbC_-012345:25:75", "qq:AbC_-012345:25", "qq:AbC_-012345:1000:50", "qa:short", `vaults:${VAULT}`, "x:", "x:AbC_-0123456", "c:../etc/pass"]) {
      expect(decodeScreen(data)).toBeUndefined();
    }
  });
});

describe("percentOf", () => {
  it("rounds down in base units without floating point", () => {
    expect(percentOf("123456789012345678901", 25)).toBe("30864197253086419725");
    expect(percentOf("3", 10)).toBe("0");
    expect(percentOf("1000000", 100)).toBe("1000000");
  });
});

describe("pair store", () => {
  const pair = {
    vault: VAULT,
    input: { mint: SOL, symbol: "SOL", decimals: 9 },
    output: { mint: USDC, symbol: "USDC", decimals: 6 },
    inputBalanceBaseUnits: "10000000",
  };

  it("issues distinct ids that decode as quote buttons", () => {
    const store = createIdStore();
    const a = store.put(pair);
    const b = store.put(pair);
    expect(a).not.toBe(b);
    expect(decodeScreen(encodeScreen({ kind: "quoteAmount", pairId: a }))).toEqual({ kind: "quoteAmount", pairId: a });
    expect(store.get(a)).toEqual(pair);
  });

  it("hands out an entry only once with take", () => {
    const store = createIdStore();
    const id = store.put(pair);
    expect(store.take(id)).toEqual(pair);
    expect(store.take(id)).toBeUndefined();
    expect(store.get(id)).toBeUndefined();
  });

  it("evicts the oldest pair past its limit", () => {
    const store = createIdStore(2);
    const first = store.put(pair);
    const second = store.put(pair);
    const third = store.put(pair);
    expect(store.get(first)).toBeUndefined();
    expect(store.get(second)).toEqual(pair);
    expect(store.get(third)).toEqual(pair);
  });
});

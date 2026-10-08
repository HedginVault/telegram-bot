import { describe, expect, it } from "vitest";
import { baseChecks, createProbe, formatReport, runChecks, vaultChecks } from "../src/check-api";
import { USDC, VAULT, holdings, quote, strategies, vaultSummary } from "./fixtures";

const KEY = "hv1_demo_secret";
const error = (status: number, code: string, message = code) => Response.json({ error: { code, message } }, { status });

/** A small stand-in for the V1 API that behaves as documented; `bugs` breaks it on purpose. */
function fakeApi(bugs: { holdingsRoute404?: boolean; leakLogs?: boolean } = {}): typeof fetch {
  return async (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname.replace("/api/external/v1", "");
    const auth = new Headers(init?.headers).get("authorization");
    if (auth !== `Bearer ${KEY}`) return error(401, "Unauthorized", "Invalid API key");
    if (path === "/vaults") return Response.json({ vaults: [{ ...vaultSummary, depositMint: USDC }] });
    const vaultRead = /^\/vaults\/([^/]+)\/(holdings|strategies)$/.exec(path);
    if (vaultRead) {
      if (bugs.holdingsRoute404) return error(404, "NotFound", "Unknown manager API route");
      if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(vaultRead[1] ?? "")) return error(400, "Validation", "vault must be a public key");
      if (vaultRead[1] !== VAULT) return error(403, "Forbidden", "Vault is outside key scope");
      return Response.json({ vault: VAULT, data: vaultRead[2] === "holdings" ? holdings : strategies });
    }
    if (path === "/jupiter/quote") {
      const q = url.searchParams;
      const slippage = Number(q.get("slippageBps"));
      if (!/^\d+$/.test(q.get("amount") ?? "") || slippage < 1 || slippage > 10_000) {
        return error(400, "Validation", bugs.leakLogs ? "bad" : "invalid quote");
      }
      if (q.get("inputMint") === q.get("outputMint")) return error(400, "Validation", "inputMint and outputMint must differ");
      if (q.get("inputMint") !== USDC && q.get("outputMint") !== USDC) return error(400, "Validation", "one side must be the deposit mint");
      return Response.json({ vault: VAULT, data: { ...quote, slippageBps: 50 } });
    }
    if (path === "/dlmm/pools") {
      if (!url.searchParams.get("query")) return error(400, "Validation", "Invalid pool search query or page");
      return Response.json({ vault: VAULT, data: { total: 0, page: 1, pages: 0, pools: [] } });
    }
    if (path === "/transactions/status") {
      return bugs.leakLogs
        ? Response.json({ error: { code: "Internal", message: "boom", logs: ["Program log: secret"] } }, { status: 400 })
        : error(400, "Validation", "Invalid receipt");
    }
    return error(404, "NotFound", "Unknown manager API route");
  };
}

async function runAll(fetch: typeof globalThis.fetch) {
  const probe = createProbe({ baseUrl: "https://example.test", apiKey: KEY, fetch });
  const state: { vaults?: typeof vaultSummary[] } = {};
  const results = await runChecks(baseChecks(probe, state));
  for (const vault of state.vaults ?? []) results.push(...(await runChecks(vaultChecks(probe, vault, { build: false }))));
  return results;
}

describe("API checker", () => {
  it("passes every check against an API that follows the contract", async () => {
    const results = await runAll(fakeApi());
    expect(results.filter((r) => r.outcome !== "pass")).toEqual([]);
    expect(results).toHaveLength(17);
  });

  it("catches the uppercase-address 404 bug fixed in app PR #16", async () => {
    const failed = (await runAll(fakeApi({ holdingsRoute404: true }))).filter((r) => r.outcome === "fail").map((r) => r.name);
    expect(failed).toEqual([
      "GET /vaults/not-a-key/holdings → 400",
      "Demo: holdings matches contract",
      "Demo: strategies matches contract",
    ]);
  });

  it("fails an error body that leaks provider logs", async () => {
    const results = await runAll(fakeApi({ leakLogs: true }));
    const leak = results.find((r) => r.name === "status: forged receipt → 400/403");
    expect(leak).toMatchObject({ outcome: "fail" });
    expect(leak?.detail).toMatch(/leaks internals/);
  });

  it("prints a summary line with counts", () => {
    const report = formatReport([
      { name: "a", outcome: "pass", detail: "ok", ms: 1 },
      { name: "b", outcome: "fail", detail: "bad", ms: 2 },
      { name: "c", outcome: "skip", detail: "n/a", ms: 3 },
    ]);
    expect(report.split("\n").at(-1)).toBe("1 passed, 1 failed, 1 skipped");
    expect(report).toContain("FAIL  b");
  });
});

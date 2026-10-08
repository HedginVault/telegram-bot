import { describe, expect, it, vi } from "vitest";
import { ApiError, createHedgeApi } from "../src/api";

const vault = {
  address: "Vau1t1111111111111111111111111111111111111111",
  name: "Demo",
  status: "active",
  depositSymbol: "USDC",
  depositDecimals: 6,
  totalAssets: "1500000",
  navPerShare: "1000000",
};

function stubFetch(status: number, body: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status }));
}

describe("createHedgeApi", () => {
  it("lists vaults with the bearer key on the V1 path", async () => {
    const fetch = stubFetch(200, { vaults: [vault] });
    const api = createHedgeApi({ baseUrl: "https://example.test", apiKey: "hv1_demo_secret", fetch });
    const vaults = await api.listVaults();
    expect(vaults).toEqual([
      { address: vault.address, name: "Demo", status: "active", depositSymbol: "USDC", depositDecimals: 6, totalAssets: "1500000" },
    ]);
    expect(fetch).toHaveBeenCalledWith(
      "https://example.test/api/external/v1/vaults",
      expect.objectContaining({ headers: { Authorization: "Bearer hv1_demo_secret" } }),
    );
  });
  it("surfaces the documented error body", async () => {
    const api = createHedgeApi({ baseUrl: "https://example.test", apiKey: "k", fetch: stubFetch(401, { error: { code: "unauthorized", message: "Invalid API key" } }) });
    await expect(api.listVaults()).rejects.toEqual(new ApiError(401, "unauthorized", "Invalid API key"));
    await expect(api.listVaults()).rejects.toMatchObject({ status: 401, code: "unauthorized" });
  });
  it("flags a success body that breaks the contract", async () => {
    const api = createHedgeApi({ baseUrl: "https://example.test", apiKey: "k", fetch: stubFetch(200, { vaults: [{ ...vault, totalAssets: 1.5 }] }) });
    await expect(api.listVaults()).rejects.toMatchObject({ code: "contract_mismatch" });
  });
});

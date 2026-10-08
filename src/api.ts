import { z } from "zod";

const REQUEST_TIMEOUT_MS = 10_000;

const ErrorBodySchema = z.object({ error: z.object({ code: z.string(), message: z.string() }) });

const VaultSummarySchema = z.object({
  address: z.string(),
  name: z.string(),
  status: z.string(),
  depositSymbol: z.string(),
  depositDecimals: z.number().int().nonnegative(),
  totalAssets: z.string().regex(/^\d+$/),
});
export type VaultSummary = z.infer<typeof VaultSummarySchema>;

const VaultsResponseSchema = z.object({ vaults: z.array(VaultSummarySchema) });

const BaseUnits = z.string().regex(/^\d+$/);

const TokenInfoSchema = z.object({
  mint: z.string(),
  symbol: z.string(),
  decimals: z.number().int().nonnegative(),
});

const HoldingsSchema = z.object({
  depositToken: TokenInfoSchema,
  totalValue: BaseUnits,
  totalUsd: z.number().nullable(),
  navTotalAssets: BaseUnits,
  navDeltaBps: z.number().nullable(),
  partial: z.boolean(),
  unpriced: z.array(z.string()),
  tokens: z.array(
    z.object({ token: TokenInfoSchema, amount: BaseUnits, usd: z.number().nullable(), shareBps: z.number().nullable() }),
  ),
});
export type Holdings = z.infer<typeof HoldingsSchema>;

const StrategySchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("jupiter"), address: z.string(), symbol: z.string(), decimals: z.number().int().nonnegative(), vaultBalance: BaseUnits }),
  z.object({
    type: z.literal("dlmm"),
    address: z.string(),
    position: z.string(),
    tokenX: TokenInfoSchema,
    tokenY: TokenInfoSchema,
    lowerPrice: z.string(),
    upperPrice: z.string(),
    activePrice: z.string(),
    amountX: BaseUnits,
    amountY: BaseUnits,
  }),
  z.object({ type: z.literal("phoenix"), address: z.string(), equity: BaseUnits, leverage: z.number().nullable() }),
  z.object({ type: z.literal("unreadable"), address: z.string(), protocol: z.string(), reason: z.string() }),
]);
export type Strategy = z.infer<typeof StrategySchema>;

const QuoteSchema = z.object({
  inAmount: BaseUnits,
  outAmount: BaseUnits,
  priceImpactPct: z.string(),
  routeLabels: z.array(z.string()),
  slippageBps: z.number().int(),
});
export type Quote = z.infer<typeof QuoteSchema>;

const vaultData = <T extends z.ZodTypeAny>(data: T) => z.object({ vault: z.string(), data });

export interface QuoteRequest {
  vault: string;
  inputMint: string;
  outputMint: string;
  amountBaseUnits: string;
  slippageBps: number;
}

/** A non-2xx response from the API, or a body that did not match the documented contract. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface HedgeApi {
  listVaults(): Promise<VaultSummary[]>;
  getHoldings(vault: string): Promise<Holdings>;
  getStrategies(vault: string): Promise<Strategy[]>;
  getQuote(request: QuoteRequest): Promise<Quote>;
}

export function createHedgeApi(options: { baseUrl: string; apiKey: string; fetch?: typeof fetch }): HedgeApi {
  const fetchImpl = options.fetch ?? fetch;

  async function get<T>(path: string, schema: z.ZodType<T>): Promise<T> {
    const response = await fetchImpl(`${options.baseUrl}/api/external/v1${path}`, {
      headers: { Authorization: `Bearer ${options.apiKey}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const error = ErrorBodySchema.safeParse(body);
      throw error.success
        ? new ApiError(response.status, error.data.error.code, error.data.error.message)
        : new ApiError(response.status, "unexpected_response", `HTTP ${response.status}`);
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) throw new ApiError(response.status, "contract_mismatch", `Unexpected response shape for ${path}`);
    return parsed.data;
  }

  return {
    listVaults: async () => (await get("/vaults", VaultsResponseSchema)).vaults,
    getHoldings: async (vault) => (await get(`/vaults/${encodeURIComponent(vault)}/holdings`, vaultData(HoldingsSchema))).data,
    getStrategies: async (vault) =>
      (await get(`/vaults/${encodeURIComponent(vault)}/strategies`, vaultData(z.array(StrategySchema)))).data,
    getQuote: async (request) => {
      const query = new URLSearchParams({
        vault: request.vault,
        inputMint: request.inputMint,
        outputMint: request.outputMint,
        amount: request.amountBaseUnits,
        slippageBps: String(request.slippageBps),
      });
      return (await get(`/jupiter/quote?${query}`, vaultData(QuoteSchema))).data;
    },
  };
}

import { z } from "zod";

const REQUEST_TIMEOUT_MS = 10_000;
// Builders simulate on chain and can call Jupiter, so they get more time.
const BUILD_TIMEOUT_MS = 30_000;

export const ErrorBodySchema = z.object({ error: z.object({ code: z.string(), message: z.string() }) });

const VaultSummarySchema = z.object({
  address: z.string(),
  name: z.string(),
  status: z.string(),
  depositSymbol: z.string(),
  depositDecimals: z.number().int().nonnegative(),
  totalAssets: z.string().regex(/^\d+$/),
});
export type VaultSummary = z.infer<typeof VaultSummarySchema>;

export const VaultsResponseSchema = z.object({ vaults: z.array(VaultSummarySchema) });

const BaseUnits = z.string().regex(/^\d+$/);

const TokenInfoSchema = z.object({
  mint: z.string(),
  symbol: z.string(),
  decimals: z.number().int().nonnegative(),
});

export const HoldingsSchema = z.object({
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

export const StrategySchema = z.discriminatedUnion("type", [
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
    pendingFeeX: BaseUnits,
    pendingFeeY: BaseUnits,
  }),
  z.object({ type: z.literal("phoenix"), address: z.string(), equity: BaseUnits, leverage: z.number().nullable() }),
  z.object({ type: z.literal("unreadable"), address: z.string(), protocol: z.string(), reason: z.string() }),
]);
export type Strategy = z.infer<typeof StrategySchema>;

export const QuoteSchema = z.object({
  inAmount: BaseUnits,
  outAmount: BaseUnits,
  priceImpactPct: z.string(),
  routeLabels: z.array(z.string()),
  slippageBps: z.number().int(),
});
export type Quote = z.infer<typeof QuoteSchema>;

export const vaultData = <T extends z.ZodTypeAny>(data: T) => z.object({ vault: z.string(), data });

export const PoolSearchSchema = z.object({
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pages: z.number().int().nonnegative(),
  pools: z.array(
    z.object({
      address: z.string(),
      name: z.string(),
      tokenX: z.object({ mint: z.string(), symbol: z.string() }),
      tokenY: z.object({ mint: z.string(), symbol: z.string() }),
      binStep: z.number(),
    }),
  ),
});

export const BuiltStepSchema = z
  .object({
    transaction: z.string().min(1),
    simulation: z.object({ unitsConsumed: z.number(), deferred: z.boolean().optional() }),
    ticket: z.string().min(1),
    blockhash: z.string().min(1),
    sendConcurrently: z.boolean().optional(),
    next: z.object({ path: z.string().regex(/^[a-z0-9/-]+$/), body: z.record(z.unknown()) }).optional(),
  })
  .passthrough();
export type BuiltStep = z.infer<typeof BuiltStepSchema>;

export const BuildResponseSchema = z.object({
  vault: z.string(),
  result: z.union([BuiltStepSchema, z.array(BuiltStepSchema).min(1)]),
});

export const SendResponseSchema = z.object({
  signature: z.string().min(1),
  receipt: z.string().min(1),
  status: z.enum(["pending", "unknown"]),
});
export type SendResult = z.infer<typeof SendResponseSchema>;

export const StatusResponseSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("pending") }),
  z.object({ status: z.literal("confirmed") }),
  z.object({ status: z.literal("expired") }),
  z.object({ status: z.literal("failed"), code: z.string(), message: z.string() }),
]);
export type TransactionStatus = z.infer<typeof StatusResponseSchema>;

/** Builder actions the bot uses; the API accepts these after `/transactions/`. */
export type BuildAction =
  | "jupiter/swap"
  | "dlmm/remove"
  | "dlmm/claim-fee"
  | "dlmm/zap-out"
  | "dlmm/zap-out/swap"
  | "strategy/close";

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
  /** `action` is a builder name, or a `next.path` returned by a previous build. */
  build(action: string, body: Record<string, unknown>): Promise<BuiltStep[]>;
  send(signedTransactionBase64: string, ticket: string): Promise<SendResult>;
  status(receipt: string): Promise<TransactionStatus>;
}

export function createHedgeApi(options: { baseUrl: string; apiKey: string; fetch?: typeof fetch }): HedgeApi {
  const fetchImpl = options.fetch ?? fetch;

  async function call<T>(path: string, schema: z.ZodType<T>, requestBody?: Record<string, unknown>): Promise<T> {
    const response = await fetchImpl(`${options.baseUrl}/api/external/v1${path}`, {
      method: requestBody === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        ...(requestBody === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(requestBody === undefined ? {} : { body: JSON.stringify(requestBody) }),
      signal: AbortSignal.timeout(requestBody === undefined ? REQUEST_TIMEOUT_MS : BUILD_TIMEOUT_MS),
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
    listVaults: async () => (await call("/vaults", VaultsResponseSchema)).vaults,
    getHoldings: async (vault) => (await call(`/vaults/${encodeURIComponent(vault)}/holdings`, vaultData(HoldingsSchema))).data,
    getStrategies: async (vault) =>
      (await call(`/vaults/${encodeURIComponent(vault)}/strategies`, vaultData(z.array(StrategySchema)))).data,
    getQuote: async (request) => {
      const query = new URLSearchParams({
        vault: request.vault,
        inputMint: request.inputMint,
        outputMint: request.outputMint,
        amount: request.amountBaseUnits,
        slippageBps: String(request.slippageBps),
      });
      return (await call(`/jupiter/quote?${query}`, vaultData(QuoteSchema))).data;
    },
    build: async (action, body) => {
      const { result } = await call(`/transactions/${action}`, BuildResponseSchema, body);
      return Array.isArray(result) ? result : [result];
    },
    send: (transaction, ticket) => call("/transactions/send", SendResponseSchema, { transaction, ticket }),
    status: (receipt) => call(`/transactions/status?${new URLSearchParams({ receipt })}`, StatusResponseSchema),
  };
}

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
  };
}

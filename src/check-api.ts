import { Keypair, VersionedTransaction } from "@solana/web3.js";
import type { z } from "zod";
import {
  BuildResponseSchema,
  ErrorBodySchema,
  HoldingsSchema,
  PoolSearchSchema,
  QuoteSchema,
  StrategySchema,
  type VaultSummary,
  VaultsResponseSchema,
  vaultData,
} from "./api";
import { loadApiConfig } from "./config";

const WSOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
// The app limits each IP to 60 requests per minute; stay well under it.
const MAX_VAULTS_CHECKED = 3;
const REQUEST_TIMEOUT_MS = 30_000;

export interface HttpResult {
  status: number;
  body: unknown;
  ms: number;
}

export interface CheckResult {
  name: string;
  outcome: "pass" | "fail" | "skip";
  detail: string;
  ms: number;
}

/** A check that cannot run with this key or this vault, which is not an API defect. */
class Skip extends Error {}

type Probe = (path: string, options?: { body?: Record<string, unknown>; authorization?: string | null }) => Promise<HttpResult>;

export function createProbe(options: { baseUrl: string; apiKey: string; fetch?: typeof fetch }): Probe {
  const fetchImpl = options.fetch ?? fetch;
  return async (path, { body, authorization = `Bearer ${options.apiKey}` } = {}) => {
    const started = performance.now();
    const response = await fetchImpl(`${options.baseUrl}/api/external/v1${path}`, {
      method: body ? "POST" : "GET",
      headers: {
        ...(authorization === null ? {} : { Authorization: authorization }),
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      redirect: "manual",
    });
    const parsed: unknown = await response.json().catch(() => null);
    return { status: response.status, body: parsed, ms: Math.round(performance.now() - started) };
  };
}

const LEAK_PATTERNS = [/"logs"/, /"stack"/, /Program log:/, /\bat \/[\w/.-]+:\d+/, /node_modules/];

function expectError(result: HttpResult, statuses: number[]): string {
  if (!statuses.includes(result.status)) {
    throw new Error(`expected HTTP ${statuses.join(" or ")}, got ${result.status} ${JSON.stringify(result.body)?.slice(0, 160)}`);
  }
  const error = ErrorBodySchema.safeParse(result.body);
  if (!error.success) throw new Error(`HTTP ${result.status} body is not { error: { code, message } }`);
  const text = JSON.stringify(result.body);
  const leak = LEAK_PATTERNS.find((pattern) => pattern.test(text));
  if (leak) throw new Error(`error body leaks internals (${leak})`);
  return `${result.status} ${error.data.error.code}`;
}

function expectContract<T>(result: HttpResult, schema: z.ZodType<T>): T {
  if (result.status !== 200) throw new Error(`expected HTTP 200, got ${result.status} ${JSON.stringify(result.body)?.slice(0, 160)}`);
  const parsed = schema.safeParse(result.body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`200 but contract mismatch at ${issue?.path.join(".") || "(root)"}: ${issue?.message ?? "unknown"}`);
  }
  return parsed.data;
}

const randomKey = () => Keypair.generate().publicKey.toBase58();
const quotePath = (params: Record<string, string>) => `/jupiter/quote?${new URLSearchParams(params)}`;

interface Check {
  name: string;
  run: () => Promise<string>;
}

export async function runChecks(checks: Check[]): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const check of checks) {
    const started = performance.now();
    let outcome: CheckResult["outcome"] = "pass";
    let detail: string;
    try {
      detail = await check.run();
    } catch (error) {
      outcome = error instanceof Skip ? "skip" : "fail";
      detail = error instanceof Error ? error.message : String(error);
    }
    results.push({ name: check.name, outcome, detail, ms: Math.round(performance.now() - started) });
  }
  return results;
}

/** Checks that need no vault: authentication, routing, and the vault list. */
export function baseChecks(probe: Probe, state: { vaults?: VaultSummary[] }): Check[] {
  return [
    { name: "auth: missing key → 401", run: async () => expectError(await probe("/vaults", { authorization: null }), [401]) },
    {
      name: "auth: wrong secret → 401",
      run: async () => expectError(await probe("/vaults", { authorization: `Bearer hv1_nobody_${"0".repeat(64)}` }), [401]),
    },
    { name: "auth: malformed header → 401", run: async () => expectError(await probe("/vaults", { authorization: "Basic abc" }), [401]) },
    { name: "routing: unknown route → 404", run: async () => expectError(await probe("/no-such-route"), [404]) },
    {
      name: "GET /vaults matches contract",
      run: async () => {
        const { vaults } = expectContract(await probe("/vaults"), VaultsResponseSchema);
        state.vaults = vaults;
        return `${vaults.length} vault(s)`;
      },
    },
    { name: "GET /vaults/{random}/holdings → 403/404", run: async () => expectError(await probe(`/vaults/${randomKey()}/holdings`), [403, 404]) },
    { name: "GET /vaults/not-a-key/holdings → 400", run: async () => expectError(await probe("/vaults/not-a-key/holdings"), [400]) },
    {
      name: "status: forged receipt → 400/403",
      run: async () => expectError(await probe("/transactions/status?receipt=forged.receipt"), [400, 403]),
    },
  ];
}

export function vaultChecks(probe: Probe, vault: VaultSummary, options: { build: boolean }): Check[] {
  const v = vault.address;
  const label = (name: string) => `${vault.name}: ${name}`;
  let depositMint: string | undefined;
  const otherMint = () => (depositMint === WSOL ? USDC : WSOL);
  const oneToken = (10n ** BigInt(vault.depositDecimals)).toString();
  const quote = (params: Partial<Record<string, string>>) =>
    probe(quotePath({ vault: v, inputMint: depositMint ?? "", outputMint: otherMint(), amount: oneToken, slippageBps: "50", ...params } as Record<string, string>));
  const needDeposit = () => {
    if (!depositMint) throw new Skip("holdings check failed, deposit mint unknown");
  };

  const checks: Check[] = [
    {
      name: label("holdings matches contract"),
      run: async () => {
        const { data } = expectContract(await probe(`/vaults/${v}/holdings`), vaultData(HoldingsSchema));
        depositMint = data.depositToken.mint;
        return `${data.tokens.length} token(s)${data.partial ? ", partial" : ""}`;
      },
    },
    {
      name: label("strategies matches contract"),
      run: async () => `${expectContract(await probe(`/vaults/${v}/strategies`), vaultData(StrategySchema.array())).data.length} strategy(ies)`,
    },
    {
      name: label("quote 1 deposit token matches contract"),
      run: async () => {
        needDeposit();
        const { data } = expectContract(await quote({}), vaultData(QuoteSchema));
        return `out ${data.outAmount}, ${data.routeLabels.join(" → ")}`;
      },
    },
    { name: label("quote slippageBps=0 → 400"), run: async () => (needDeposit(), expectError(await quote({ slippageBps: "0" }), [400])) },
    { name: label("quote decimal amount → 400"), run: async () => (needDeposit(), expectError(await quote({ amount: "1.5" }), [400])) },
    { name: label("quote same mint both sides → 400"), run: async () => (needDeposit(), expectError(await quote({ outputMint: depositMint ?? "" }), [400])) },
    {
      name: label("quote without the deposit mint → 400"),
      run: async () => expectError(await quote({ inputMint: randomKey(), outputMint: randomKey() }), [400]),
    },
    {
      name: label("pool search matches contract"),
      run: async () => {
        const { data } = expectContract(await probe(`/dlmm/pools?${new URLSearchParams({ vault: v, query: "SOL" })}`), vaultData(PoolSearchSchema));
        return `${data.total} pool(s)`;
      },
    },
    {
      name: label("pool search empty query → 400"),
      run: async () => expectError(await probe(`/dlmm/pools?${new URLSearchParams({ vault: v, query: "" })}`), [400]),
    },
  ];
  if (!options.build) return checks;

  const swapBody = () => ({ vault: v, sourceMint: depositMint, destinationMint: otherMint(), amount: (BigInt(oneToken) / 100n).toString(), slippageBps: 50 });
  checks.push(
    {
      name: label("build: payer in body → 400"),
      run: async () => {
        needDeposit();
        const result = await probe("/transactions/jupiter/swap", { body: { ...swapBody(), payer: randomKey() } });
        if (result.status === 403) throw new Skip("key lacks the jupiter/swap action");
        return expectError(result, [400]);
      },
    },
    {
      name: label("build: unsigned swap returns transaction + ticket"),
      run: async () => {
        needDeposit();
        const result = await probe("/transactions/jupiter/swap", { body: swapBody() });
        if (result.status === 403) throw new Skip("key lacks the jupiter/swap action");
        if (result.status === 422) throw new Skip("simulation rejected; the vault may lack 0.01 deposit token");
        const { result: built } = expectContract(result, BuildResponseSchema);
        const steps = Array.isArray(built) ? built : [built];
        for (const step of steps) {
          const tx = VersionedTransaction.deserialize(Buffer.from(step.transaction, "base64"));
          if (tx.message.recentBlockhash !== step.blockhash) throw new Error("step.blockhash does not match the transaction");
        }
        return `${steps.length} step(s), nothing signed or sent`;
      },
    },
  );
  return checks;
}

export function formatReport(results: CheckResult[]): string {
  const icon = { pass: "PASS", fail: "FAIL", skip: "SKIP" } as const;
  const width = Math.max(...results.map((r) => r.name.length));
  const lines = results.map((r) => `${icon[r.outcome]}  ${r.name.padEnd(width)}  ${String(r.ms).padStart(5)} ms  ${r.detail}`);
  const count = (outcome: CheckResult["outcome"]) => results.filter((r) => r.outcome === outcome).length;
  return [...lines, "", `${count("pass")} passed, ${count("fail")} failed, ${count("skip")} skipped`].join("\n");
}

async function main(): Promise<void> {
  const config = loadApiConfig(process.env);
  const build = process.argv.includes("--build");
  const probe = createProbe({ baseUrl: config.apiBaseUrl, apiKey: config.apiKey });
  console.log(`Checking ${config.apiBaseUrl}/api/external/v1${build ? " (with unsigned builds)" : ""}\n`);
  const state: { vaults?: VaultSummary[] } = {};
  const results = await runChecks(baseChecks(probe, state));
  for (const vault of (state.vaults ?? []).slice(0, MAX_VAULTS_CHECKED)) {
    results.push(...(await runChecks(vaultChecks(probe, vault, { build }))));
  }
  console.log(formatReport(results));
  process.exitCode = results.some((r) => r.outcome === "fail") ? 1 : 0;
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}

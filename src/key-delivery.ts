import { createHash, timingSafeEqual } from "node:crypto";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import { z } from "zod";
import { shortAddress } from "./format";
import type { UsernameStore } from "./telegram-users";
import type { WalletStore } from "./wallets";

const MAX_BODY_BYTES = 4096;
const BASE58_KEY = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const DeliverySchema = z.object({
  telegram: z.string().regex(/^[A-Za-z0-9_]{5,32}$/),
  apiKey: z.string().regex(/^hv1_[a-z0-9]+_[a-f0-9]{64}$/),
  // Base58 only, so the addresses need no HTML escaping.
  manager: z.string().regex(BASE58_KEY),
  vault: z.string().regex(BASE58_KEY),
});
type Delivery = z.infer<typeof DeliverySchema>;

/** The DM a manager gets when an admin approves their key request. */
export function keyDeliveryMessage(delivery: Pick<Delivery, "apiKey" | "manager" | "vault">, attachedTo?: string): string {
  return [
    "🔑 <b>Your Hedgin API key is ready</b>",
    "",
    `<b>Vault</b>  ${shortAddress(delivery.vault)}`,
    `<b>Manager</b>  ${shortAddress(delivery.manager)}`,
    "",
    `<code>${delivery.apiKey}</code>`,
    "",
    "Keep it secret. Paste it into your bot as HEDGIN_API_KEY.",
    ...(attachedTo ? ["", `Added to your wallet ${shortAddress(attachedTo)}.`] : []),
  ].join("\n");
}

const digest = (text: string) => createHash("sha256").update(text).digest();

export interface KeyDeliveryDeps {
  secret: string;
  usernames: UsernameStore;
  wallets: WalletStore;
  /** Same check the wallet menu runs before it stores a pasted key. */
  checkApiKey: (apiKey: string) => Promise<void>;
  sendHtml: (chatId: number, html: string) => Promise<void>;
}

/** Stores the key on the user's wallet for `manager`, if they have one here. Returns the wallet address it was added to. */
async function attachKey(deps: KeyDeliveryDeps, userId: number, delivery: Delivery): Promise<string | undefined> {
  const wallet = deps.wallets.list(userId).find((w) => w.publicKey === delivery.manager);
  if (!wallet) return undefined;
  try {
    await deps.checkApiKey(delivery.apiKey);
    deps.wallets.setApiKey(userId, wallet.id, delivery.apiKey);
    return wallet.publicKey;
  } catch {
    // The manager still gets the key and can add it by hand.
    return undefined;
  }
}

/**
 * `POST /deliver-api-key` from the admin dashboard: DMs an approved API key to the manager's
 * @username. Never logs the key, the secret or the body.
 */
export function keyDeliveryHandler(deps: KeyDeliveryDeps) {
  const expected = digest(`Bearer ${deps.secret}`);

  function reply(res: ServerResponse, status: number, body: object): void {
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== "POST" || req.url !== "/deliver-api-key") return reply(res, 404, { error: "not_found" });
    // Hashing first makes the comparison constant-time regardless of length.
    if (!timingSafeEqual(digest(req.headers.authorization ?? ""), expected)) return reply(res, 401, { error: "unauthorized" });

    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req as AsyncIterable<Buffer>) {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) return reply(res, 400, { error: "invalid_body" });
      chunks.push(chunk);
    }
    let parsed: z.SafeParseReturnType<unknown, Delivery>;
    try {
      parsed = DeliverySchema.safeParse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    } catch {
      return reply(res, 400, { error: "invalid_body" });
    }
    if (!parsed.success) return reply(res, 400, { error: "invalid_body" });
    const delivery = parsed.data;

    const userId = deps.usernames.idOf(delivery.telegram);
    if (userId === undefined) {
      console.info("[telegram-bot] key delivery", { result: "not_started" });
      return reply(res, 404, { delivered: false, reason: "not_started" });
    }
    const attachedTo = await attachKey(deps, userId, delivery);
    try {
      await deps.sendHtml(userId, keyDeliveryMessage(delivery, attachedTo));
    } catch {
      console.info("[telegram-bot] key delivery", { result: "send_failed", attached: attachedTo !== undefined });
      return reply(res, 502, { delivered: false, reason: "send_failed" });
    }
    console.info("[telegram-bot] key delivery", { result: "delivered", attached: attachedTo !== undefined });
    reply(res, 200, { delivered: true });
  }

  return (req: IncomingMessage, res: ServerResponse): void => {
    handle(req, res).catch(() => {
      if (!res.headersSent) reply(res, 500, { error: "internal" });
      else res.end();
    });
  };
}

export function startKeyDeliveryServer(port: number, deps: KeyDeliveryDeps): Server {
  return createServer(keyDeliveryHandler(deps)).listen(port);
}

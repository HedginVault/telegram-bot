import { randomBytes } from "node:crypto";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Keypair } from "@solana/web3.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { keyDeliveryHandler, keyDeliveryMessage } from "../src/key-delivery";
import { createUsernameStore } from "../src/telegram-users";
import { createWalletStore } from "../src/wallets";
import { VAULT } from "./fixtures";

const SECRET = "s".repeat(40);
const USER = 42;
const manager = Keypair.generate();
const MANAGER = manager.publicKey.toBase58();
const API_KEY = `hv1_abc123_${"e".repeat(64)}`;
const body = { telegram: "Hedgin_Manager", apiKey: API_KEY, manager: MANAGER, vault: VAULT };

let server: Server | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  await new Promise((resolve) => server?.close(resolve) ?? resolve(undefined));
  server = undefined;
});

async function setup(options: { known?: boolean; wallet?: boolean; checkApiKey?: () => Promise<void>; sendFails?: boolean } = {}) {
  const usernames = createUsernameStore(undefined);
  if (options.known ?? true) usernames.record("hedgin_manager", USER);
  const wallets = createWalletStore(undefined, randomBytes(32));
  if (options.wallet) wallets.add(USER, manager, "imported");
  const sent: { chatId: number; html: string }[] = [];
  const checkApiKey = vi.fn(options.checkApiKey ?? (async () => undefined));
  server = createServer(
    keyDeliveryHandler({
      secret: SECRET,
      usernames,
      wallets,
      checkApiKey,
      sendHtml: async (chatId, html) => {
        if (options.sendFails) throw new Error("Forbidden: bot was blocked by the user");
        sent.push({ chatId, html });
      },
    }),
  );
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const post = (payload: unknown, auth = `Bearer ${SECRET}`, path = "/deliver-api-key") =>
    fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers: { authorization: auth, "content-type": "application/json" },
      body: typeof payload === "string" ? payload : JSON.stringify(payload),
    });
  return { post, sent, wallets, checkApiKey };
}

describe("key delivery endpoint", () => {
  it("DMs the key to the user behind the username", async () => {
    const { post, sent } = await setup();
    const res = await post(body);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ delivered: true });
    expect(sent).toEqual([{ chatId: USER, html: keyDeliveryMessage(body) }]);
  });

  it("rejects a missing or wrong secret before reading the body", async () => {
    const { post, sent } = await setup();
    expect((await post(body, "")).status).toBe(401);
    expect((await post(body, `Bearer ${SECRET}x`)).status).toBe(401);
    expect((await post(body, SECRET)).status).toBe(401);
    expect(sent).toEqual([]);
  });

  it("rejects bad bodies and other paths", async () => {
    const { post, sent } = await setup();
    expect((await post("not json")).status).toBe(400);
    expect((await post({ ...body, telegram: "@x" })).status).toBe(400);
    expect((await post({ ...body, apiKey: "hv1_abc_short" })).status).toBe(400);
    expect((await post({ ...body, manager: "<b>x</b>" })).status).toBe(400);
    expect((await post({ ...body, pad: "x".repeat(5000) })).status).toBe(400);
    expect((await post(body, `Bearer ${SECRET}`, "/other")).status).toBe(404);
    expect(sent).toEqual([]);
  });

  it("reports a username that never pressed Start", async () => {
    const { post } = await setup({ known: false });
    const res = await post(body);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ delivered: false, reason: "not_started" });
  });

  it("reports a failed send", async () => {
    const { post } = await setup({ sendFails: true });
    const res = await post(body);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ delivered: false, reason: "send_failed" });
  });

  it("adds the key to the user's wallet for that manager after the API accepts it", async () => {
    const { post, sent, wallets, checkApiKey } = await setup({ wallet: true });
    expect((await post(body)).status).toBe(200);
    const [wallet] = wallets.list(USER);
    expect(checkApiKey).toHaveBeenCalledWith(API_KEY);
    expect(wallet && wallets.apiKey(USER, wallet.id)).toBe(API_KEY);
    expect(sent[0]?.html).toContain(`Added to your wallet ${MANAGER.slice(0, 4)}…${MANAGER.slice(-4)}.`);
  });

  it("still sends the key, without adding it, when the API rejects it", async () => {
    const { post, sent, wallets } = await setup({
      wallet: true,
      checkApiKey: async () => {
        throw new Error("rejected");
      },
    });
    expect((await post(body)).status).toBe(200);
    const [wallet] = wallets.list(USER);
    expect(wallet?.hasApiKey).toBe(false);
    expect(sent[0]?.html).toBe(keyDeliveryMessage(body));
  });

  it("never logs the key, the secret or the body", async () => {
    const logged: unknown[] = [];
    for (const level of ["log", "info", "warn", "error"] as const) vi.spyOn(console, level).mockImplementation((...args) => void logged.push(args));
    const { post } = await setup({ wallet: true });
    await post(body);
    await post(body, "Bearer wrong");
    await post({ ...body, telegram: "nobody_here" });
    const text = JSON.stringify(logged);
    expect(logged.length).toBeGreaterThan(0);
    for (const secret of [API_KEY, SECRET, "Hedgin_Manager", MANAGER]) expect(text).not.toContain(secret);
  });
});

describe("key delivery message", () => {
  it("shows both addresses short and the key in code", () => {
    expect(keyDeliveryMessage({ apiKey: API_KEY, manager: "3SSSAbcdefghijklmnopqrstuvwxyzfeq6", vault: "5brsAbcdefghijklmnopqrstuvwxyzu68a" })).toBe(
      [
        "🔑 <b>Your Hedgin API key is ready</b>",
        "",
        "<b>Vault</b>  5brs…u68a",
        "<b>Manager</b>  3SSS…feq6",
        "",
        `<code>${API_KEY}</code>`,
        "",
        "Keep it secret. Paste it into your bot as HEDGIN_API_KEY.",
      ].join("\n"),
    );
  });
});

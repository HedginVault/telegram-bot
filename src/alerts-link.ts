import { z } from "zod";

/** A link code from hedgin.xyz Delivery Settings: 16 random bytes, base64url. */
export const ALERT_LINK_CODE = /^[A-Za-z0-9_-]{22}$/;

export const isAlertLinkCode = (payload: string): boolean => ALERT_LINK_CODE.test(payload);

export const ALERTS_ON =
  "Alerts are on. You'll get a message here when a vault you manage needs action. Send /alerts_off to stop.";
export const ALERTS_LINK_EXPIRED = "This link has expired. Open Delivery Settings on hedgin.xyz and tap Connect again.";
export const ALERTS_CLAIM_FAILED = "Couldn't connect alerts right now. Try the link again in a minute.";
export const ALERTS_OFF = "Alerts are off for this chat.";
export const ALERTS_NONE = "This chat had no alerts connected.";
export const ALERTS_UNLINK_FAILED = "Couldn't turn alerts off right now. Try /alerts_off again in a minute.";
export const ALERTS_NOT_SET_UP = "Alerts aren't set up on this bot yet.";

const TIMEOUT_MS = 10_000;
const ClaimResponse = z.object({ ok: z.literal(true), vaultCount: z.number().int().nonnegative() });
const UnlinkResponse = z.object({ ok: z.literal(true), removed: z.number().int().nonnegative() });

/** Links a chat to the app's vault alerts. The app sends the alerts; each method returns the reply text. */
export interface AlertsLink {
  claim(input: { code: string; chatId: string; username: string | null }): Promise<string>;
  unlink(chatId: string): Promise<string>;
}

/** Without a secret, nothing is sent to the app. */
export function createAlertsLink(fetchFn: typeof fetch, apiBaseUrl: string, secret: string | undefined): AlertsLink {
  const post = (path: string, body: object, key: string): Promise<Response> =>
    fetchFn(`${apiBaseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-alerts-link-secret": key },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

  return {
    async claim(input) {
      if (secret === undefined) return ALERTS_NOT_SET_UP;
      try {
        const response = await post("/api/alerts/telegram/claim", input, secret);
        if (response.status === 404 || response.status === 410) return ALERTS_LINK_EXPIRED;
        if (response.status !== 200) throw new Error(`claim answered ${response.status}`);
        ClaimResponse.parse(await response.json());
        return ALERTS_ON;
      } catch (error) {
        console.error("[telegram-bot] alerts claim failed", error instanceof Error ? error.message : "unknown error");
        return ALERTS_CLAIM_FAILED;
      }
    },
    async unlink(chatId) {
      if (secret === undefined) return ALERTS_NOT_SET_UP;
      try {
        const response = await post("/api/alerts/telegram/unlink", { chatId }, secret);
        if (response.status !== 200) throw new Error(`unlink answered ${response.status}`);
        const { removed } = UnlinkResponse.parse(await response.json());
        return removed === 0 ? ALERTS_NONE : ALERTS_OFF;
      } catch (error) {
        console.error("[telegram-bot] alerts unlink failed", error instanceof Error ? error.message : "unknown error");
        return ALERTS_UNLINK_FAILED;
      }
    },
  };
}

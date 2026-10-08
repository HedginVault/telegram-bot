import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";

const validEnv = {
  TELEGRAM_BOT_TOKEN: "123:abc",
  ALLOWED_TELEGRAM_USER_IDS: "111, 222",
  HEDGE_API_KEY: "hv1_demo_0123456789abcdef0123456789abcdef",
};

describe("loadConfig", () => {
  it("parses a valid environment and defaults the API origin", () => {
    const config = loadConfig(validEnv);
    expect([...config.allowedUserIds]).toEqual([111, 222]);
    expect(config.apiBaseUrl).toBe("https://hedgin.xyz");
  });
  it("strips trailing slashes from the API origin", () => {
    expect(loadConfig({ ...validEnv, HEDGE_API_BASE_URL: "http://localhost:3000/" }).apiBaseUrl).toBe("http://localhost:3000");
  });
  it("rejects non-numeric user IDs", () => {
    expect(() => loadConfig({ ...validEnv, ALLOWED_TELEGRAM_USER_IDS: "111,@alice" })).toThrow(/ALLOWED_TELEGRAM_USER_IDS/);
  });
  it("names missing variables without echoing secret values", () => {
    const run = () => loadConfig({ ...validEnv, TELEGRAM_BOT_TOKEN: undefined, HEDGE_API_KEY: "not-a-key" });
    expect(run).toThrow(/TELEGRAM_BOT_TOKEN/);
    expect(run).toThrow(/HEDGE_API_KEY/);
    expect(run).not.toThrow(/not-a-key/);
  });
});

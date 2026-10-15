import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createUsernameStore } from "../src/telegram-users";

describe("username store", () => {
  it("looks names up ignoring case and persists them owner-only", () => {
    const path = join(mkdtempSync(join(tmpdir(), "hv-users-")), "nested", "telegram-users.json");
    createUsernameStore(path).record("Hedgin_Manager", 42);
    const reopened = createUsernameStore(path);
    expect(reopened.idOf("hedgin_manager")).toBe(42);
    expect(reopened.idOf("HEDGIN_MANAGER")).toBe(42);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ version: 1, names: { hedgin_manager: 42 } });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("drops the old name when a user renames, and gives a reused name to its new owner", () => {
    const store = createUsernameStore(undefined);
    store.record("old_name", 1);
    store.record("new_name", 1);
    expect(store.idOf("old_name")).toBeUndefined();
    expect(store.idOf("new_name")).toBe(1);
    store.record("new_name", 2);
    expect(store.idOf("new_name")).toBe(2);
  });

  it("does not resolve inherited object keys", () => {
    expect(createUsernameStore(undefined).idOf("__proto__")).toBeUndefined();
  });
});

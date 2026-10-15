import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

const FileSchema = z.object({
  version: z.literal(1),
  /** Lowercase username, without "@", to Telegram user id. */
  names: z.record(z.string(), z.number().int()),
});
type UsernameFile = z.infer<typeof FileSchema>;

/**
 * Who has pressed Start, by username, so the key-delivery endpoint can DM a manager it only knows
 * by @handle (Telegram bots cannot message a username directly). `path` undefined keeps it in memory (tests).
 * ponytail: one JSON file rewritten per change, like the wallet store; move with it if the bot runs replicas.
 */
export function createUsernameStore(path: string | undefined) {
  const data: UsernameFile = path ? load(path) : { version: 1, names: {} };

  function load(file: string): UsernameFile {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, names: {} };
      throw new Error(`Cannot read the username store (${(error as NodeJS.ErrnoException).code ?? "unknown error"})`);
    }
    return FileSchema.parse(JSON.parse(text));
  }

  function save(): void {
    if (!path) return;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(data), { mode: 0o600 });
    renameSync(temporary, path);
  }

  return {
    /** Maps the user's current username to them, dropping their old one. Writes only on change. */
    record(username: string, userId: number): void {
      const name = username.toLowerCase();
      if (data.names[name] === userId) return;
      for (const [other, id] of Object.entries(data.names)) if (id === userId) delete data.names[other];
      data.names[name] = userId;
      save();
    },

    idOf(username: string): number | undefined {
      const name = username.toLowerCase();
      // Own keys only: "__proto__" must not resolve to Object.prototype.
      return Object.hasOwn(data.names, name) ? data.names[name] : undefined;
    },
  };
}
export type UsernameStore = ReturnType<typeof createUsernameStore>;

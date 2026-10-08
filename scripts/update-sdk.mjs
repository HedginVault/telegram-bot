// Repacks ../sdk into vendor/ under a content-hashed name. Yarn 1 caches file: tarballs by
// name and version, so reusing one filename silently keeps installing the old build.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const bot = resolve(import.meta.dirname, "..");
const sdk = resolve(bot, "../sdk");
const vendor = join(bot, "vendor");
const packed = join(vendor, "hedginvault-sdk.tmp.tgz");

const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: "inherit" });
run("yarn", ["build"], sdk);
run("yarn", ["pack", "--filename", packed], sdk);

const hash = createHash("sha256").update(readFileSync(packed)).digest("hex").slice(0, 12);
const name = `hedginvault-sdk-${hash}.tgz`;
for (const old of readdirSync(vendor)) if (old.startsWith("hedginvault-sdk") && old !== name && !old.endsWith(".tmp.tgz")) rmSync(join(vendor, old));
renameSync(packed, join(vendor, name));
run("yarn", ["add", `file:./vendor/${name}`], bot);
console.log(`Installed vendor/${name}`);

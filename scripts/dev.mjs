// Starts one local dev process with temp/cache dirs on D: (this machine keeps everything off C:).
//   node scripts/dev.mjs <anvil|api|worker|web>
// Used by .claude/launch.json (preview panes) and handy from a terminal.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const tmp = process.env["KAZI_TMP"] ?? resolve(root, "..", ".tmp");
mkdirSync(tmp, { recursive: true });
const foundryBin = join(homedir(), ".foundry", "bin");
const env = {
  ...process.env,
  TMP: tmp,
  TEMP: tmp,
  TMPDIR: tmp,
  PATH: `${foundryBin}${process.platform === "win32" ? ";" : ":"}${process.env["PATH"] ?? ""}`,
  NEXT_TELEMETRY_DISABLED: "1",
};

const target = process.argv[2];
const commands = {
  anvil: () => {
    const dir = resolve(root, "packages/contracts/.anvil");
    mkdirSync(dir, { recursive: true });
    // Dump state every 10 s so contracts survive a hard stop of the preview.
    return ["anvil", ["--state", join(dir, "state.json"), "--state-interval", "10", "--host", "127.0.0.1"], resolve(root, "packages/contracts")];
  },
  api: () => ["pnpm", ["--filter", "@kazi/api", "dev"], root],
  worker: () => ["pnpm", ["--filter", "@kazi/worker", "dev"], root],
  web: () => ["pnpm", ["--filter", "@kazi/web", "dev"], root],
};
const make = commands[target];
if (!make) {
  console.error(`usage: node scripts/dev.mjs <${Object.keys(commands).join("|")}>`);
  process.exit(1);
}
const [cmd, args, cwd] = make();
if (target === "anvil" && !existsSync(join(foundryBin, process.platform === "win32" ? "anvil.exe" : "anvil"))) {
  console.warn("anvil not found in ~/.foundry/bin; relying on PATH");
}
const child = spawn(cmd, args, { cwd, env, stdio: "inherit", shell: process.platform === "win32" });
const stop = () => child.kill("SIGINT");
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
child.on("exit", (code) => process.exit(code ?? 0));

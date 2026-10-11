// KAZI ⇄ KAZI Credits gate on the local anvil chain: deploys a stand-in for the Argus KAZI (minted
// to anvil #1), the gate, and moves 100M local Credits into its reserve. Writes
// packages/config/deployments/local-credits-gate.json. Uses anvil's PUBLIC dev accounts — local only.
//   pnpm -F @kazi/contracts credits-gate:local
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import process from "node:process";

const local = JSON.parse(
  readFileSync(new URL("../../config/deployments/local.json", import.meta.url), "utf8"),
);
const ANVIL1 = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"; // holds the local Credits; stands in for the Safe
const ANVIL1_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"; // anvil #1 (public)
execFileSync(
  "forge",
  [
    "script",
    "script/DeployCreditsGate.s.sol",
    "--rpc-url",
    process.env.LOCAL_RPC_URL ?? "http://127.0.0.1:8545",
    "--broadcast",
    "--private-key",
    ANVIL1_KEY,
  ],
  {
    stdio: "inherit",
    shell: true,
    env: {
      ...process.env,
      KAZI_NETWORK: "local",
      KAZI_TOKEN: local.kaziToken,
      ADMIN_SAFE: ANVIL1,
      PAUSER_ADDRESS: ANVIL1,
      ARGUS_KAZI_ADDRESS: process.env.ARGUS_KAZI_ADDRESS ?? "",
      FUND_RESERVE_AMOUNT:
        process.env.FUND_RESERVE_AMOUNT ?? (100_000_000n * 10n ** 18n).toString(),
    },
  },
);

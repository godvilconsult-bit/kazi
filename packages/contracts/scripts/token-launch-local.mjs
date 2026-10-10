// Token launch rehearsal on the local anvil chain: runs script/DeployTokenLaunch.s.sol with anvil's
// PUBLIC dev accounts and writes packages/config/deployments/local-token-launch.json. Local only.
//   AIRDROP_MERKLE_ROOT=0x… pnpm -F @kazi/contracts token-launch:local
// Get the root from `pnpm -F @kazi/worker airdrop:snapshot` (see docs/08-TOKENOMICS.md §7).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import process from "node:process";

const root = process.env.AIRDROP_MERKLE_ROOT ?? "";
if (!/^0x[0-9a-fA-F]{64}$/.test(root)) {
  console.error("Set AIRDROP_MERKLE_ROOT (from the airdrop snapshot) first.");
  process.exit(1);
}
const local = JSON.parse(readFileSync(new URL("../../config/deployments/local.json", import.meta.url), "utf8"));
const ANVIL1 = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"; // holds the local $KAZI supply; stands in for the Safe
const DISTRIBUTOR_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"; // anvil #1 (public)

execFileSync(
  "forge",
  ["script", "script/DeployTokenLaunch.s.sol", "--rpc-url", process.env.LOCAL_RPC_URL ?? "http://127.0.0.1:8545", "--broadcast", "--private-key", DISTRIBUTOR_KEY],
  {
    stdio: "inherit",
    shell: true,
    env: {
      ...process.env,
      KAZI_NETWORK: "local",
      KAZI_TOKEN: local.kaziToken,
      ADMIN_SAFE: ANVIL1,
      TEAM_BENEFICIARY: "0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f", // anvil #8
      ECOSYSTEM_BENEFICIARY: "0xa0Ee7A142d267C1f36714E4a8F75612F20a79720", // anvil #9
      TREASURY_ADDRESS: local.treasury ?? "0x976EA74026E726554dB657fA54763abd0C3a0aa9", // anvil #6
      // Liquidity and community stay with anvil #1 locally, so it can still bond and test staking.
      LIQUIDITY_ADDRESS: ANVIL1,
      COMMUNITY_ADDRESS: ANVIL1,
      AIRDROP_MERKLE_ROOT: root,
    },
  },
);

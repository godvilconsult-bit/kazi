import { defineConfig } from "@wagmi/cli";
import { foundry } from "@wagmi/cli/plugins";

// Generates typed ABIs from packages/contracts (Foundry artifacts) into src/abis.ts.
// Run `pnpm -F @kazi/shared generate:abis` after changing contracts; the output is committed.
export default defineConfig({
  out: "src/abis.ts",
  plugins: [
    foundry({
      project: "../contracts",
      forge: { build: true },
      include: [
        "KaziToken.sol/**",
        "AgentRegistry.sol/**",
        "StakingVault.sol/**",
        "FeeDistributor.sol/**",
        "TaskEscrow.sol/**",
        "MockUSDC.sol/**",
        "KaziAirdrop.sol/**",
      ],
    }),
  ],
});

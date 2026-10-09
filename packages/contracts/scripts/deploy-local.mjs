// Deploys the Kazi contracts to the local anvil chain (`pnpm -F contracts dev`) and writes
// packages/config/deployments/local.json. Uses anvil's PUBLIC dev accounts — local only.
import { execFileSync } from "node:child_process";
import process from "node:process";

const ANVIL = [
  "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", // 0 deployer
  "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", // 1 admin (stands in for the Safe locally)
  "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC", // 2 operator
  "0x90F79bf6EB2c4f870365E785982E1f101E93b906", // 3 quoter
  "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65", // 4 registrar
  "0x9965a0D3D53c6e98d6A00Ae0e0BbC00A2c6d07d1", // 5 slasher
  "0x976EA74026E726554dB657fA54763abd0C3a0aa9", // 6 treasury
  "0x14dC79964da2C08b23698B3D3cc7Ca32193d9955", // 7 buyback reserve
];
const DEPLOYER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"; // anvil #0 (public)

execFileSync(
  "forge",
  [
    "script",
    "script/Deploy.s.sol",
    "--rpc-url",
    process.env.LOCAL_RPC_URL ?? "http://127.0.0.1:8545",
    "--broadcast",
    "--private-key",
    DEPLOYER_KEY,
  ],
  {
    stdio: "inherit",
    shell: true,
    env: {
      ...process.env,
      KAZI_NETWORK: "local",
      ADMIN_SAFE: ANVIL[1],
      OPERATOR_ADDRESS: ANVIL[2],
      QUOTER_ADDRESS: ANVIL[3],
      REGISTRAR_ADDRESS: ANVIL[4],
      SLASHER_ADDRESS: ANVIL[5],
      TREASURY_ADDRESS: ANVIL[6],
      BUYBACK_RESERVE_ADDRESS: ANVIL[7],
      TOKEN_DISTRIBUTOR_ADDRESS: ANVIL[1],
      USDC_ADDRESS: "",
    },
  },
);

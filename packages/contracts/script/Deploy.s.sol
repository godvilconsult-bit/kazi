// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {KaziToken} from "../src/KaziToken.sol";
import {AgentRegistry} from "../src/AgentRegistry.sol";
import {StakingVault} from "../src/StakingVault.sol";
import {FeeDistributor} from "../src/FeeDistributor.sol";
import {TaskEscrow} from "../src/TaskEscrow.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";
import {IAgentRegistry} from "../src/interfaces/IKazi.sol";

/// @notice Deploys and wires the Kazi contracts, hands every admin power to the Safe, renounces the
///         deployer, and writes addresses to packages/config/deployments/<KAZI_NETWORK>.json.
///
/// Required env: KAZI_NETWORK, ADMIN_SAFE, OPERATOR_ADDRESS, QUOTER_ADDRESS, REGISTRAR_ADDRESS,
///               SLASHER_ADDRESS, TREASURY_ADDRESS, BUYBACK_RESERVE_ADDRESS, TOKEN_DISTRIBUTOR_ADDRESS
/// USDC:         USDC_ADDRESS (required on testnet/mainnet; on local a MockUSDC is deployed if unset)
/// Optional:     TOKEN_NAME, TOKEN_SYMBOL, TOKEN_SUPPLY, FEE_BPS, GRACE_PERIOD, MIN_AGENT_STAKE,
///               MIN_HUMAN_STAKE, TREASURY_BPS, STAKER_BPS, BUYBACK_BPS, MOCK_USDC_DECIMALS
///
/// Run: forge script script/Deploy.s.sol --rpc-url $ARC_RPC_URL --broadcast --private-key <deployer>
contract Deploy is Script {
    struct Config {
        string network;
        address adminSafe;
        address operator;
        address quoter;
        address registrar;
        address slasher;
        address treasury;
        address buybackReserve;
        address tokenDistributor;
        address usdc;
    }

    struct Deployed {
        address usdc;
        KaziToken token;
        AgentRegistry registry;
        FeeDistributor distributor;
        StakingVault vault;
        TaskEscrow escrow;
    }

    error AdminMustBeContract(address adminSafe);
    error UsdcRequired(string network);
    error UnknownNetwork(string network);

    function run() external returns (Deployed memory d) {
        Config memory c = _config();

        vm.startBroadcast();
        (, address deployer,) = vm.readCallers(); // the account actually broadcasting
        d = _deploy(c, deployer);
        vm.stopBroadcast();

        _writeDeployment(c, d);
    }

    function _config() internal view returns (Config memory c) {
        c.network = vm.envString("KAZI_NETWORK");
        bool isLocal = keccak256(bytes(c.network)) == keccak256("local");
        if (
            !isLocal && keccak256(bytes(c.network)) != keccak256("testnet")
                && keccak256(bytes(c.network)) != keccak256("mainnet")
        ) {
            revert UnknownNetwork(c.network);
        }
        c.adminSafe = vm.envAddress("ADMIN_SAFE");
        c.operator = vm.envAddress("OPERATOR_ADDRESS");
        c.quoter = vm.envAddress("QUOTER_ADDRESS");
        c.registrar = vm.envAddress("REGISTRAR_ADDRESS");
        c.slasher = vm.envAddress("SLASHER_ADDRESS");
        c.treasury = vm.envAddress("TREASURY_ADDRESS");
        c.buybackReserve = vm.envAddress("BUYBACK_RESERVE_ADDRESS");
        c.tokenDistributor = vm.envAddress("TOKEN_DISTRIBUTOR_ADDRESS");
        c.usdc = vm.envOr("USDC_ADDRESS", address(0));

        // Outside local dev the admin must be a contract (the Safe), never an EOA by mistake.
        if (!isLocal && c.adminSafe.code.length == 0) revert AdminMustBeContract(c.adminSafe);
        if (!isLocal && c.usdc == address(0)) revert UsdcRequired(c.network);
    }

    function _deploy(Config memory c, address deployer) internal returns (Deployed memory d) {
        d.usdc = c.usdc != address(0)
            ? c.usdc
            : address(new MockUSDC(uint8(vm.envOr("MOCK_USDC_DECIMALS", uint256(6)))));

        d.token = new KaziToken(
            vm.envOr("TOKEN_NAME", string("Kazi")),
            vm.envOr("TOKEN_SYMBOL", string("KAZI")),
            c.tokenDistributor,
            vm.envOr("TOKEN_SUPPLY", uint256(1_000_000_000e18))
        );
        d.registry = new AgentRegistry(
            deployer,
            vm.envOr("MIN_AGENT_STAKE", uint256(10_000e18)),
            vm.envOr("MIN_HUMAN_STAKE", uint256(2_000e18))
        );
        d.distributor = new FeeDistributor(
            deployer,
            IERC20(d.usdc),
            d.token,
            c.treasury,
            c.buybackReserve,
            uint16(vm.envOr("TREASURY_BPS", uint256(5_000))),
            uint16(vm.envOr("STAKER_BPS", uint256(3_000))),
            uint16(vm.envOr("BUYBACK_BPS", uint256(2_000)))
        );
        d.vault = new StakingVault(
            deployer,
            d.token,
            IERC20(d.usdc),
            IAgentRegistry(address(d.registry)),
            address(d.distributor)
        );
        d.escrow = new TaskEscrow(
            deployer,
            IERC20(d.usdc),
            IAgentRegistry(address(d.registry)),
            address(d.distributor),
            uint16(vm.envOr("FEE_BPS", uint256(1_200))),
            uint64(vm.envOr("GRACE_PERIOD", uint256(7 days)))
        );

        // Wiring
        d.registry.setStakingVault(address(d.vault));
        d.distributor.setStakingVault(address(d.vault));
        d.vault.grantRole(d.vault.REWARD_NOTIFIER_ROLE(), address(d.distributor));

        // Backend signer roles (limited powers)
        d.registry.grantRole(d.registry.REGISTRAR_ROLE(), c.registrar);
        d.vault.grantRole(d.vault.SLASHER_ROLE(), c.slasher);
        d.escrow.grantRole(d.escrow.OPERATOR_ROLE(), c.operator);
        d.escrow.grantRole(d.escrow.QUOTER_ROLE(), c.quoter);

        // Safe gets arbitration and every admin power; deployer renounces.
        d.escrow.grantRole(d.escrow.ARBITER_ROLE(), c.adminSafe);
        _handOver(address(d.registry), c.adminSafe, deployer);
        _handOver(address(d.distributor), c.adminSafe, deployer);
        _handOver(address(d.vault), c.adminSafe, deployer);
        _handOver(address(d.escrow), c.adminSafe, deployer);
    }

    function _handOver(address target, address adminSafe, address deployer) internal {
        bytes32 adminRole = 0x00; // DEFAULT_ADMIN_ROLE
        IAccessControl(target).grantRole(adminRole, adminSafe);
        if (adminSafe != deployer) IAccessControl(target).renounceRole(adminRole, deployer);
    }

    function _writeDeployment(Config memory c, Deployed memory d) internal {
        string memory key = "deployment";
        vm.serializeString(key, "network", c.network);
        vm.serializeUint(key, "chainId", block.chainid);
        vm.serializeUint(key, "deployedAtBlock", block.number);
        vm.serializeAddress(key, "usdc", d.usdc);
        vm.serializeAddress(key, "kaziToken", address(d.token));
        vm.serializeAddress(key, "agentRegistry", address(d.registry));
        vm.serializeAddress(key, "feeDistributor", address(d.distributor));
        vm.serializeAddress(key, "stakingVault", address(d.vault));
        vm.serializeAddress(key, "taskEscrow", address(d.escrow));
        string memory json = vm.serializeAddress(key, "adminSafe", c.adminSafe);

        string memory path =
            string.concat(vm.projectRoot(), "/../config/deployments/", c.network, ".json");
        vm.writeJson(json, path);
        console2.log("Deployment written to", path);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {VestingWallet} from "@openzeppelin/contracts/finance/VestingWallet.sol";
import {KaziAirdrop} from "../src/KaziAirdrop.sol";

/// @notice Token launch allocations (docs/08-TOKENOMICS.md §1). Run by the wallet holding the
///         $KAZI supply (TOKEN_DISTRIBUTOR); writes deployments/<network>-token-launch.json.
///
///   Team & founders      15%  VestingWallet: nothing for 12 months, then linear over 24 months
///   Ecosystem & rewards  30%  VestingWallet: linear over 48 months to the ecosystem multisig
///   Early users airdrop  10%  KaziAirdrop: Merkle claims, 25% at TGE, rest linear over 6 months
///   Treasury             10%  treasury (Safe)
///   Liquidity            15%  liquidity multisig (pool + LP lock happen on the DEX, not here)
///   Community launch     20%  community launch wallet
///
/// Env: KAZI_NETWORK, KAZI_TOKEN, ADMIN_SAFE, TEAM_BENEFICIARY, ECOSYSTEM_BENEFICIARY,
///      TREASURY_ADDRESS, LIQUIDITY_ADDRESS, COMMUNITY_ADDRESS, AIRDROP_MERKLE_ROOT,
///      optional TGE_TIMESTAMP (default: now), AIRDROP_CLAIM_WINDOW (default 365 days after vesting),
///      TOKEN_LAUNCH_OUT (output path; default deployments/<network>-token-launch.json).
/// On mainnet the broadcaster must hold the whole supply; elsewhere it splits its current balance.
contract DeployTokenLaunch is Script {
    using SafeERC20 for IERC20;

    uint256 private constant BPS = 10_000;
    uint64 private constant YEAR = 365 days;
    uint64 private constant MONTH = 30 days;
    uint64 private constant AIRDROP_VESTING = 6 * MONTH;

    struct Launch {
        VestingWallet team;
        VestingWallet ecosystem;
        KaziAirdrop airdrop;
        uint256 total;
        uint64 tge;
    }

    error SupplyNotHeld(uint256 balance, uint256 supply);

    function run() external returns (Launch memory l) {
        IERC20 token = IERC20(vm.envAddress("KAZI_TOKEN"));
        l.tge = uint64(vm.envOr("TGE_TIMESTAMP", block.timestamp));

        vm.startBroadcast();
        (, address distributor,) = vm.readCallers();
        l.total = token.balanceOf(distributor);
        if (_isMainnet() && l.total != token.totalSupply()) {
            revert SupplyNotHeld(l.total, token.totalSupply());
        }
        l.team = new VestingWallet(vm.envAddress("TEAM_BENEFICIARY"), l.tge + YEAR, 2 * YEAR);
        l.ecosystem = new VestingWallet(vm.envAddress("ECOSYSTEM_BENEFICIARY"), l.tge, 48 * MONTH);
        l.airdrop = new KaziAirdrop(
            vm.envAddress("ADMIN_SAFE"),
            token,
            vm.envBytes32("AIRDROP_MERKLE_ROOT"),
            l.tge,
            AIRDROP_VESTING,
            2_500,
            l.tge + AIRDROP_VESTING + uint64(vm.envOr("AIRDROP_CLAIM_WINDOW", uint256(YEAR)))
        );
        _allocate(token, l);
        vm.stopBroadcast();

        _write(l);
    }

    function _allocate(IERC20 token, Launch memory l) internal {
        uint256 b = l.total;
        uint256 team = (b * 1_500) / BPS;
        uint256 ecosystem = (b * 3_000) / BPS;
        uint256 airdrop = (b * 1_000) / BPS;
        uint256 treasury = (b * 1_000) / BPS;
        uint256 liquidity = (b * 1_500) / BPS;
        token.safeTransfer(address(l.team), team);
        token.safeTransfer(address(l.ecosystem), ecosystem);
        token.safeTransfer(address(l.airdrop), airdrop);
        token.safeTransfer(vm.envAddress("TREASURY_ADDRESS"), treasury);
        token.safeTransfer(vm.envAddress("LIQUIDITY_ADDRESS"), liquidity);
        // 20% plus rounding dust.
        token.safeTransfer(
            vm.envAddress("COMMUNITY_ADDRESS"),
            b - team - ecosystem - airdrop - treasury - liquidity
        );
    }

    function _write(Launch memory l) internal {
        string memory network = vm.envString("KAZI_NETWORK");
        string memory key = "launch";
        vm.serializeString(key, "network", network);
        vm.serializeUint(key, "tge", l.tge);
        vm.serializeString(key, "total", vm.toString(l.total)); // string: uint256 overflows JSON numbers
        vm.serializeAddress(key, "teamVesting", address(l.team));
        vm.serializeAddress(key, "ecosystemVesting", address(l.ecosystem));
        vm.serializeAddress(key, "treasury", vm.envAddress("TREASURY_ADDRESS"));
        vm.serializeAddress(key, "liquidity", vm.envAddress("LIQUIDITY_ADDRESS"));
        vm.serializeAddress(key, "community", vm.envAddress("COMMUNITY_ADDRESS"));
        string memory json = vm.serializeAddress(key, "airdrop", address(l.airdrop));
        string memory path = vm.envOr(
            "TOKEN_LAUNCH_OUT",
            string.concat(
                vm.projectRoot(), "/../config/deployments/", network, "-token-launch.json"
            )
        );
        vm.writeJson(json, path);
        console2.log("Token launch written to", path);
    }

    function _isMainnet() internal view returns (bool) {
        return keccak256(bytes(vm.envString("KAZI_NETWORK"))) == keccak256("mainnet");
    }
}

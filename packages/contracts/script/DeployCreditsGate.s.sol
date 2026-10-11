// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {KaziToken} from "../src/KaziToken.sol";
import {KaziCreditsGate} from "../src/KaziCreditsGate.sol";

/// @notice Deploys KaziCreditsGate: KAZI on Argus ⇄ KAZI Credits, 1:1 (docs/08-TOKENOMICS.md §8).
///         Writes deployments/<network>-credits-gate.json.
///
/// Env: KAZI_NETWORK, KAZI_TOKEN (KAZI Credits = deployment.kaziToken), ADMIN_SAFE, PAUSER_ADDRESS,
///      ARGUS_KAZI_ADDRESS (the KAZI launched on Argus; local only: unset deploys a stand-in
///      minted to the broadcaster), optional FUND_RESERVE_AMOUNT (Credits base units the
///      broadcaster moves into the gate now; on mainnet the Safe funds the reserve with a
///      separate transaction), CREDITS_GATE_OUT (output path).
contract DeployCreditsGate is Script {
    using SafeERC20 for IERC20;

    error StandInOnlyLocally();

    function run() external returns (KaziCreditsGate gate) {
        IERC20Metadata credits = IERC20Metadata(vm.envAddress("KAZI_TOKEN"));
        address argus = vm.envOr("ARGUS_KAZI_ADDRESS", address(0));
        uint256 fund = vm.envOr("FUND_RESERVE_AMOUNT", uint256(0));

        vm.startBroadcast();
        (, address broadcaster,) = vm.readCallers();
        if (argus == address(0)) {
            if (!_isLocal()) revert StandInOnlyLocally();
            argus = address(
                new KaziToken("KAZI (local Argus stand-in)", "KAZI", broadcaster, 1_000_000_000e18)
            );
        }
        gate = new KaziCreditsGate(
            vm.envAddress("ADMIN_SAFE"),
            vm.envAddress("PAUSER_ADDRESS"),
            IERC20Metadata(argus),
            credits
        );
        if (fund > 0) IERC20(address(credits)).safeTransfer(address(gate), fund);
        vm.stopBroadcast();

        _write(gate, argus, address(credits));
    }

    function _write(KaziCreditsGate gate, address argus, address credits) internal {
        string memory network = vm.envString("KAZI_NETWORK");
        string memory key = "gate";
        vm.serializeString(key, "network", network);
        vm.serializeUint(key, "chainId", block.chainid);
        vm.serializeUint(key, "deployedAtBlock", block.number);
        vm.serializeAddress(key, "kazi", argus);
        vm.serializeAddress(key, "credits", credits);
        string memory json = vm.serializeAddress(key, "gate", address(gate));
        string memory path = vm.envOr(
            "CREDITS_GATE_OUT",
            string.concat(
                vm.projectRoot(), "/../config/deployments/", network, "-credits-gate.json"
            )
        );
        vm.writeJson(json, path);
        console2.log("Credits gate written to", path);
    }

    function _isLocal() internal view returns (bool) {
        return keccak256(bytes(vm.envString("KAZI_NETWORK"))) == keccak256("local");
    }
}

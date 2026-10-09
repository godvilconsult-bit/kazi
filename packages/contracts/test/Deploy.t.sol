// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Deploy} from "../script/Deploy.s.sol";
import {TaskEscrow} from "../src/TaskEscrow.sol";

/// @dev vm.setEnv is process-wide and forge runs tests in parallel, so every env-dependent
///      scenario lives in ONE test function and runs sequentially.
contract DeployScriptTest is Test {
    address internal safe = makeAddr("safe");

    function _env(string memory network) internal {
        vm.setEnv("KAZI_NETWORK", network);
        vm.setEnv("ADMIN_SAFE", vm.toString(safe));
        vm.setEnv("OPERATOR_ADDRESS", vm.toString(makeAddr("operator")));
        vm.setEnv("QUOTER_ADDRESS", vm.toString(makeAddr("quoter")));
        vm.setEnv("REGISTRAR_ADDRESS", vm.toString(makeAddr("registrar")));
        vm.setEnv("SLASHER_ADDRESS", vm.toString(makeAddr("slasher")));
        vm.setEnv("TREASURY_ADDRESS", vm.toString(makeAddr("treasury")));
        vm.setEnv("BUYBACK_RESERVE_ADDRESS", vm.toString(makeAddr("buyback")));
        vm.setEnv("TOKEN_DISTRIBUTOR_ADDRESS", vm.toString(makeAddr("tokenDistributor")));
        vm.setEnv("USDC_ADDRESS", vm.toString(address(0)));
    }

    function test_deployScript() public {
        _localDeploy_wiresRolesAndRenouncesDeployer();
        _nonLocal_requiresSafeContractAndUsdc();
    }

    function _localDeploy_wiresRolesAndRenouncesDeployer() internal {
        _env("local");
        Deploy.Deployed memory d = new Deploy().run();
        (, address deployer,) = vm.readCallers();

        TaskEscrow escrow = d.escrow;
        assertTrue(escrow.hasRole(escrow.DEFAULT_ADMIN_ROLE(), safe));
        assertTrue(escrow.hasRole(escrow.ARBITER_ROLE(), safe));
        assertTrue(escrow.hasRole(escrow.OPERATOR_ROLE(), makeAddr("operator")));
        assertTrue(escrow.hasRole(escrow.QUOTER_ROLE(), makeAddr("quoter")));
        assertFalse(escrow.hasRole(escrow.DEFAULT_ADMIN_ROLE(), deployer));
        assertFalse(d.registry.hasRole(0x00, deployer));
        assertFalse(d.vault.hasRole(0x00, deployer));
        assertFalse(d.distributor.hasRole(0x00, deployer));
        assertTrue(d.vault.hasRole(d.vault.REWARD_NOTIFIER_ROLE(), address(d.distributor)));
        assertEq(address(d.registry.stakingVault()), address(d.vault));
        assertEq(escrow.feeBps(), 1_200);
        assertEq(d.token.balanceOf(makeAddr("tokenDistributor")), 1_000_000_000e18);

        string memory path = string.concat(vm.projectRoot(), "/../config/deployments/local.json");
        assertEq(vm.parseJsonAddress(vm.readFile(path), ".taskEscrow"), address(escrow));
        vm.removeFile(path);
    }

    function _nonLocal_requiresSafeContractAndUsdc() internal {
        _env("testnet");
        Deploy script = new Deploy();
        vm.expectRevert(abi.encodeWithSelector(Deploy.AdminMustBeContract.selector, safe));
        script.run();

        vm.etch(safe, hex"00"); // pretend the Safe is deployed
        vm.expectRevert(abi.encodeWithSelector(Deploy.UsdcRequired.selector, "testnet"));
        script.run();

        vm.setEnv("KAZI_NETWORK", "devnet");
        vm.expectRevert(abi.encodeWithSelector(Deploy.UnknownNetwork.selector, "devnet"));
        script.run();
    }
}

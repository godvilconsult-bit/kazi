// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {VestingWallet} from "@openzeppelin/contracts/finance/VestingWallet.sol";
import {Deploy} from "../script/Deploy.s.sol";
import {DeployTokenLaunch} from "../script/DeployTokenLaunch.s.sol";
import {KaziToken} from "../src/KaziToken.sol";
import {TaskEscrow} from "../src/TaskEscrow.sol";

/// @dev vm.setEnv is process-wide and forge runs tests in parallel, so every env-dependent
///      scenario (both deploy scripts) lives in ONE test function and runs sequentially. Outputs go
///      to scratch files, never to the developer's real deployments/local.json.
contract DeployScriptTest is Test {
    address internal safe = makeAddr("safe");

    function _env(string memory network) internal {
        vm.setEnv("KAZI_NETWORK", network);
        vm.setEnv("ADMIN_SAFE", vm.toString(safe));
        vm.setEnv("OPERATOR_ADDRESS", vm.toString(makeAddr("operator")));
        vm.setEnv("QUOTER_ADDRESS", vm.toString(makeAddr("quoter")));
        vm.setEnv("REGISTRAR_ADDRESS", vm.toString(makeAddr("registrar")));
        vm.setEnv("EXTRA_REGISTRAR_ADDRESS", vm.toString(makeAddr("registrar2")));
        vm.setEnv("SLASHER_ADDRESS", vm.toString(makeAddr("slasher")));
        vm.setEnv("TREASURY_ADDRESS", vm.toString(makeAddr("treasury")));
        vm.setEnv("BUYBACK_RESERVE_ADDRESS", vm.toString(makeAddr("buyback")));
        vm.setEnv("TOKEN_DISTRIBUTOR_ADDRESS", vm.toString(makeAddr("tokenDistributor")));
        vm.setEnv("USDC_ADDRESS", vm.toString(address(0)));
    }

    function test_deployScript() public {
        _localDeploy_wiresRolesAndRenouncesDeployer();
        _tokenLaunch_allocatesAndVests();
        _nonLocal_requiresSafeContractAndUsdc();
    }

    function _localDeploy_wiresRolesAndRenouncesDeployer() internal {
        _env("local");
        string memory path =
            string.concat(vm.projectRoot(), "/../config/deployments/test-deploy-local.json");
        vm.setEnv("DEPLOYMENT_OUT", path);
        vm.setEnv("PAUSER_ADDRESS", vm.toString(makeAddr("guardian")));
        Deploy.Deployed memory d = new Deploy().run();
        (, address deployer,) = vm.readCallers();

        TaskEscrow escrow = d.escrow;
        assertTrue(escrow.hasRole(escrow.DEFAULT_ADMIN_ROLE(), safe));
        assertTrue(escrow.hasRole(escrow.ARBITER_ROLE(), safe));
        assertTrue(escrow.hasRole(escrow.OPERATOR_ROLE(), makeAddr("operator")));
        assertTrue(escrow.hasRole(escrow.QUOTER_ROLE(), makeAddr("quoter")));
        assertTrue(escrow.hasRole(escrow.PAUSER_ROLE(), makeAddr("guardian")));
        assertFalse(escrow.hasRole(escrow.DEFAULT_ADMIN_ROLE(), deployer));
        assertFalse(d.registry.hasRole(0x00, deployer));
        assertFalse(d.vault.hasRole(0x00, deployer));
        assertFalse(d.distributor.hasRole(0x00, deployer));
        assertTrue(d.vault.hasRole(d.vault.REWARD_NOTIFIER_ROLE(), address(d.distributor)));
        assertTrue(d.registry.hasRole(d.registry.REGISTRAR_ROLE(), makeAddr("registrar")));
        assertTrue(d.registry.hasRole(d.registry.REGISTRAR_ROLE(), makeAddr("registrar2")));
        assertEq(address(d.registry.stakingVault()), address(d.vault));
        assertEq(escrow.feeBps(), 1_200);
        assertEq(d.token.balanceOf(makeAddr("tokenDistributor")), 1_000_000_000e18);

        assertEq(vm.parseJsonAddress(vm.readFile(path), ".taskEscrow"), address(escrow));
        vm.removeFile(path);
    }

    /// DeployTokenLaunch: 15/30/10/10/15/20% allocations, team vesting (12-month cliff, 24 months
    /// linear), the JSON the API loads.
    function _tokenLaunch_allocatesAndVests() internal {
        KaziToken token = new KaziToken("Kazi", "KAZI", address(this), 1_000_000_000e18);
        DeployTokenLaunch script = new DeployTokenLaunch();
        (, address broadcaster,) = vm.readCallers();
        token.transfer(broadcaster, token.totalSupply());

        address team = makeAddr("team");
        address eco = makeAddr("eco");
        vm.setEnv("KAZI_NETWORK", "local");
        vm.setEnv("KAZI_TOKEN", vm.toString(address(token)));
        vm.setEnv("ADMIN_SAFE", vm.toString(safe));
        vm.setEnv("TEAM_BENEFICIARY", vm.toString(team));
        vm.setEnv("ECOSYSTEM_BENEFICIARY", vm.toString(eco));
        vm.setEnv("TREASURY_ADDRESS", vm.toString(makeAddr("treasury")));
        vm.setEnv("LIQUIDITY_ADDRESS", vm.toString(makeAddr("liquidity")));
        vm.setEnv("COMMUNITY_ADDRESS", vm.toString(makeAddr("community")));
        vm.setEnv("AIRDROP_MERKLE_ROOT", vm.toString(keccak256("root")));
        vm.setEnv("TGE_TIMESTAMP", vm.toString(block.timestamp));
        string memory out =
            string.concat(vm.projectRoot(), "/../config/deployments/test-token-launch.json");
        vm.setEnv("TOKEN_LAUNCH_OUT", out);

        DeployTokenLaunch.Launch memory l = script.run();
        uint256 supply = token.totalSupply();
        assertEq(token.balanceOf(address(l.team)), supply * 15 / 100);
        assertEq(token.balanceOf(address(l.ecosystem)), supply * 30 / 100);
        assertEq(token.balanceOf(address(l.airdrop)), supply * 10 / 100);
        assertEq(token.balanceOf(makeAddr("treasury")), supply * 10 / 100);
        assertEq(token.balanceOf(makeAddr("liquidity")), supply * 15 / 100);
        assertEq(token.balanceOf(makeAddr("community")), supply * 20 / 100);
        assertEq(token.balanceOf(broadcaster), 0);

        // Team: nothing for 12 months, then linear over 24 months.
        VestingWallet tw = l.team;
        address kazi = address(token);
        uint256 t0 = block.timestamp;
        vm.warp(t0 + 364 days);
        assertEq(tw.releasable(kazi), 0);
        vm.warp(t0 + 365 days + 365 days); // one year into the linear part
        assertApproxEqRel(tw.releasable(kazi), supply * 15 / 100 / 2, 0.001e18);
        tw.release(kazi);
        assertEq(token.balanceOf(team), tw.released(kazi));
        vm.warp(t0 + 365 days + 800 days);
        tw.release(kazi);
        assertEq(token.balanceOf(team), supply * 15 / 100);

        assertEq(vm.parseJsonAddress(vm.readFile(out), ".airdrop"), address(l.airdrop));
        vm.removeFile(out);
        vm.warp(t0);
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

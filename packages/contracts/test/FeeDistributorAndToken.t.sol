// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {KaziBase} from "./Base.t.sol";
import {FeeDistributor} from "../src/FeeDistributor.sol";
import {KaziToken} from "../src/KaziToken.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {ProviderKind} from "../src/interfaces/IKazi.sol";

contract FeeDistributorTest is KaziBase {
    function test_constructor_reverts() public {
        vm.expectRevert(FeeDistributor.ZeroAddress.selector);
        new FeeDistributor(address(0), usdc, kazi, treasury, buyback, 5_000, 3_000, 2_000);
        vm.expectRevert(FeeDistributor.ZeroAddress.selector);
        new FeeDistributor(admin, IERC20(address(0)), kazi, treasury, buyback, 5_000, 3_000, 2_000);
        vm.expectRevert(FeeDistributor.ZeroAddress.selector);
        new FeeDistributor(admin, usdc, IERC20(address(0)), treasury, buyback, 5_000, 3_000, 2_000);
        vm.expectRevert(FeeDistributor.ZeroAddress.selector);
        new FeeDistributor(admin, usdc, kazi, address(0), buyback, 5_000, 3_000, 2_000);
        vm.expectRevert(FeeDistributor.ZeroAddress.selector);
        new FeeDistributor(admin, usdc, kazi, treasury, address(0), 5_000, 3_000, 2_000);
        vm.expectRevert(abi.encodeWithSelector(FeeDistributor.InvalidSplit.selector, 9_999));
        new FeeDistributor(admin, usdc, kazi, treasury, buyback, 5_000, 3_000, 1_999);
    }

    function test_distribute_splits50_30_20_toStakers() public {
        // An active staker so the staker share is distributed rather than queued.
        uint256 id = _activeProvider(dev, ProviderKind.AGENT);
        vm.warp(block.timestamp + 1 days);
        bytes32[] memory keys = new bytes32[](1);
        keys[0] = vault.providerKey(id);
        vault.poke(keys);

        usdc.mint(address(distributor), 1_000e6 + 1); // +1 dust goes to buyback
        vm.expectEmit(address(distributor));
        emit FeeDistributor.Distributed(1_000e6 + 1, 500e6, 300e6, 200e6 + 1);
        vm.prank(makeAddr("keeper"));
        distributor.distribute();

        assertEq(usdc.balanceOf(treasury), 500e6);
        assertEq(usdc.balanceOf(buyback), 200e6 + 1);
        assertEq(usdc.balanceOf(address(vault)), 300e6);
        assertEq(vault.earned(keys[0]), 300e6);

        vm.expectRevert(FeeDistributor.NothingToDistribute.selector);
        distributor.distribute();
    }

    function test_distribute_zeroStakerShareSkipsVault_andRequiresVaultOtherwise() public {
        FeeDistributor noVault =
            new FeeDistributor(admin, usdc, kazi, treasury, buyback, 5_000, 3_000, 2_000);
        usdc.mint(address(noVault), 100);
        vm.expectRevert(FeeDistributor.StakingVaultNotSet.selector);
        noVault.distribute();

        vm.prank(admin);
        noVault.setSplit(8_000, 0, 2_000);
        noVault.distribute();
        assertEq(usdc.balanceOf(treasury), 80);
        assertEq(usdc.balanceOf(buyback), 20);
    }

    function test_distribute_tinyAmountRoundsToBuyback() public {
        vm.prank(admin);
        distributor.setSplit(5_000, 0, 5_000);
        usdc.mint(address(distributor), 1);
        distributor.distribute();
        assertEq(usdc.balanceOf(buyback), 1);
        assertEq(usdc.balanceOf(treasury), 0);
    }

    function test_compensate_fromInsurancePool() public {
        _giveKazi(address(distributor), 100e18);
        vm.startPrank(admin);
        distributor.compensate(client, 40e18);
        vm.expectRevert(FeeDistributor.ZeroAddress.selector);
        distributor.compensate(address(0), 1);
        vm.expectRevert(FeeDistributor.ZeroAmount.selector);
        distributor.compensate(client, 0);
        vm.stopPrank();
        assertEq(kazi.balanceOf(client), 40e18);

        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, client, bytes32(0)
            )
        );
        vm.prank(client);
        distributor.compensate(client, 1);
    }

    function test_admin_setters() public {
        vm.startPrank(admin);
        distributor.setTreasury(client);
        assertEq(distributor.treasury(), client);
        distributor.setBuybackReserve(client);
        assertEq(distributor.buybackReserve(), client);
        distributor.setStakingVault(client);
        assertEq(address(distributor.stakingVault()), client);
        vm.expectRevert(FeeDistributor.ZeroAddress.selector);
        distributor.setTreasury(address(0));
        vm.expectRevert(FeeDistributor.ZeroAddress.selector);
        distributor.setBuybackReserve(address(0));
        vm.expectRevert(FeeDistributor.ZeroAddress.selector);
        distributor.setStakingVault(address(0));
        vm.expectRevert(abi.encodeWithSelector(FeeDistributor.InvalidSplit.selector, 10_001));
        distributor.setSplit(5_000, 3_000, 2_001);
        vm.stopPrank();
    }
}

contract KaziTokenTest is KaziBase {
    function test_fixedSupplyMintedToDistributor() public view {
        assertEq(kazi.totalSupply(), SUPPLY);
        assertEq(kazi.balanceOf(admin), SUPPLY);
        assertEq(kazi.name(), "Kazi");
        assertEq(kazi.symbol(), "KAZI");
        assertEq(kazi.CLOCK_MODE(), "mode=timestamp");
        assertEq(kazi.clock(), block.timestamp);
    }

    function test_constructor_reverts() public {
        vm.expectRevert(KaziToken.ZeroAddress.selector);
        new KaziToken("K", "K", address(0), 1);
        vm.expectRevert(KaziToken.ZeroSupply.selector);
        new KaziToken("K", "K", admin, 0);
    }

    function test_votesFollowDelegationAndTransfers() public {
        vm.prank(admin);
        kazi.delegate(admin);
        assertEq(kazi.getVotes(admin), SUPPLY);
        _giveKazi(client, 100e18);
        assertEq(kazi.getVotes(admin), SUPPLY - 100e18);
        assertEq(kazi.nonces(client), 0);
    }
}

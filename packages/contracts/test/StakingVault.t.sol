// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {KaziBase} from "./Base.t.sol";
import {StakingVault} from "../src/StakingVault.sol";
import {IAgentRegistry, ProviderKind} from "../src/interfaces/IKazi.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

contract StakingVaultTest is KaziBase {
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal notifier = makeAddr("notifier");

    function setUp() public virtual override {
        super.setUp();
        vm.startPrank(admin);
        vault.grantRole(vault.REWARD_NOTIFIER_ROLE(), notifier);
        vm.stopPrank();
    }

    function _stake(address who, uint256 amount) internal {
        _giveKazi(who, amount);
        vm.startPrank(who);
        kazi.approve(address(vault), amount);
        vault.stake(amount);
        vm.stopPrank();
    }

    function _notify(uint256 amount) internal {
        usdc.mint(notifier, amount);
        vm.startPrank(notifier);
        usdc.approve(address(vault), amount);
        vault.notifyReward(amount);
        vm.stopPrank();
    }

    function _activate(address who) internal {
        bytes32[] memory keys = new bytes32[](1);
        keys[0] = vault.holderKey(who);
        vault.poke(keys);
    }

    function _registered(address owner) internal returns (uint256 id) {
        vm.prank(owner);
        id = registry.register(ProviderKind.AGENT, payout, "ipfs://m", bytes32(0));
    }

    function _bond(address owner, uint256 id, uint256 amount) internal {
        _giveKazi(owner, amount);
        vm.startPrank(owner);
        kazi.approve(address(vault), amount);
        vault.bond(id, amount);
        vm.stopPrank();
    }

    // ─── Constructor ─────────────────────────────────────────────────────────

    function test_constructor_revertsOnZeroAddresses() public {
        IAgentRegistry reg = IAgentRegistry(address(registry));
        address pool = address(distributor);
        vm.expectRevert(StakingVault.ZeroAddress.selector);
        new StakingVault(address(0), kazi, usdc, reg, pool);
        vm.expectRevert(StakingVault.ZeroAddress.selector);
        new StakingVault(admin, IERC20(address(0)), usdc, reg, pool);
        vm.expectRevert(StakingVault.ZeroAddress.selector);
        new StakingVault(admin, kazi, IERC20(address(0)), reg, pool);
        vm.expectRevert(StakingVault.ZeroAddress.selector);
        new StakingVault(admin, kazi, usdc, IAgentRegistry(address(0)), pool);
        vm.expectRevert(StakingVault.ZeroAddress.selector);
        new StakingVault(admin, kazi, usdc, reg, address(0));
    }

    // ─── Holder staking & warm-up ────────────────────────────────────────────

    function test_stake_isPendingUntilWarmupAndActivation() public {
        _stake(alice, 1_000e18);
        StakingVault.Account memory a = vault.getAccount(vault.holderKey(alice));
        assertEq(a.pending, 1_000e18);
        assertEq(a.active, 0);
        assertEq(vault.totalActive(), 0);
        assertEq(vault.stakeOf(alice), 1_000e18);

        _activate(alice); // too early: nothing changes
        assertEq(vault.totalActive(), 0);

        vm.warp(block.timestamp + 1 days);
        _activate(alice);
        assertEq(vault.totalActive(), 1_000e18);
        assertEq(vault.getAccount(vault.holderKey(alice)).active, 1_000e18);
    }

    /// @dev Flash staking: stake right before a fee notification earns nothing.
    function test_flashStakeEarnsNothing() public {
        _stake(alice, 1_000e18);
        vm.warp(block.timestamp + 1 days);
        _activate(alice);

        _stake(bob, 1_000_000e18); // whale stakes just before distribution
        _notify(1_000e6);
        assertEq(vault.earned(vault.holderKey(alice)), 1_000e6);
        assertEq(vault.earned(vault.holderKey(bob)), 0);
    }

    function test_topUpRestartsWarmupOfPendingBucket() public {
        _stake(alice, 100e18);
        vm.warp(block.timestamp + 12 hours);
        _stake(alice, 100e18);
        vm.warp(block.timestamp + 12 hours);
        _activate(alice);
        assertEq(vault.totalActive(), 0);
        vm.warp(block.timestamp + 12 hours);
        _activate(alice);
        assertEq(vault.totalActive(), 200e18);
    }

    function test_stake_revertsOnZero() public {
        vm.prank(alice);
        vm.expectRevert(StakingVault.ZeroAmount.selector);
        vault.stake(0);
    }

    function test_unstake_takesPendingFirstThenActive_andWithdrawsAfterCooldown() public {
        _stake(alice, 100e18);
        vm.warp(block.timestamp + 1 days);
        _activate(alice);
        _stake(alice, 50e18); // pending

        vm.prank(alice);
        vault.requestUnstake(80e18);
        StakingVault.Account memory a = vault.getAccount(vault.holderKey(alice));
        assertEq(a.pending, 0);
        assertEq(a.active, 70e18);
        assertEq(a.unbonding, 80e18);
        assertEq(vault.totalActive(), 70e18);

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(StakingVault.CooldownActive.selector, a.unbondReadyAt)
        );
        vault.withdraw();

        vm.warp(a.unbondReadyAt);
        vm.prank(alice);
        vault.withdraw();
        assertEq(kazi.balanceOf(alice), 80e18);
        assertEq(vault.totalTracked(), 70e18);

        vm.prank(alice);
        vm.expectRevert(StakingVault.NothingToWithdraw.selector);
        vault.withdraw();
    }

    function test_unstake_reverts() public {
        _stake(alice, 10e18);
        vm.startPrank(alice);
        vm.expectRevert(StakingVault.ZeroAmount.selector);
        vault.requestUnstake(0);
        vm.expectRevert(
            abi.encodeWithSelector(StakingVault.InsufficientStake.selector, 10e18, 11e18)
        );
        vault.requestUnstake(11e18);
        vm.stopPrank();
    }

    function test_unstakingStakeStopsEarning() public {
        _stake(alice, 100e18);
        _stake(bob, 100e18);
        vm.warp(block.timestamp + 1 days);
        _activate(alice);
        _activate(bob);
        vm.prank(bob);
        vault.requestUnstake(100e18);
        _notify(500e6);
        assertEq(vault.earned(vault.holderKey(alice)), 500e6);
        assertEq(vault.earned(vault.holderKey(bob)), 0);
    }

    // ─── Rewards ─────────────────────────────────────────────────────────────

    function test_rewards_proRataAndClaim() public {
        _stake(alice, 300e18);
        _stake(bob, 100e18);
        vm.warp(block.timestamp + 1 days);
        _activate(alice);
        _activate(bob);
        _notify(400e6);

        vm.prank(alice);
        vault.claim();
        vm.prank(bob);
        vault.claim();
        assertEq(usdc.balanceOf(alice), 300e6);
        assertEq(usdc.balanceOf(bob), 100e6);
        assertEq(vault.totalRewardsClaimed(), 400e6);

        vm.prank(alice);
        vm.expectRevert(StakingVault.ZeroAmount.selector);
        vault.claim();
    }

    function test_rewards_queuedWhenNoActiveStake() public {
        _notify(100e6);
        assertEq(vault.queuedRewards(), 100e6);
        assertEq(vault.rewardPerTokenStored(), 0);

        _stake(alice, 10e18);
        vm.warp(block.timestamp + 1 days);
        _activate(alice);
        _notify(50e6);
        assertEq(vault.queuedRewards(), 0);
        assertEq(vault.earned(vault.holderKey(alice)), 150e6);
    }

    function test_notifyReward_reverts() public {
        vm.prank(notifier);
        vm.expectRevert(StakingVault.ZeroAmount.selector);
        vault.notifyReward(0);

        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector,
                alice,
                vault.REWARD_NOTIFIER_ROLE()
            )
        );
        vm.prank(alice);
        vault.notifyReward(1);
    }

    /// @dev Tiny reward against a huge stake must not round to zero at the accumulator level.
    function test_rewards_precisionWithFullSupplyStaked() public {
        _stake(alice, SUPPLY / 2);
        vm.warp(block.timestamp + 1 days);
        _activate(alice);
        _notify(1); // 0.000001 USDC
        assertGt(vault.rewardPerTokenStored(), 0);
    }

    // ─── Provider bonds ──────────────────────────────────────────────────────

    function test_bond_andStakedOf() public {
        uint256 id = _registered(dev);
        _bond(dev, id, 500e18);
        assertEq(vault.stakedOf(id), 500e18);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(StakingVault.NotProviderOwner.selector, id));
        vault.bond(id, 1);

        vm.prank(dev);
        registry.delist(id);
        vm.prank(dev);
        vm.expectRevert(abi.encodeWithSelector(StakingVault.ProviderDelisted.selector, id));
        vault.bond(id, 1);
    }

    function test_requestUnbond_activeProviderCannotDropBelowMinimum() public {
        uint256 id = _activeProvider(dev, ProviderKind.AGENT);
        _bond(dev, id, 1_000e18); // 1,000 above the minimum

        vm.startPrank(dev);
        vm.expectRevert(
            abi.encodeWithSelector(
                StakingVault.BelowMinimumStake.selector, id, MIN_AGENT - 1, MIN_AGENT
            )
        );
        vault.requestUnbond(id, 1_000e18 + 1);
        vm.expectRevert(
            abi.encodeWithSelector(StakingVault.BelowMinimumStake.selector, id, 0, MIN_AGENT)
        );
        vault.requestUnbond(id, MIN_AGENT * 10);

        vault.requestUnbond(id, 1_000e18);
        vm.stopPrank();
        assertEq(vault.stakedOf(id), MIN_AGENT);
    }

    function test_unbond_inactiveProviderCanLeaveFully_afterCooldown() public {
        uint256 id = _activeProvider(dev, ProviderKind.AGENT);
        vm.prank(dev);
        registry.delist(id);

        vm.prank(dev);
        vault.requestUnbond(id, MIN_AGENT);
        StakingVault.Account memory a = vault.getAccount(vault.providerKey(id));
        assertEq(a.unbondReadyAt, block.timestamp + 14 days);

        vm.prank(dev);
        vm.expectRevert(
            abi.encodeWithSelector(StakingVault.CooldownActive.selector, a.unbondReadyAt)
        );
        vault.withdrawUnbonded(id);

        vm.warp(a.unbondReadyAt);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(StakingVault.NotProviderOwner.selector, id));
        vault.withdrawUnbonded(id);

        vm.prank(dev);
        vault.withdrawUnbonded(id);
        assertEq(kazi.balanceOf(dev), MIN_AGENT);
    }

    function test_providerBondsEarnRewards() public {
        uint256 id = _activeProvider(dev, ProviderKind.AGENT);
        vm.warp(block.timestamp + 1 days);
        bytes32[] memory keys = new bytes32[](1);
        keys[0] = vault.providerKey(id);
        vault.poke(keys);
        _notify(70e6);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(StakingVault.NotProviderOwner.selector, id));
        vault.claimProviderRewards(id);

        vm.prank(dev);
        vault.claimProviderRewards(id);
        assertEq(usdc.balanceOf(dev), 70e6);
    }

    // ─── Slashing ────────────────────────────────────────────────────────────

    function test_slash_takesUnbondingThenPendingThenActive() public {
        uint256 id = _activeProvider(dev, ProviderKind.AGENT); // 10,000 pending
        vm.warp(block.timestamp + 1 days);
        _bond(dev, id, 2_000e18); // activates 10,000; 2,000 pending
        vm.prank(registrar);
        registry.suspend(id);
        vm.prank(dev);
        vault.requestUnbond(id, 3_000e18); // 2,000 from pending, 1,000 from active

        // total 12,000 → cap 2,400
        vm.prank(slasher);
        vm.expectRevert(
            abi.encodeWithSelector(StakingVault.SlashTooLarge.selector, 2_401e18, 2_400e18)
        );
        vault.slash(id, 2_401e18, keccak256("reason"));

        vm.prank(dev);
        vault.requestUnbond(id, 1e18); // unbonding 3,001 — pending is empty again
        _bond(dev, id, 500e18); // pending 500

        StakingVault.Account memory before = vault.getAccount(vault.providerKey(id));
        // unbonding 3,001 / pending 500 / active 8,999 → slash 2,500 (cap = 12,500 * 20% = 2,500)
        vm.expectEmit(address(vault));
        emit StakingVault.Slashed(id, 2_500e18, keccak256("reason"));
        vm.prank(slasher);
        vault.slash(id, 2_500e18, keccak256("reason"));

        StakingVault.Account memory afterSlash = vault.getAccount(vault.providerKey(id));
        assertEq(afterSlash.unbonding, before.unbonding - 2_500e18);
        assertEq(kazi.balanceOf(address(distributor)), 2_500e18);

        // Second slash spills past unbonding into pending and active.
        vm.prank(slasher);
        vault.slash(id, 1_500e18, keccak256("again"));
        StakingVault.Account memory finalState = vault.getAccount(vault.providerKey(id));
        assertEq(finalState.unbonding, 0);
        assertEq(finalState.pending, 0);
        assertEq(
            finalState.active,
            before.active - (1_500e18 - (before.unbonding - 2_500e18) - before.pending)
        );
        assertEq(vault.totalActive(), finalState.active);
        assertEq(kazi.balanceOf(address(vault)), vault.totalTracked());
    }

    function test_slash_reverts() public {
        uint256 id = _activeProvider(dev, ProviderKind.AGENT);
        vm.prank(slasher);
        vm.expectRevert(StakingVault.ZeroAmount.selector);
        vault.slash(id, 0, bytes32(0));

        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, dev, vault.SLASHER_ROLE()
            )
        );
        vm.prank(dev);
        vault.slash(id, 1, bytes32(0));
    }

    // ─── Admin ───────────────────────────────────────────────────────────────

    function test_admin_setters() public {
        vm.startPrank(admin);
        vault.setInsurancePool(alice);
        assertEq(vault.insurancePool(), alice);
        vm.expectRevert(StakingVault.ZeroAddress.selector);
        vault.setInsurancePool(address(0));

        vault.setCooldowns(3 days, 21 days);
        assertEq(vault.holderCooldown(), 3 days);
        assertEq(vault.providerCooldown(), 21 days);
        vm.expectRevert(abi.encodeWithSelector(StakingVault.InvalidCooldown.selector, uint64(0)));
        vault.setCooldowns(0, 1 days);
        vm.expectRevert(
            abi.encodeWithSelector(StakingVault.InvalidCooldown.selector, uint64(61 days))
        );
        vault.setCooldowns(1 days, 61 days);

        vault.setMaxSlashBps(1_000);
        assertEq(vault.maxSlashBps(), 1_000);
        vm.expectRevert(abi.encodeWithSelector(StakingVault.InvalidSlashBps.selector, uint16(0)));
        vault.setMaxSlashBps(0);
        vm.expectRevert(
            abi.encodeWithSelector(StakingVault.InvalidSlashBps.selector, uint16(5_001))
        );
        vault.setMaxSlashBps(5_001);
        vm.stopPrank();

        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, alice, bytes32(0)
            )
        );
        vm.prank(alice);
        vault.setMaxSlashBps(100);
    }

    // ─── Fuzz ────────────────────────────────────────────────────────────────

    function testFuzz_rewardsSplitProRata(uint96 stakeA, uint96 stakeB, uint64 reward) public {
        stakeA = uint96(bound(stakeA, 1e18, SUPPLY / 4));
        stakeB = uint96(bound(stakeB, 1e18, SUPPLY / 4));
        reward = uint64(bound(reward, 1, 1e15));
        _stake(alice, stakeA);
        _stake(bob, stakeB);
        vm.warp(block.timestamp + 1 days);
        _activate(alice);
        _activate(bob);
        _notify(reward);

        uint256 earnedA = vault.earned(vault.holderKey(alice));
        uint256 earnedB = vault.earned(vault.holderKey(bob));
        assertLe(earnedA + earnedB, reward);
        assertApproxEqAbs(earnedA, (uint256(reward) * stakeA) / (uint256(stakeA) + stakeB), 1);
    }
}

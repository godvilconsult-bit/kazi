// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {KaziToken} from "../src/KaziToken.sol";
import {KaziCreditsGate} from "../src/KaziCreditsGate.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";

/// @dev A token that burns 1% of every transfer (fee-on-transfer), which the gate must refuse.
contract FeeOnTransferToken is ERC20 {
    constructor(address to, uint256 supply) ERC20("Taxed", "TAX") {
        _mint(to, supply);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) {
            uint256 fee = value / 100;
            super._update(from, address(0), fee);
            value -= fee;
        }
        super._update(from, to, value);
    }
}

contract KaziCreditsGateTest is Test {
    uint256 internal constant SUPPLY = 1_000_000_000e18;

    KaziToken internal kazi; // stands in for KAZI on Argus
    KaziToken internal credits;
    KaziCreditsGate internal gate;

    address internal safe = makeAddr("safe");
    address internal guardian = makeAddr("guardian");
    address internal market = makeAddr("market");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    event Locked(address indexed account, uint256 amount);
    event Unlocked(address indexed account, uint256 amount);
    event Paused(address indexed by);
    event Unpaused(address indexed by);

    function setUp() public {
        kazi = new KaziToken("KAZI", "KAZI", market, SUPPLY);
        credits = new KaziToken("KAZI Credits", "KCRED", safe, SUPPLY);
        gate = new KaziCreditsGate(safe, guardian, kazi, credits);
        vm.prank(safe);
        credits.transfer(address(gate), SUPPLY); // the whole Credits supply is the reserve

        vm.startPrank(market);
        kazi.transfer(alice, 1_000_000e18);
        kazi.transfer(bob, 1_000_000e18);
        vm.stopPrank();
    }

    function _lock(address who, uint256 amount) internal {
        vm.startPrank(who);
        kazi.approve(address(gate), amount);
        gate.lock(amount);
        vm.stopPrank();
    }

    function _unlock(address who, uint256 amount) internal {
        vm.startPrank(who);
        credits.approve(address(gate), amount);
        gate.unlock(amount);
        vm.stopPrank();
    }

    // ─── Constructor ─────────────────────────────────────────────────────────

    function test_constructor_setsRolesAndTokens() public view {
        assertTrue(gate.hasRole(gate.DEFAULT_ADMIN_ROLE(), safe));
        assertTrue(gate.hasRole(gate.PAUSER_ROLE(), guardian));
        assertFalse(gate.hasRole(gate.DEFAULT_ADMIN_ROLE(), guardian));
        assertEq(address(gate.kazi()), address(kazi));
        assertEq(address(gate.credits()), address(credits));
        assertEq(gate.totalLocked(), 0);
        assertFalse(gate.paused());
    }

    function test_constructor_revertsOnZeroAddresses() public {
        vm.expectRevert(KaziCreditsGate.ZeroAddress.selector);
        new KaziCreditsGate(address(0), guardian, kazi, credits);
        vm.expectRevert(KaziCreditsGate.ZeroAddress.selector);
        new KaziCreditsGate(safe, address(0), kazi, credits);
        vm.expectRevert(KaziCreditsGate.ZeroAddress.selector);
        new KaziCreditsGate(safe, guardian, IERC20Metadata(address(0)), credits);
        vm.expectRevert(KaziCreditsGate.ZeroAddress.selector);
        new KaziCreditsGate(safe, guardian, kazi, IERC20Metadata(address(0)));
    }

    function test_constructor_revertsOnSameToken() public {
        vm.expectRevert(KaziCreditsGate.SameToken.selector);
        new KaziCreditsGate(safe, guardian, credits, credits);
    }

    function test_constructor_revertsOnDecimalsMismatch() public {
        MockUSDC six = new MockUSDC(6);
        vm.expectRevert(abi.encodeWithSelector(KaziCreditsGate.DecimalsMismatch.selector, 6, 18));
        new KaziCreditsGate(safe, guardian, six, credits);
    }

    // ─── lock ────────────────────────────────────────────────────────────────

    function test_lock_paysCreditsOneToOne() public {
        vm.startPrank(alice);
        kazi.approve(address(gate), 2_500e18);
        vm.expectEmit(address(gate));
        emit Locked(alice, 2_500e18);
        gate.lock(2_500e18);
        vm.stopPrank();

        assertEq(credits.balanceOf(alice), 2_500e18);
        assertEq(kazi.balanceOf(alice), 1_000_000e18 - 2_500e18);
        assertEq(kazi.balanceOf(address(gate)), 2_500e18);
        assertEq(gate.totalLocked(), 2_500e18);
        assertEq(gate.reserve(), SUPPLY - 2_500e18);
        assertEq(gate.outstanding(), 2_500e18);
        assertTrue(gate.fullyBacked());
    }

    function test_lock_revertsOnZero() public {
        vm.prank(alice);
        vm.expectRevert(KaziCreditsGate.ZeroAmount.selector);
        gate.lock(0);
    }

    function test_lock_revertsWhenPaused() public {
        vm.prank(guardian);
        gate.pause();
        vm.startPrank(alice);
        kazi.approve(address(gate), 1e18);
        vm.expectRevert(KaziCreditsGate.LockPaused.selector);
        gate.lock(1e18);
        vm.stopPrank();
    }

    function test_lock_revertsWhenReserveTooSmall() public {
        KaziToken c2 = new KaziToken("KAZI Credits", "KCRED", safe, SUPPLY);
        KaziCreditsGate g2 = new KaziCreditsGate(safe, guardian, kazi, c2);
        vm.prank(safe);
        c2.transfer(address(g2), 10e18);
        vm.startPrank(alice);
        kazi.approve(address(g2), 11e18);
        vm.expectRevert(
            abi.encodeWithSelector(KaziCreditsGate.InsufficientReserve.selector, 10e18, 11e18)
        );
        g2.lock(11e18);
        vm.stopPrank();
    }

    function test_lock_revertsOnFeeOnTransferToken() public {
        FeeOnTransferToken taxed = new FeeOnTransferToken(alice, 1_000e18);
        KaziCreditsGate g2 = new KaziCreditsGate(safe, guardian, taxed, credits);
        vm.prank(address(gate)); // borrow some reserve for the second gate
        credits.transfer(address(g2), 1_000e18);
        vm.startPrank(alice);
        taxed.approve(address(g2), 100e18);
        vm.expectRevert(
            abi.encodeWithSelector(KaziCreditsGate.TransferFeeNotSupported.selector, 99e18, 100e18)
        );
        g2.lock(100e18);
        vm.stopPrank();
    }

    function test_lock_revertsWithoutApproval() public {
        vm.prank(alice);
        vm.expectRevert();
        gate.lock(1e18);
    }

    // ─── unlock ──────────────────────────────────────────────────────────────

    function test_unlock_returnsKaziOneToOne() public {
        _lock(alice, 1_000e18);
        vm.startPrank(alice);
        credits.approve(address(gate), 400e18);
        vm.expectEmit(address(gate));
        emit Unlocked(alice, 400e18);
        gate.unlock(400e18);
        vm.stopPrank();

        assertEq(credits.balanceOf(alice), 600e18);
        assertEq(kazi.balanceOf(alice), 1_000_000e18 - 600e18);
        assertEq(gate.totalLocked(), 600e18);
        assertEq(gate.reserve(), SUPPLY - 600e18);
        assertTrue(gate.fullyBacked());
    }

    function test_unlock_worksForAnyCreditHolder() public {
        _lock(alice, 1_000e18);
        vm.prank(alice);
        credits.transfer(bob, 300e18); // Credits are fungible: whoever holds them can exit
        _unlock(bob, 300e18);
        assertEq(kazi.balanceOf(bob), 1_000_000e18 + 300e18);
        assertEq(gate.totalLocked(), 700e18);
    }

    function test_unlock_worksWhilePaused() public {
        _lock(alice, 1_000e18);
        vm.prank(guardian);
        gate.pause();
        _unlock(alice, 1_000e18);
        assertEq(kazi.balanceOf(alice), 1_000_000e18);
        assertEq(gate.totalLocked(), 0);
    }

    function test_unlock_revertsOnZero() public {
        vm.prank(alice);
        vm.expectRevert(KaziCreditsGate.ZeroAmount.selector);
        gate.unlock(0);
    }

    function test_unlock_revertsAboveLocked() public {
        // Credits that never went through the gate cannot take KAZI locked by others.
        KaziToken c2 = new KaziToken("KAZI Credits", "KCRED", safe, SUPPLY);
        KaziCreditsGate g2 = new KaziCreditsGate(safe, guardian, kazi, c2);
        vm.startPrank(safe);
        c2.transfer(address(g2), SUPPLY / 2);
        c2.transfer(bob, 1_000e18);
        vm.stopPrank();
        vm.startPrank(alice);
        kazi.approve(address(g2), 100e18);
        g2.lock(100e18);
        vm.stopPrank();
        assertFalse(g2.fullyBacked()); // bob's Credits are not backed

        vm.startPrank(bob);
        c2.approve(address(g2), 101e18);
        vm.expectRevert(
            abi.encodeWithSelector(KaziCreditsGate.InsufficientLocked.selector, 100e18, 101e18)
        );
        g2.unlock(101e18);
        vm.stopPrank();
    }

    // ─── Pause ───────────────────────────────────────────────────────────────

    function test_pause_onlyGuardian_unpause_onlyAdmin() public {
        bytes32 pauserRole = gate.PAUSER_ROLE();
        bytes32 adminRole = gate.DEFAULT_ADMIN_ROLE();
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, alice, pauserRole
            )
        );
        gate.pause();

        vm.prank(guardian);
        vm.expectEmit(address(gate));
        emit Paused(guardian);
        gate.pause();
        assertTrue(gate.paused());

        vm.prank(guardian);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, guardian, adminRole
            )
        );
        gate.unpause();

        vm.prank(safe);
        vm.expectEmit(address(gate));
        emit Unpaused(safe);
        gate.unpause();
        assertFalse(gate.paused());
        _lock(alice, 1e18);
        assertEq(credits.balanceOf(alice), 1e18);
    }

    // ─── Views ───────────────────────────────────────────────────────────────

    function test_fullyBacked_falseWhileCreditsCirculateOutsideTheGate() public {
        KaziToken c2 = new KaziToken("KAZI Credits", "KCRED", safe, SUPPLY);
        KaziCreditsGate g2 = new KaziCreditsGate(safe, guardian, kazi, c2);
        assertFalse(g2.fullyBacked()); // nothing deposited yet: the whole supply sits with the Safe
        assertEq(g2.outstanding(), SUPPLY);
        vm.prank(safe);
        c2.transfer(address(g2), SUPPLY);
        assertTrue(g2.fullyBacked());
        assertEq(g2.outstanding(), 0);
        assertEq(g2.reserve(), SUPPLY);
    }

    // ─── Fuzz ────────────────────────────────────────────────────────────────

    function testFuzz_lockThenUnlockRoundTrips(uint256 lockAmount, uint256 unlockAmount) public {
        lockAmount = bound(lockAmount, 1, 1_000_000e18);
        unlockAmount = bound(unlockAmount, 1, lockAmount);
        _lock(alice, lockAmount);
        _unlock(alice, unlockAmount);

        assertEq(kazi.balanceOf(alice), 1_000_000e18 - lockAmount + unlockAmount);
        assertEq(credits.balanceOf(alice), lockAmount - unlockAmount);
        assertEq(gate.totalLocked(), lockAmount - unlockAmount);
        assertEq(kazi.balanceOf(address(gate)), gate.totalLocked());
        assertEq(gate.outstanding(), gate.totalLocked());
        assertTrue(gate.fullyBacked());
    }
}

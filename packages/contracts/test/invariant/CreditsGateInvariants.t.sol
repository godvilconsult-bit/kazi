// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {KaziToken} from "../../src/KaziToken.sol";
import {KaziCreditsGate} from "../../src/KaziCreditsGate.sol";

contract CreditsGateHandler is Test {
    KaziCreditsGate internal gate;
    KaziToken internal kazi;
    KaziToken internal credits;
    address internal guardian;
    address internal admin;
    address[3] internal actors;

    constructor(
        KaziCreditsGate gate_,
        KaziToken kazi_,
        KaziToken credits_,
        address guardian_,
        address admin_,
        address[3] memory actors_
    ) {
        gate = gate_;
        kazi = kazi_;
        credits = credits_;
        guardian = guardian_;
        admin = admin_;
        actors = actors_;
    }

    function lock(uint256 actorSeed, uint256 amount) external {
        address a = actors[actorSeed % actors.length];
        uint256 balance = kazi.balanceOf(a);
        if (balance == 0 || gate.paused()) return;
        amount = bound(amount, 1, balance);
        vm.startPrank(a);
        kazi.approve(address(gate), amount);
        gate.lock(amount);
        vm.stopPrank();
    }

    function unlock(uint256 actorSeed, uint256 amount) external {
        address a = actors[actorSeed % actors.length];
        uint256 balance = credits.balanceOf(a);
        if (balance == 0) return;
        amount = bound(amount, 1, balance);
        vm.startPrank(a);
        credits.approve(address(gate), amount);
        gate.unlock(amount);
        vm.stopPrank();
    }

    function transferCredits(uint256 fromSeed, uint256 toSeed, uint256 amount) external {
        address from = actors[fromSeed % actors.length];
        address to = actors[toSeed % actors.length];
        uint256 balance = credits.balanceOf(from);
        if (balance == 0) return;
        amount = bound(amount, 1, balance);
        vm.prank(from);
        credits.transfer(to, amount);
    }

    function togglePause(bool on) external {
        if (on) {
            vm.prank(guardian);
            gate.pause();
        } else {
            vm.prank(admin);
            gate.unpause();
        }
    }
}

contract CreditsGateInvariantTest is Test {
    uint256 internal constant SUPPLY = 1_000_000_000e18;
    uint256 internal constant HELD = 10_000_000e18;

    KaziToken internal kazi;
    KaziToken internal credits;
    KaziCreditsGate internal gate;
    CreditsGateHandler internal handler;
    address[3] internal actors;

    function setUp() public {
        address safe = makeAddr("safe");
        address guardian = makeAddr("guardian");
        address market = makeAddr("market");
        actors = [makeAddr("a0"), makeAddr("a1"), makeAddr("a2")];

        kazi = new KaziToken("KAZI", "KAZI", market, SUPPLY);
        credits = new KaziToken("KAZI Credits", "KCRED", safe, SUPPLY);
        gate = new KaziCreditsGate(safe, guardian, kazi, credits);
        vm.prank(safe);
        credits.transfer(address(gate), SUPPLY);
        vm.startPrank(market);
        for (uint256 i; i < actors.length; ++i) {
            kazi.transfer(actors[i], HELD);
        }
        vm.stopPrank();

        handler = new CreditsGateHandler(gate, kazi, credits, guardian, safe, actors);
        targetContract(address(handler));
    }

    /// Every KAZI the gate accounted for is in the gate.
    function invariant_lockedKaziHeld() public view {
        assertEq(kazi.balanceOf(address(gate)), gate.totalLocked());
    }

    /// Credits outside the gate are exactly the locked KAZI (1:1, fully backed).
    function invariant_creditsBackedOneToOne() public view {
        assertEq(gate.outstanding(), gate.totalLocked());
        assertEq(credits.balanceOf(address(gate)) + gate.totalLocked(), SUPPLY);
        assertTrue(gate.fullyBacked());
    }

    /// Nobody gains or loses value: each actor's KAZI + Credits is what they started with.
    function invariant_noValueCreatedOrLost() public view {
        uint256 sum;
        for (uint256 i; i < actors.length; ++i) {
            sum += kazi.balanceOf(actors[i]) + credits.balanceOf(actors[i]);
        }
        assertEq(sum, HELD * actors.length);
    }
}

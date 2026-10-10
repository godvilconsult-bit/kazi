// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {KaziToken} from "../src/KaziToken.sol";
import {KaziAirdrop} from "../src/KaziAirdrop.sol";

/// Phase 6: vesting, Merkle airdrop claims and the launch allocation script.
contract KaziAirdropTest is Test {
    KaziToken internal token;
    KaziAirdrop internal airdrop;
    address internal safe = makeAddr("safe");
    address internal treasury = makeAddr("treasury");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");
    uint256 internal constant A = 1_000e18;
    uint256 internal constant B = 2_500e18;
    uint256 internal constant C = 400e18;
    uint64 internal start;
    uint64 internal constant VEST = 180 days;
    bytes32 internal root;
    bytes32[] internal proofA;
    bytes32[] internal proofB;
    bytes32[] internal proofC;

    function _leaf(address account, uint256 amount) internal pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(account, amount))));
    }

    function _pair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }

    function setUp() public {
        token = new KaziToken("Kazi", "KAZI", address(this), 1_000_000_000e18);
        start = uint64(block.timestamp + 1 days);
        // Tree: [[A, B], C] — C is promoted to the second level.
        bytes32 la = _leaf(alice, A);
        bytes32 lb = _leaf(bob, B);
        bytes32 lc = _leaf(carol, C);
        bytes32 ab = _pair(la, lb);
        root = _pair(ab, lc);
        proofA.push(lb);
        proofA.push(lc);
        proofB.push(la);
        proofB.push(lc);
        proofC.push(ab);
        airdrop = new KaziAirdrop(safe, token, root, start, VEST, 2_500, start + VEST + 365 days);
        token.transfer(address(airdrop), A + B + C);
    }

    function test_vestingSchedule_25PercentAtStartThenLinear() public view {
        assertEq(airdrop.vested(A, start - 1), 0);
        assertEq(airdrop.vested(A, start), A / 4);
        assertEq(airdrop.vested(A, start + VEST / 2), A / 4 + (A * 3 / 4) / 2);
        assertEq(airdrop.vested(A, start + VEST), A);
        assertEq(airdrop.vested(A, start + 10 * VEST), A);
    }

    function test_claimsAccumulateAsTokensVest() public {
        vm.warp(start);
        vm.prank(alice);
        airdrop.claim(A, proofA);
        assertEq(token.balanceOf(alice), A / 4);

        vm.prank(alice);
        vm.expectRevert(KaziAirdrop.NothingToClaim.selector);
        airdrop.claim(A, proofA);

        vm.warp(start + VEST / 2);
        assertEq(airdrop.claimable(alice, A), (A * 3 / 4) / 2);
        vm.prank(alice);
        airdrop.claim(A, proofA);
        assertEq(token.balanceOf(alice), A / 4 + (A * 3 / 4) / 2);

        vm.warp(start + VEST);
        vm.prank(alice);
        airdrop.claim(A, proofA);
        assertEq(token.balanceOf(alice), A);
        assertEq(airdrop.claimed(alice), A);

        // A two-level proof for the odd leaf works too.
        vm.prank(carol);
        airdrop.claim(C, proofC);
        assertEq(token.balanceOf(carol), C);
        assertEq(airdrop.totalClaimed(), A + C);
    }

    function test_rejectsWrongAmountsProofsAndCallers() public {
        vm.warp(start);
        vm.prank(alice);
        vm.expectRevert(KaziAirdrop.InvalidProof.selector);
        airdrop.claim(A + 1, proofA); // inflated amount

        vm.prank(bob);
        vm.expectRevert(KaziAirdrop.InvalidProof.selector);
        airdrop.claim(A, proofA); // someone else's leaf: the leaf is bound to msg.sender

        vm.prank(bob);
        vm.expectRevert(KaziAirdrop.InvalidProof.selector);
        airdrop.claim(B, proofA); // wrong proof
    }

    function test_timeWindow_andSweep() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(KaziAirdrop.ClaimingNotStarted.selector, start));
        airdrop.claim(A, proofA);

        vm.warp(start + VEST);
        vm.prank(bob);
        airdrop.claim(B, proofB);

        uint64 deadline = airdrop.claimDeadline(); // read before vm.prank: an external call would use it up
        vm.prank(safe);
        vm.expectRevert(abi.encodeWithSelector(KaziAirdrop.DeadlineNotReached.selector, deadline));
        airdrop.sweep(treasury);

        vm.warp(deadline + 1);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(KaziAirdrop.ClaimingClosed.selector, deadline));
        airdrop.claim(A, proofA);
        assertEq(airdrop.claimable(alice, A), 0);

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, alice, bytes32(0)
            )
        );
        airdrop.sweep(alice);

        vm.prank(safe);
        airdrop.sweep(treasury);
        assertEq(token.balanceOf(treasury), A + C); // what alice and carol never claimed
        assertEq(token.balanceOf(address(airdrop)), 0);
    }

    function test_rejectsZeroAddressesAndEmptySweeps() public {
        uint64 deadline = start + VEST + 1;
        vm.expectRevert(KaziAirdrop.ZeroAddress.selector);
        new KaziAirdrop(address(0), token, root, start, VEST, 2_500, deadline);
        vm.expectRevert(KaziAirdrop.ZeroAddress.selector);
        new KaziAirdrop(safe, KaziToken(address(0)), root, start, VEST, 2_500, deadline);

        vm.warp(airdrop.claimDeadline() + 1);
        vm.prank(safe);
        vm.expectRevert(KaziAirdrop.ZeroAddress.selector);
        airdrop.sweep(address(0));

        KaziAirdrop empty = new KaziAirdrop(safe, token, root, start, VEST, 2_500, deadline);
        vm.prank(safe);
        vm.expectRevert(KaziAirdrop.NothingToClaim.selector);
        empty.sweep(treasury);
    }

    function test_constructorRejectsBadSchedules() public {
        vm.expectRevert(KaziAirdrop.InvalidSchedule.selector);
        new KaziAirdrop(safe, token, root, start, VEST, 10_001, start + VEST + 1);
        vm.expectRevert(KaziAirdrop.InvalidSchedule.selector);
        new KaziAirdrop(safe, token, root, start, VEST, 2_500, start + VEST); // deadline before vesting ends
        vm.expectRevert(KaziAirdrop.ZeroAddress.selector);
        new KaziAirdrop(address(0), token, root, start, VEST, 2_500, start + VEST + 1);
    }

    /// Vesting never decreases, never exceeds the allocation, and claims sum to the allocation.
    function testFuzz_claimsNeverExceedAllocation(uint64 t1, uint64 t2) public {
        t1 = uint64(bound(t1, start, start + VEST + 100 days));
        t2 = uint64(bound(t2, t1, start + VEST + 200 days));
        assertLe(airdrop.vested(B, t1), airdrop.vested(B, t2));
        assertLe(airdrop.vested(B, t2), B);
        vm.warp(t1);
        vm.prank(bob);
        airdrop.claim(B, proofB);
        vm.warp(t2);
        if (airdrop.vested(B, t2) > airdrop.claimed(bob)) {
            vm.prank(bob);
            airdrop.claim(B, proofB);
        }
        assertEq(token.balanceOf(bob), airdrop.vested(B, t2));
        assertLe(token.balanceOf(bob), B);
    }
}

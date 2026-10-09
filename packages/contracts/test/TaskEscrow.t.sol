// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {KaziBase} from "./Base.t.sol";
import {TaskEscrow} from "../src/TaskEscrow.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";
import {IAgentRegistry, ProviderKind, ProviderStatus} from "../src/interfaces/IKazi.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

contract TaskEscrowTest is KaziBase {
    /// @dev Mirror of the EIP-712 Quote type (client included), for the independent digest check.
    struct TypedQuote {
        bytes32 taskId;
        address client;
        uint256[] providerIds;
        uint128[] amounts;
        uint64 deadline;
        uint16 feeBps;
        uint64 expiry;
    }

    bytes32 internal constant TASK = keccak256("task-1");
    uint256 internal agentA;
    uint256 internal agentB;

    function setUp() public virtual override {
        super.setUp();
        agentA = _activeProvider(dev, ProviderKind.AGENT);
        agentB = _activeProvider(makeAddr("dev2"), ProviderKind.AGENT);
    }

    function _fundPair() internal returns (TaskEscrow.Quote memory q) {
        (uint256[] memory ids, uint128[] memory amounts) =
            _pair(agentA, uint128(_usd(100)), agentB, uint128(_usd(50)));
        q = _quote(TASK, ids, amounts);
        _fund(client, q);
    }

    // ─── Constructor ─────────────────────────────────────────────────────────

    function test_constructor_revertsOnZeroAddresses() public {
        IAgentRegistry reg = IAgentRegistry(address(registry));
        vm.expectRevert(TaskEscrow.ZeroAddress.selector);
        new TaskEscrow(address(0), usdc, reg, address(distributor), FEE_BPS, GRACE);
        vm.expectRevert(TaskEscrow.ZeroAddress.selector);
        new TaskEscrow(admin, IERC20(address(0)), reg, address(distributor), FEE_BPS, GRACE);
        vm.expectRevert(TaskEscrow.ZeroAddress.selector);
        new TaskEscrow(
            admin, usdc, IAgentRegistry(address(0)), address(distributor), FEE_BPS, GRACE
        );
        vm.expectRevert(TaskEscrow.ZeroAddress.selector);
        new TaskEscrow(admin, usdc, reg, address(0), FEE_BPS, GRACE);
    }

    function test_constructor_revertsOnFeeAboveCap() public {
        vm.expectRevert(abi.encodeWithSelector(TaskEscrow.InvalidFeeBps.selector, uint16(2_001)));
        new TaskEscrow(
            admin, usdc, IAgentRegistry(address(registry)), address(distributor), 2_001, GRACE
        );
    }

    // ─── Quote signature ─────────────────────────────────────────────────────

    /// @dev Independent EIP-712 encoding via forge's cheatcode, so a bug in quoteDigest's array
    ///      encoding can't hide behind a test that reuses it. This is what viem/ethers will sign.
    function test_quoteDigest_matchesEip712Standard() public view {
        (uint256[] memory ids, uint128[] memory amounts) =
            _pair(agentA, 1_000_000, agentB, 2_500_000);
        TaskEscrow.Quote memory q = _quote(TASK, ids, amounts);
        string memory types =
            "Quote(bytes32 taskId,address client,uint256[] providerIds,uint128[] amounts,uint64 deadline,uint16 feeBps,uint64 expiry)";
        bytes32 structHash = vm.eip712HashStruct(
            types,
            abi.encode(
                TypedQuote(
                    q.taskId, client, q.providerIds, q.amounts, q.deadline, q.feeBps, q.expiry
                )
            )
        );
        bytes32 domain = keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256("KaziEscrow"),
                keccak256("1"),
                block.chainid,
                address(escrow)
            )
        );
        assertEq(escrow.DOMAIN_SEPARATOR(), domain);
        assertEq(
            escrow.quoteDigest(q, client),
            keccak256(abi.encodePacked("\x19\x01", domain, structHash))
        );
    }

    // ─── createAndFund ───────────────────────────────────────────────────────

    function test_createAndFund_storesTaskAndPullsUsdc() public {
        (uint256[] memory ids, uint128[] memory amounts) =
            _pair(agentA, uint128(_usd(100)), agentB, uint128(_usd(50)));
        TaskEscrow.Quote memory q = _quote(TASK, ids, amounts);
        usdc.mint(client, _usd(150));
        bytes memory sig = _sign(q, client, quoterPk);

        vm.startPrank(client);
        usdc.approve(address(escrow), _usd(150));
        vm.expectEmit(address(escrow));
        emit TaskEscrow.TaskFunded(TASK, client, _usd(150), FEE_BPS, q.deadline, ids, amounts);
        escrow.createAndFund(q, sig);
        vm.stopPrank();

        TaskEscrow.Task memory t = escrow.getTask(TASK);
        assertEq(t.client, client);
        assertEq(t.totalAmount, _usd(150));
        assertEq(t.feeBps, FEE_BPS);
        assertEq(uint8(t.status), uint8(TaskEscrow.TaskStatus.FUNDED));
        assertEq(usdc.balanceOf(address(escrow)), _usd(150));
        TaskEscrow.Milestone[] memory ms = escrow.getMilestones(TASK);
        assertEq(ms.length, 2);
        assertEq(ms[1].providerId, agentB);
        assertEq(
            uint8(escrow.getMilestone(TASK, 0).status), uint8(TaskEscrow.MilestoneStatus.FUNDED)
        );
    }

    function test_createAndFund_revertsWhenTaskExists() public {
        TaskEscrow.Quote memory q = _fundPair();
        bytes memory sig = _sign(q, client, quoterPk);
        vm.prank(client);
        vm.expectRevert(abi.encodeWithSelector(TaskEscrow.TaskExists.selector, TASK));
        escrow.createAndFund(q, sig);
    }

    function test_createAndFund_revertsOnMilestoneCount() public {
        TaskEscrow.Quote memory q = _quote(TASK, new uint256[](0), new uint128[](0));
        vm.prank(client);
        vm.expectRevert(abi.encodeWithSelector(TaskEscrow.InvalidMilestoneCount.selector, 0));
        escrow.createAndFund(q, "");

        q = _quote(TASK, new uint256[](21), new uint128[](21));
        vm.prank(client);
        vm.expectRevert(abi.encodeWithSelector(TaskEscrow.InvalidMilestoneCount.selector, 21));
        escrow.createAndFund(q, "");
    }

    function test_createAndFund_revertsOnLengthMismatch() public {
        TaskEscrow.Quote memory q = _quote(TASK, new uint256[](1), new uint128[](2));
        vm.prank(client);
        vm.expectRevert(TaskEscrow.LengthMismatch.selector);
        escrow.createAndFund(q, "");
    }

    function test_createAndFund_revertsOnPastDeadline() public {
        (uint256[] memory ids, uint128[] memory amounts) = _single(agentA, 1e6);
        TaskEscrow.Quote memory q = _quote(TASK, ids, amounts);
        q.deadline = uint64(block.timestamp);
        vm.prank(client);
        vm.expectRevert(abi.encodeWithSelector(TaskEscrow.InvalidDeadline.selector, q.deadline));
        escrow.createAndFund(q, "");
    }

    function test_createAndFund_revertsOnExpiredQuote() public {
        (uint256[] memory ids, uint128[] memory amounts) = _single(agentA, 1e6);
        TaskEscrow.Quote memory q = _quote(TASK, ids, amounts);
        vm.warp(q.expiry + 1);
        vm.prank(client);
        vm.expectRevert(abi.encodeWithSelector(TaskEscrow.QuoteExpired.selector, q.expiry));
        escrow.createAndFund(q, "");
    }

    function test_createAndFund_revertsWhenQuoteFeeAbovePublishedFee() public {
        (uint256[] memory ids, uint128[] memory amounts) = _single(agentA, 1e6);
        TaskEscrow.Quote memory q = _quote(TASK, ids, amounts);
        q.feeBps = FEE_BPS + 1;
        vm.prank(client);
        vm.expectRevert(
            abi.encodeWithSelector(TaskEscrow.QuoteFeeTooHigh.selector, FEE_BPS + 1, FEE_BPS)
        );
        escrow.createAndFund(q, "");
    }

    function test_createAndFund_acceptsDiscountedFee() public {
        (uint256[] memory ids, uint128[] memory amounts) = _single(agentA, uint128(_usd(10)));
        TaskEscrow.Quote memory q = _quote(TASK, ids, amounts);
        q.feeBps = 1_000;
        _fund(client, q);
        assertEq(escrow.getTask(TASK).feeBps, 1_000);
    }

    function test_createAndFund_revertsOnWrongSigner() public {
        (uint256[] memory ids, uint128[] memory amounts) = _single(agentA, 1e6);
        TaskEscrow.Quote memory q = _quote(TASK, ids, amounts);
        bytes memory sig = _sign(q, client, 0xBAD);
        vm.prank(client);
        vm.expectRevert(
            abi.encodeWithSelector(TaskEscrow.InvalidQuoteSigner.selector, vm.addr(0xBAD))
        );
        escrow.createAndFund(q, sig);
    }

    /// @dev A quote signed for one client cannot be funded (front-run) by anyone else.
    function test_createAndFund_quoteIsBoundToClient() public {
        (uint256[] memory ids, uint128[] memory amounts) = _single(agentA, 1e6);
        TaskEscrow.Quote memory q = _quote(TASK, ids, amounts);
        bytes memory sig = _sign(q, client, quoterPk);
        address attacker = makeAddr("attacker");
        vm.prank(attacker);
        vm.expectPartialRevert(TaskEscrow.InvalidQuoteSigner.selector);
        escrow.createAndFund(q, sig);
    }

    function test_createAndFund_revertsOnZeroMilestoneAmount() public {
        (uint256[] memory ids, uint128[] memory amounts) = _pair(agentA, 1e6, agentB, 0);
        TaskEscrow.Quote memory q = _quote(TASK, ids, amounts);
        bytes memory sig = _sign(q, client, quoterPk);
        vm.prank(client);
        vm.expectRevert(TaskEscrow.ZeroAmount.selector);
        escrow.createAndFund(q, sig);
    }

    function test_createAndFund_revertsWhenPaused() public {
        vm.prank(admin);
        escrow.pause();
        (uint256[] memory ids, uint128[] memory amounts) = _single(agentA, 1e6);
        TaskEscrow.Quote memory q = _quote(TASK, ids, amounts);
        vm.prank(client);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        escrow.createAndFund(q, "");
    }

    // ─── createAndFundWithPermit ─────────────────────────────────────────────

    function _permitSig(uint256 ownerPk, uint256 value, uint256 deadline)
        internal
        view
        returns (uint8 v, bytes32 r, bytes32 s)
    {
        address owner = vm.addr(ownerPk);
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256(
                    "Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"
                ),
                owner,
                address(escrow),
                value,
                usdc.nonces(owner),
                deadline
            )
        );
        (v, r, s) = vm.sign(
            ownerPk, keccak256(abi.encodePacked("\x19\x01", usdc.DOMAIN_SEPARATOR(), structHash))
        );
    }

    function test_createAndFundWithPermit_fundsInOneTx() public {
        uint256 clientPk = 0xC11E;
        address permitClient = vm.addr(clientPk);
        (uint256[] memory ids, uint128[] memory amounts) = _single(agentA, uint128(_usd(20)));
        TaskEscrow.Quote memory q = _quote(TASK, ids, amounts);
        usdc.mint(permitClient, _usd(20));
        bytes memory sig = _sign(q, permitClient, quoterPk);
        (uint8 v, bytes32 r, bytes32 s) = _permitSig(clientPk, _usd(20), block.timestamp + 1 hours);

        vm.prank(permitClient);
        escrow.createAndFundWithPermit(q, sig, block.timestamp + 1 hours, v, r, s);
        assertEq(usdc.balanceOf(address(escrow)), _usd(20));
        assertEq(usdc.allowance(permitClient, address(escrow)), 0);
    }

    /// @dev Someone front-runs the permit; funding still succeeds because the allowance exists.
    function test_createAndFundWithPermit_survivesFrontRunPermit() public {
        uint256 clientPk = 0xC11E;
        address permitClient = vm.addr(clientPk);
        (uint256[] memory ids, uint128[] memory amounts) = _single(agentA, uint128(_usd(20)));
        TaskEscrow.Quote memory q = _quote(TASK, ids, amounts);
        usdc.mint(permitClient, _usd(20));
        bytes memory sig = _sign(q, permitClient, quoterPk);
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _permitSig(clientPk, _usd(20), deadline);

        usdc.permit(permitClient, address(escrow), _usd(20), deadline, v, r, s); // front-run
        vm.prank(permitClient);
        escrow.createAndFundWithPermit(q, sig, deadline, v, r, s);
        assertEq(usdc.balanceOf(address(escrow)), _usd(20));
    }

    function test_createAndFundWithPermit_revertsWithoutAllowance() public {
        (uint256[] memory ids, uint128[] memory amounts) = _single(agentA, uint128(_usd(20)));
        TaskEscrow.Quote memory q = _quote(TASK, ids, amounts);
        usdc.mint(client, _usd(20));
        bytes memory sig = _sign(q, client, quoterPk);
        vm.prank(client);
        vm.expectRevert();
        escrow.createAndFundWithPermit(
            q, sig, block.timestamp + 1 hours, 27, bytes32(0), bytes32(0)
        );
    }

    // ─── reassign ────────────────────────────────────────────────────────────

    function test_reassign_movesMilestoneToNewProvider() public {
        _fundPair();
        uint256 agentC = _activeProvider(makeAddr("dev3"), ProviderKind.HUMAN);
        vm.expectEmit(address(escrow));
        emit TaskEscrow.MilestoneReassigned(TASK, 0, agentA, agentC);
        vm.prank(operator);
        escrow.reassign(TASK, 0, agentC);
        assertEq(escrow.getMilestone(TASK, 0).providerId, agentC);
    }

    function test_reassign_reverts() public {
        _fundPair();
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector,
                client,
                escrow.OPERATOR_ROLE()
            )
        );
        vm.prank(client);
        escrow.reassign(TASK, 0, agentB);

        vm.startPrank(operator);
        vm.expectRevert(abi.encodeWithSelector(TaskEscrow.UnknownTask.selector, bytes32("nope")));
        escrow.reassign(bytes32("nope"), 0, agentB);
        vm.expectRevert(abi.encodeWithSelector(TaskEscrow.InvalidIndex.selector, TASK, 5));
        escrow.reassign(TASK, 5, agentB);
        vm.expectRevert(abi.encodeWithSelector(TaskEscrow.ProviderUnassigned.selector, TASK, 0));
        escrow.reassign(TASK, 0, 0);
        vm.expectRevert(
            abi.encodeWithSelector(TaskEscrow.ProviderNotPayable.selector, 999, ProviderStatus.NONE)
        );
        escrow.reassign(TASK, 0, 999);
        escrow.releaseMilestone(TASK, 0);
        vm.expectRevert(abi.encodeWithSelector(TaskEscrow.MilestoneNotFunded.selector, TASK, 0));
        escrow.reassign(TASK, 0, agentB);
        vm.stopPrank();

        vm.prank(client);
        escrow.openDispute(TASK);
        vm.prank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(
                TaskEscrow.InvalidTaskStatus.selector, TASK, TaskEscrow.TaskStatus.DISPUTED
            )
        );
        escrow.reassign(TASK, 1, agentA);
    }

    // ─── releaseMilestone ────────────────────────────────────────────────────

    function test_release_paysProviderAndFee() public {
        _fundPair();
        uint256 amount = _usd(100);
        uint256 providerAmount = (amount * (10_000 - FEE_BPS)) / 10_000;
        vm.expectEmit(address(escrow));
        emit TaskEscrow.MilestoneReleased(TASK, 0, agentA, providerAmount, amount - providerAmount);
        vm.prank(operator);
        escrow.releaseMilestone(TASK, 0);
        assertEq(usdc.balanceOf(payout), providerAmount);
        assertEq(usdc.balanceOf(address(distributor)), amount - providerAmount);
        assertEq(escrow.getTask(TASK).releasedOrRefunded, amount);
        assertEq(
            uint8(escrow.getMilestone(TASK, 0).status), uint8(TaskEscrow.MilestoneStatus.RELEASED)
        );
    }

    function test_release_byClientAndClosesTask() public {
        _fundPair();
        vm.startPrank(client);
        escrow.releaseMilestone(TASK, 0);
        vm.expectEmit(address(escrow));
        emit TaskEscrow.TaskClosed(TASK);
        escrow.releaseMilestone(TASK, 1);
        vm.stopPrank();
        assertEq(uint8(escrow.getTask(TASK).status), uint8(TaskEscrow.TaskStatus.CLOSED));
        assertEq(usdc.balanceOf(address(escrow)), 0);

        vm.prank(client);
        vm.expectRevert(
            abi.encodeWithSelector(
                TaskEscrow.InvalidTaskStatus.selector, TASK, TaskEscrow.TaskStatus.CLOSED
            )
        );
        escrow.releaseMilestone(TASK, 0);
    }

    function test_release_zeroFeeQuoteSendsNothingToDistributor() public {
        (uint256[] memory ids, uint128[] memory amounts) = _single(agentA, uint128(_usd(10)));
        TaskEscrow.Quote memory q = _quote(TASK, ids, amounts);
        q.feeBps = 0;
        _fund(client, q);
        vm.prank(operator);
        escrow.releaseMilestone(TASK, 0);
        assertEq(usdc.balanceOf(payout), _usd(10));
        assertEq(usdc.balanceOf(address(distributor)), 0);
    }

    function test_release_reverts() public {
        _fundPair();
        vm.prank(makeAddr("stranger"));
        vm.expectRevert(TaskEscrow.Unauthorized.selector);
        escrow.releaseMilestone(TASK, 0);

        vm.prank(client);
        escrow.openDispute(TASK);
        vm.prank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(
                TaskEscrow.InvalidTaskStatus.selector, TASK, TaskEscrow.TaskStatus.DISPUTED
            )
        );
        escrow.releaseMilestone(TASK, 0);

        // Client may still release their own disputed task.
        vm.prank(client);
        escrow.releaseMilestone(TASK, 0);

        vm.prank(admin);
        escrow.pause();
        vm.prank(client);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        escrow.releaseMilestone(TASK, 1);
    }

    function test_release_revertsWhenUnassigned() public {
        (uint256[] memory ids, uint128[] memory amounts) = _single(0, uint128(_usd(5)));
        _fund(client, _quote(TASK, ids, amounts));
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(TaskEscrow.ProviderUnassigned.selector, TASK, 0));
        escrow.releaseMilestone(TASK, 0);
    }

    function test_release_suspendedProviderStillPaid_delistedNot() public {
        _fundPair();
        vm.prank(registrar);
        registry.suspend(agentA);
        vm.prank(operator);
        escrow.releaseMilestone(TASK, 0);

        vm.prank(registrar);
        registry.delist(agentB);
        vm.prank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(
                TaskEscrow.ProviderNotPayable.selector, agentB, ProviderStatus.DELISTED
            )
        );
        escrow.releaseMilestone(TASK, 1);
    }

    /// @dev Blocklisted payout: release reverts, the operator refunds the client instead.
    function test_release_blocklistedPayout_refundPathWorks() public {
        _fundPair();
        usdc.setBlocklisted(payout, true);
        vm.prank(operator);
        vm.expectPartialRevert(MockUSDC.Blocklisted.selector);
        escrow.releaseMilestone(TASK, 0);

        uint256 before = usdc.balanceOf(client);
        vm.prank(operator);
        escrow.refundMilestone(TASK, 0);
        assertEq(usdc.balanceOf(client) - before, _usd(100));
    }

    // ─── refundMilestone ─────────────────────────────────────────────────────

    function test_refund_returnsToClientEvenWhenPaused() public {
        _fundPair();
        vm.prank(admin);
        escrow.pause();
        vm.expectEmit(address(escrow));
        emit TaskEscrow.MilestoneRefunded(TASK, 1, _usd(50));
        vm.prank(operator);
        escrow.refundMilestone(TASK, 1);
        assertEq(usdc.balanceOf(client), _usd(50));
    }

    function test_refund_reverts() public {
        _fundPair();
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector,
                client,
                escrow.OPERATOR_ROLE()
            )
        );
        vm.prank(client);
        escrow.refundMilestone(TASK, 0);

        vm.startPrank(operator);
        escrow.refundMilestone(TASK, 0);
        vm.expectRevert(abi.encodeWithSelector(TaskEscrow.MilestoneNotFunded.selector, TASK, 0));
        escrow.refundMilestone(TASK, 0);
        escrow.refundMilestone(TASK, 1);
        vm.expectRevert(
            abi.encodeWithSelector(
                TaskEscrow.InvalidTaskStatus.selector, TASK, TaskEscrow.TaskStatus.CLOSED
            )
        );
        escrow.refundMilestone(TASK, 1);
        vm.stopPrank();
    }

    // ─── Disputes ────────────────────────────────────────────────────────────

    function test_openDispute_reverts() public {
        _fundPair();
        vm.prank(operator);
        vm.expectRevert(TaskEscrow.Unauthorized.selector);
        escrow.openDispute(TASK);

        vm.startPrank(client);
        vm.expectEmit(address(escrow));
        emit TaskEscrow.DisputeOpened(TASK, client);
        escrow.openDispute(TASK);
        vm.expectRevert(
            abi.encodeWithSelector(
                TaskEscrow.InvalidTaskStatus.selector, TASK, TaskEscrow.TaskStatus.DISPUTED
            )
        );
        escrow.openDispute(TASK);
        vm.stopPrank();
    }

    function test_resolveDispute_splitsWithFeeOnProviderPartOnly() public {
        _fundPair();
        vm.prank(client);
        escrow.openDispute(TASK);

        uint256 amount = _usd(100);
        uint256 clientAmount = (amount * 4_000) / 10_000;
        uint256 providerGross = amount - clientAmount;
        uint256 providerAmount = (providerGross * (10_000 - FEE_BPS)) / 10_000;
        vm.expectEmit(address(escrow));
        emit TaskEscrow.DisputeResolved(
            TASK, 0, 4_000, clientAmount, providerAmount, providerGross - providerAmount
        );
        vm.prank(arbiter);
        escrow.resolveDispute(TASK, 0, 4_000);

        assertEq(usdc.balanceOf(client), clientAmount);
        assertEq(usdc.balanceOf(payout), providerAmount);
        assertEq(usdc.balanceOf(address(distributor)), providerGross - providerAmount);
        assertEq(
            uint8(escrow.getMilestone(TASK, 0).status), uint8(TaskEscrow.MilestoneStatus.RELEASED)
        );
    }

    function test_resolveDispute_fullRefundMarksRefunded_andClosesWhenDone() public {
        _fundPair();
        vm.prank(client);
        escrow.openDispute(TASK);
        vm.startPrank(arbiter);
        escrow.resolveDispute(TASK, 0, 10_000);
        assertEq(
            uint8(escrow.getMilestone(TASK, 0).status), uint8(TaskEscrow.MilestoneStatus.REFUNDED)
        );
        escrow.resolveDispute(TASK, 1, 0); // full release to provider
        vm.stopPrank();
        assertEq(usdc.balanceOf(client), _usd(100));
        assertEq(uint8(escrow.getTask(TASK).status), uint8(TaskEscrow.TaskStatus.CLOSED));
    }

    function test_resolveDispute_unassignedMilestone() public {
        (uint256[] memory ids, uint128[] memory amounts) =
            _pair(0, uint128(_usd(5)), 0, uint128(_usd(5)));
        _fund(client, _quote(TASK, ids, amounts));
        vm.prank(client);
        escrow.openDispute(TASK);
        vm.startPrank(arbiter);
        vm.expectRevert(abi.encodeWithSelector(TaskEscrow.ProviderUnassigned.selector, TASK, 0));
        escrow.resolveDispute(TASK, 0, 5_000);
        escrow.resolveDispute(TASK, 0, 10_000); // fine: nothing goes to the provider
        vm.stopPrank();
    }

    function test_resolveDispute_reverts() public {
        _fundPair();
        vm.startPrank(arbiter);
        vm.expectRevert(abi.encodeWithSelector(TaskEscrow.InvalidShareBps.selector, uint16(10_001)));
        escrow.resolveDispute(TASK, 0, 10_001);
        vm.expectRevert(
            abi.encodeWithSelector(
                TaskEscrow.InvalidTaskStatus.selector, TASK, TaskEscrow.TaskStatus.FUNDED
            )
        );
        escrow.resolveDispute(TASK, 0, 5_000);
        vm.stopPrank();

        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector,
                operator,
                escrow.ARBITER_ROLE()
            )
        );
        vm.prank(operator);
        escrow.resolveDispute(TASK, 0, 5_000);
    }

    // ─── refundExpired ───────────────────────────────────────────────────────

    function test_refundExpired_refundsUnreleasedAfterGrace_evenWhenPaused() public {
        TaskEscrow.Quote memory q = _fundPair();
        vm.prank(operator);
        escrow.releaseMilestone(TASK, 0);

        uint256 refundableAt = uint256(q.deadline) + GRACE;
        vm.warp(refundableAt - 1);
        vm.expectRevert(abi.encodeWithSelector(TaskEscrow.NotExpired.selector, refundableAt));
        escrow.refundExpired(TASK);

        vm.warp(refundableAt);
        vm.prank(admin);
        escrow.pause();
        vm.prank(makeAddr("anyone"));
        escrow.refundExpired(TASK);
        assertEq(usdc.balanceOf(client), _usd(50));
        assertEq(uint8(escrow.getTask(TASK).status), uint8(TaskEscrow.TaskStatus.CLOSED));
        assertEq(usdc.balanceOf(address(escrow)), 0);
    }

    function test_refundExpired_notWhileDisputed() public {
        TaskEscrow.Quote memory q = _fundPair();
        vm.prank(client);
        escrow.openDispute(TASK);
        vm.warp(uint256(q.deadline) + GRACE);
        vm.expectRevert(
            abi.encodeWithSelector(
                TaskEscrow.InvalidTaskStatus.selector, TASK, TaskEscrow.TaskStatus.DISPUTED
            )
        );
        escrow.refundExpired(TASK);
    }

    // ─── Admin & views ───────────────────────────────────────────────────────

    function test_admin_setFeeBps_andDistributor() public {
        vm.startPrank(admin);
        vm.expectEmit(address(escrow));
        emit TaskEscrow.FeeUpdated(FEE_BPS, 500);
        escrow.setFeeBps(500);
        assertEq(escrow.feeBps(), 500);
        vm.expectRevert(abi.encodeWithSelector(TaskEscrow.InvalidFeeBps.selector, uint16(2_001)));
        escrow.setFeeBps(2_001);

        address newDistributor = makeAddr("newDistributor");
        escrow.setFeeDistributor(newDistributor);
        assertEq(escrow.feeDistributor(), newDistributor);
        vm.expectRevert(TaskEscrow.ZeroAddress.selector);
        escrow.setFeeDistributor(address(0));

        escrow.pause();
        assertTrue(escrow.paused());
        escrow.unpause();
        assertFalse(escrow.paused());
        vm.stopPrank();

        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, operator, bytes32(0)
            )
        );
        vm.prank(operator);
        escrow.setFeeBps(100);
    }

    function test_views_unknownTaskAndIndex() public {
        vm.expectRevert(abi.encodeWithSelector(TaskEscrow.InvalidIndex.selector, TASK, 0));
        escrow.getMilestone(TASK, 0);
        vm.expectRevert(abi.encodeWithSelector(TaskEscrow.UnknownTask.selector, TASK));
        escrow.openDispute(TASK);
        assertEq(escrow.getMilestones(TASK).length, 0);
    }

    // ─── Fuzz ────────────────────────────────────────────────────────────────

    /// @dev Fund 1–20 milestones with random amounts and fee, release all:
    ///      provider + fee == amount for each, fee <= amount * MAX_FEE, escrow ends empty.
    function testFuzz_fundAndReleaseAll(uint256 seed, uint8 countSeed, uint16 feeSeed) public {
        uint256 count = bound(countSeed, 1, 20);
        uint16 fee = uint16(bound(feeSeed, 0, FEE_BPS));
        uint256[] memory ids = new uint256[](count);
        uint128[] memory amounts = new uint128[](count);
        uint256 total;
        for (uint256 i = 0; i < count; ++i) {
            ids[i] = i % 2 == 0 ? agentA : agentB;
            amounts[i] = uint128(bound(uint256(keccak256(abi.encode(seed, i))), 1, 1e30));
            total += amounts[i];
        }
        TaskEscrow.Quote memory q = _quote(TASK, ids, amounts);
        q.feeBps = fee;
        _fund(client, q);

        uint256 feesBefore;
        for (uint256 i = 0; i < count; ++i) {
            uint256 payoutBefore = usdc.balanceOf(payout);
            feesBefore = usdc.balanceOf(address(distributor));
            vm.prank(operator);
            escrow.releaseMilestone(TASK, i);
            uint256 paid = usdc.balanceOf(payout) - payoutBefore;
            uint256 feePaid = usdc.balanceOf(address(distributor)) - feesBefore;
            assertEq(paid + feePaid, amounts[i]);
            assertLe(feePaid, (uint256(amounts[i]) * escrow.MAX_FEE_BPS()) / 10_000 + 1);
        }
        assertEq(usdc.balanceOf(address(escrow)), 0);
        assertEq(escrow.getTask(TASK).releasedOrRefunded, total);
    }

    function testFuzz_disputeSplitConservesFunds(uint128 amountSeed, uint16 shareSeed) public {
        uint128 amount = uint128(bound(amountSeed, 1, 1e30));
        uint16 share = uint16(bound(shareSeed, 0, 10_000));
        (uint256[] memory ids, uint128[] memory amounts) = _single(agentA, amount);
        _fund(client, _quote(TASK, ids, amounts));
        vm.prank(client);
        escrow.openDispute(TASK);
        vm.prank(arbiter);
        escrow.resolveDispute(TASK, 0, share);
        assertEq(
            usdc.balanceOf(client) + usdc.balanceOf(payout) + usdc.balanceOf(address(distributor)),
            amount
        );
        assertEq(usdc.balanceOf(address(escrow)), 0);
    }
}

/// @dev Re-runs the full escrow suite against an 18-decimal USDC.
contract TaskEscrow18DecimalsTest is TaskEscrowTest {
    function setUp() public override {
        _deploy(18);
        agentA = _activeProvider(dev, ProviderKind.AGENT);
        agentB = _activeProvider(makeAddr("dev2"), ProviderKind.AGENT);
    }
}

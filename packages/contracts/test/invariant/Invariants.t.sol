// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {KaziBase} from "../Base.t.sol";
import {TaskEscrow} from "../../src/TaskEscrow.sol";
import {StakingVault} from "../../src/StakingVault.sol";
import {MockUSDC} from "../../src/mocks/MockUSDC.sol";
import {KaziToken} from "../../src/KaziToken.sol";
import {ProviderKind} from "../../src/interfaces/IKazi.sol";

// ═══════════════════════════════ TaskEscrow ════════════════════════════════

contract EscrowHandler is Test {
    TaskEscrow internal escrow;
    MockUSDC internal usdc;
    address internal distributor;
    address internal operator;
    address internal arbiter;
    uint256 internal quoterPk;
    uint256[2] internal providers;
    address[3] internal clients;

    bytes32[] public taskIds;
    mapping(bytes32 => mapping(uint256 => uint256)) public settleCount;
    bool public ghostDoublePay;
    bool public ghostFeeOverCap;
    bool public ghostRecoveryFailed;
    uint256 internal nonce;

    constructor(
        TaskEscrow escrow_,
        MockUSDC usdc_,
        address distributor_,
        address operator_,
        address arbiter_,
        uint256 quoterPk_,
        uint256[2] memory providers_
    ) {
        escrow = escrow_;
        usdc = usdc_;
        distributor = distributor_;
        operator = operator_;
        arbiter = arbiter_;
        quoterPk = quoterPk_;
        providers = providers_;
        clients = [makeAddr("c0"), makeAddr("c1"), makeAddr("c2")];
    }

    function taskCount() external view returns (uint256) {
        return taskIds.length;
    }

    function fund(uint256 clientSeed, uint256 countSeed, uint256 amountSeed, uint16 feeSeed)
        external
    {
        address client = clients[clientSeed % 3];
        uint256 count = bound(countSeed, 1, 5);
        uint256[] memory ids = new uint256[](count);
        uint128[] memory amounts = new uint128[](count);
        uint256 total;
        for (uint256 i = 0; i < count; ++i) {
            ids[i] = providers[i % 2];
            amounts[i] = uint128(bound(uint256(keccak256(abi.encode(amountSeed, i))), 1, 1e15));
            total += amounts[i];
        }
        bytes32 taskId = keccak256(abi.encode("task", nonce++));
        TaskEscrow.Quote memory q = TaskEscrow.Quote({
            taskId: taskId,
            providerIds: ids,
            amounts: amounts,
            deadline: uint64(block.timestamp + 1 days),
            feeBps: uint16(bound(feeSeed, 0, escrow.feeBps())),
            expiry: uint64(block.timestamp + 30 minutes)
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(quoterPk, escrow.quoteDigest(q, client));
        usdc.mint(client, total);
        vm.startPrank(client);
        usdc.approve(address(escrow), total);
        escrow.createAndFund(q, abi.encodePacked(r, s, v));
        vm.stopPrank();
        taskIds.push(taskId);
    }

    function _pick(uint256 taskSeed, uint256 idxSeed)
        internal
        view
        returns (bytes32 taskId, uint256 index, bool ok)
    {
        if (taskIds.length == 0) return (bytes32(0), 0, false);
        taskId = taskIds[taskSeed % taskIds.length];
        uint256 n = escrow.getMilestones(taskId).length;
        index = idxSeed % n;
        ok = escrow.getMilestone(taskId, index).status == TaskEscrow.MilestoneStatus.FUNDED;
    }

    function _recordSettle(bytes32 taskId, uint256 index) internal {
        if (++settleCount[taskId][index] > 1) ghostDoublePay = true;
    }

    function release(uint256 taskSeed, uint256 idxSeed, bool byClient) external {
        (bytes32 taskId, uint256 index, bool ok) = _pick(taskSeed, idxSeed);
        if (!ok) return;
        TaskEscrow.Task memory t = escrow.getTask(taskId);
        if (t.status == TaskEscrow.TaskStatus.DISPUTED) byClient = true;
        uint256 amount = escrow.getMilestone(taskId, index).amount;
        uint256 feesBefore = usdc.balanceOf(distributor);
        vm.prank(byClient ? t.client : operator);
        escrow.releaseMilestone(taskId, index);
        if (usdc.balanceOf(distributor) - feesBefore > (amount * escrow.MAX_FEE_BPS()) / 10_000 + 1)
        {
            ghostFeeOverCap = true;
        }
        _recordSettle(taskId, index);
    }

    function refund(uint256 taskSeed, uint256 idxSeed) external {
        (bytes32 taskId, uint256 index, bool ok) = _pick(taskSeed, idxSeed);
        if (!ok) return;
        vm.prank(operator);
        escrow.refundMilestone(taskId, index);
        _recordSettle(taskId, index);
    }

    function dispute(uint256 taskSeed) external {
        if (taskIds.length == 0) return;
        bytes32 taskId = taskIds[taskSeed % taskIds.length];
        TaskEscrow.Task memory t = escrow.getTask(taskId);
        if (t.status != TaskEscrow.TaskStatus.FUNDED) return;
        vm.prank(t.client);
        escrow.openDispute(taskId);
    }

    function resolve(uint256 taskSeed, uint256 idxSeed, uint16 shareSeed) external {
        (bytes32 taskId, uint256 index, bool ok) = _pick(taskSeed, idxSeed);
        if (!ok || escrow.getTask(taskId).status != TaskEscrow.TaskStatus.DISPUTED) return;
        vm.prank(arbiter);
        escrow.resolveDispute(taskId, index, uint16(bound(shareSeed, 0, 10_000)));
        _recordSettle(taskId, index);
    }

    /// @dev Client funds must always be recoverable after deadline + grace if not disputed.
    function warpAndRecover(uint256 taskSeed) external {
        if (taskIds.length == 0) return;
        bytes32 taskId = taskIds[taskSeed % taskIds.length];
        TaskEscrow.Task memory t = escrow.getTask(taskId);
        if (t.status != TaskEscrow.TaskStatus.FUNDED) return;
        uint256 refundableAt = uint256(t.deadline) + escrow.gracePeriod();
        if (block.timestamp < refundableAt) vm.warp(refundableAt);

        TaskEscrow.Milestone[] memory ms = escrow.getMilestones(taskId);
        uint256 expected;
        for (uint256 i = 0; i < ms.length; ++i) {
            if (ms[i].status == TaskEscrow.MilestoneStatus.FUNDED) {
                expected += ms[i].amount;
                _recordSettle(taskId, i);
            }
        }
        uint256 before = usdc.balanceOf(t.client);
        try escrow.refundExpired(taskId) {
            if (usdc.balanceOf(t.client) - before != expected) ghostRecoveryFailed = true;
        } catch {
            ghostRecoveryFailed = true;
        }
    }
}

contract EscrowInvariantTest is KaziBase {
    EscrowHandler internal handler;

    function setUp() public override {
        super.setUp();
        uint256 a = _activeProvider(dev, ProviderKind.AGENT);
        uint256 b = _activeProvider(makeAddr("dev2"), ProviderKind.HUMAN);
        handler = new EscrowHandler(
            escrow, usdc, address(distributor), operator, arbiter, quoterPk, [a, b]
        );
        targetContract(address(handler));
    }

    /// @dev USDC.balanceOf(escrow) == Σ over tasks (totalAmount − releasedOrRefunded)
    function invariant_escrowBalanceMatchesOutstanding() public view {
        uint256 outstanding;
        for (uint256 i = 0; i < handler.taskCount(); ++i) {
            TaskEscrow.Task memory t = escrow.getTask(handler.taskIds(i));
            outstanding += t.totalAmount - t.releasedOrRefunded;
        }
        assertEq(usdc.balanceOf(address(escrow)), outstanding);
    }

    function invariant_milestonePaysAtMostOnce() public view {
        assertFalse(handler.ghostDoublePay());
    }

    function invariant_feeNeverAboveCap() public view {
        assertFalse(handler.ghostFeeOverCap());
    }

    function invariant_clientFundsRecoverableAfterDeadline() public view {
        assertFalse(handler.ghostRecoveryFailed());
    }
}

// ═══════════════════════════════ StakingVault ══════════════════════════════

contract VaultHandler is Test {
    StakingVault internal vault;
    KaziToken internal kazi;
    MockUSDC internal usdc;
    address internal funder;
    address[3] public actors;

    constructor(StakingVault vault_, KaziToken kazi_, MockUSDC usdc_, address funder_) {
        vault = vault_;
        kazi = kazi_;
        usdc = usdc_;
        funder = funder_;
        actors = [makeAddr("s0"), makeAddr("s1"), makeAddr("s2")];
    }

    function stake(uint256 actorSeed, uint256 amount) external {
        address actor = actors[actorSeed % 3];
        amount = bound(amount, 1, 1_000_000e18);
        vm.prank(funder);
        kazi.transfer(actor, amount);
        vm.startPrank(actor);
        kazi.approve(address(vault), amount);
        vault.stake(amount);
        vm.stopPrank();
    }

    function requestUnstake(uint256 actorSeed, uint256 amount) external {
        address actor = actors[actorSeed % 3];
        uint256 available = vault.stakeOf(actor);
        if (available == 0) return;
        vm.prank(actor);
        vault.requestUnstake(bound(amount, 1, available));
    }

    function withdraw(uint256 actorSeed) external {
        address actor = actors[actorSeed % 3];
        StakingVault.Account memory a = vault.getAccount(vault.holderKey(actor));
        if (a.unbonding == 0) return;
        if (block.timestamp < a.unbondReadyAt) vm.warp(a.unbondReadyAt);
        vm.prank(actor);
        vault.withdraw();
    }

    function claim(uint256 actorSeed) external {
        address actor = actors[actorSeed % 3];
        bytes32[] memory keys = new bytes32[](1);
        keys[0] = vault.holderKey(actor);
        vault.poke(keys);
        if (vault.earned(keys[0]) == 0) return;
        vm.prank(actor);
        vault.claim();
    }

    function notify(uint256 amount) external {
        amount = bound(amount, 1, 1e12);
        usdc.mint(funder, amount);
        vm.startPrank(funder);
        usdc.approve(address(vault), amount);
        vault.notifyReward(amount);
        vm.stopPrank();
    }

    function warp(uint256 secondsSeed) external {
        vm.warp(block.timestamp + bound(secondsSeed, 1, 3 days));
    }
}

contract VaultInvariantTest is KaziBase {
    VaultHandler internal handler;

    function setUp() public override {
        super.setUp();
        handler = new VaultHandler(vault, kazi, usdc, admin);
        vm.startPrank(admin);
        vault.grantRole(vault.REWARD_NOTIFIER_ROLE(), admin);
        vm.stopPrank();
        targetContract(address(handler));
    }

    /// @dev total tracked stake == token balance (no slashing in this handler)
    function invariant_stakeBalanceMatchesTracked() public view {
        assertEq(kazi.balanceOf(address(vault)), vault.totalTracked());
    }

    function invariant_rewardsClaimedNeverExceedNotified() public view {
        assertLe(vault.totalRewardsClaimed(), vault.totalRewardsNotified());
        assertEq(
            usdc.balanceOf(address(vault)),
            vault.totalRewardsNotified() - vault.totalRewardsClaimed()
        );
    }

    function invariant_totalActiveIsSumOfAccounts() public view {
        uint256 sum;
        for (uint256 i = 0; i < 3; ++i) {
            sum += vault.getAccount(vault.holderKey(handler.actors(i))).active;
        }
        assertEq(vault.totalActive(), sum);
    }

    /// @dev Everything owed (claimed + still claimable) never exceeds what was notified.
    function invariant_owedRewardsCovered() public view {
        uint256 owed = vault.totalRewardsClaimed() + vault.queuedRewards();
        for (uint256 i = 0; i < 3; ++i) {
            owed += vault.earned(vault.holderKey(handler.actors(i)));
        }
        assertLe(owed, vault.totalRewardsNotified());
    }
}

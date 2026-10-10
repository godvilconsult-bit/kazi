// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IAgentRegistry, ProviderStatus} from "./interfaces/IKazi.sol";

/// @title TaskEscrow
/// @notice Holds client USDC for Kazi tasks, one milestone per subtask.
///         - Clients fund quotes signed by a QUOTER key (EIP-712, bound to client, chain and this contract).
///         - The backend OPERATOR (or the client) releases accepted milestones; fee goes to FeeDistributor.
///         - Disputes freeze operator releases; the ARBITER (admin multisig) splits each milestone.
///         - After deadline + grace, anyone can refund all unreleased milestones to the client,
///           even while paused, so clients never depend on Kazi being online.
///         If a provider payout address is blocklisted by USDC, release reverts; the operator refunds
///         that milestone to the client instead (refunds are never blocked by pause).
contract TaskEscrow is AccessControl, Pausable, ReentrancyGuard, EIP712 {
    using SafeERC20 for IERC20;

    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");
    bytes32 public constant QUOTER_ROLE = keccak256("QUOTER_ROLE");
    bytes32 public constant ARBITER_ROLE = keccak256("ARBITER_ROLE");
    /// @notice Guardian that can pause fast in an incident; only the admin (Safe) can unpause.
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    bytes32 public constant QUOTE_TYPEHASH = keccak256(
        "Quote(bytes32 taskId,address client,uint256[] providerIds,uint128[] amounts,uint64 deadline,uint16 feeBps,uint64 expiry)"
    );

    uint16 public constant MAX_FEE_BPS = 2_000;
    uint256 public constant MAX_MILESTONES = 20;
    uint256 private constant BPS = 10_000;

    enum MilestoneStatus {
        NONE,
        FUNDED,
        RELEASED,
        REFUNDED
    }

    enum TaskStatus {
        NONE,
        FUNDED,
        DISPUTED,
        CLOSED
    }

    struct Milestone {
        uint256 providerId; // 0 = unassigned
        uint128 amount; // gross USDC base units (includes fee)
        MilestoneStatus status;
    }

    struct Task {
        address client;
        uint64 deadline;
        uint16 feeBps; // snapshot from the signed quote
        TaskStatus status;
        uint256 totalAmount;
        uint256 releasedOrRefunded;
    }

    struct Quote {
        bytes32 taskId;
        uint256[] providerIds;
        uint128[] amounts;
        uint64 deadline;
        uint16 feeBps;
        uint64 expiry;
    }

    IERC20 public immutable usdc;
    IAgentRegistry public immutable registry;
    uint64 public immutable gracePeriod;

    address public feeDistributor;
    uint16 public feeBps; // published fee; quotes may only carry a fee at or below it

    mapping(bytes32 taskId => Task) private _tasks;
    // Written through storage pointers in _createTask (Slither misreads it as never initialized).
    // slither-disable-next-line uninitialized-state
    mapping(bytes32 taskId => Milestone[]) private _milestones;

    error ZeroAddress();
    error ZeroAmount();
    error InvalidFeeBps(uint16 feeBps);
    error TaskExists(bytes32 taskId);
    error UnknownTask(bytes32 taskId);
    error InvalidMilestoneCount(uint256 count);
    error LengthMismatch();
    error InvalidDeadline(uint64 deadline);
    error QuoteExpired(uint64 expiry);
    error QuoteFeeTooHigh(uint16 quoteFeeBps, uint16 maxFeeBps);
    error InvalidQuoteSigner(address signer);
    error InvalidIndex(bytes32 taskId, uint256 index);
    error MilestoneNotFunded(bytes32 taskId, uint256 index);
    error InvalidTaskStatus(bytes32 taskId, TaskStatus status);
    error Unauthorized();
    error ProviderUnassigned(bytes32 taskId, uint256 index);
    error ProviderNotPayable(uint256 providerId, ProviderStatus status);
    error InvalidShareBps(uint16 bps);
    error NotExpired(uint256 refundableAt);

    event TaskFunded(
        bytes32 indexed taskId,
        address indexed client,
        uint256 totalAmount,
        uint16 feeBps,
        uint64 deadline,
        uint256[] providerIds,
        uint128[] amounts
    );
    event MilestoneReassigned(
        bytes32 indexed taskId, uint256 indexed index, uint256 oldProviderId, uint256 newProviderId
    );
    event MilestoneReleased(
        bytes32 indexed taskId,
        uint256 indexed index,
        uint256 indexed providerId,
        uint256 providerAmount,
        uint256 fee
    );
    event MilestoneRefunded(bytes32 indexed taskId, uint256 indexed index, uint256 amount);
    event DisputeOpened(bytes32 indexed taskId, address indexed client);
    event DisputeResolved(
        bytes32 indexed taskId,
        uint256 indexed index,
        uint16 clientShareBps,
        uint256 clientAmount,
        uint256 providerAmount,
        uint256 fee
    );
    event TaskClosed(bytes32 indexed taskId);
    event FeeUpdated(uint16 oldFeeBps, uint16 newFeeBps);
    event FeeDistributorUpdated(address oldDistributor, address newDistributor);

    constructor(
        address admin,
        IERC20 usdc_,
        IAgentRegistry registry_,
        address feeDistributor_,
        uint16 feeBps_,
        uint64 gracePeriod_
    ) EIP712("KaziEscrow", "1") {
        if (
            admin == address(0) || address(usdc_) == address(0) || address(registry_) == address(0)
                || feeDistributor_ == address(0)
        ) revert ZeroAddress();
        if (feeBps_ > MAX_FEE_BPS) revert InvalidFeeBps(feeBps_);
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        usdc = usdc_;
        registry = registry_;
        feeDistributor = feeDistributor_;
        feeBps = feeBps_;
        gracePeriod = gracePeriod_;
        emit FeeUpdated(0, feeBps_);
        emit FeeDistributorUpdated(address(0), feeDistributor_);
    }

    // ─── Funding ─────────────────────────────────────────────────────────────

    function createAndFund(Quote calldata quote, bytes calldata quoteSig)
        external
        nonReentrant
        whenNotPaused
    {
        uint256 total = _createTask(quote, quoteSig);
        usdc.safeTransferFrom(msg.sender, address(this), total);
    }

    /// @notice Same as createAndFund, but approves via an EIP-2612 permit signed by the client for exactly the total.
    /// @dev The permit call is wrapped in try/catch so a front-run permit cannot block funding;
    ///      transferFrom then succeeds if the allowance exists either way.
    function createAndFundWithPermit(
        Quote calldata quote,
        bytes calldata quoteSig,
        uint256 permitDeadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant whenNotPaused {
        uint256 total = _createTask(quote, quoteSig);
        try IERC20Permit(address(usdc))
            .permit(msg.sender, address(this), total, permitDeadline, v, r, s) {}
            catch {}
        usdc.safeTransferFrom(msg.sender, address(this), total);
    }

    // ─── Operator / client actions ───────────────────────────────────────────

    function reassign(bytes32 taskId, uint256 index, uint256 newProviderId)
        external
        onlyRole(OPERATOR_ROLE)
    {
        Task storage t = _task(taskId);
        if (t.status != TaskStatus.FUNDED) revert InvalidTaskStatus(taskId, t.status);
        Milestone storage m = _fundedMilestone(taskId, index);
        if (newProviderId == 0) revert ProviderUnassigned(taskId, index);
        ProviderStatus status = registry.statusOf(newProviderId);
        if (status != ProviderStatus.ACTIVE) revert ProviderNotPayable(newProviderId, status);
        uint256 old = m.providerId;
        m.providerId = newProviderId;
        emit MilestoneReassigned(taskId, index, old, newProviderId);
    }

    /// @notice Release a milestone to the provider. Operator (after acceptance) or the client may call.
    ///         While a task is disputed only the client can release.
    function releaseMilestone(bytes32 taskId, uint256 index) external nonReentrant whenNotPaused {
        Task storage t = _task(taskId);
        bool isClient = msg.sender == t.client;
        if (!isClient && !hasRole(OPERATOR_ROLE, msg.sender)) revert Unauthorized();
        if (t.status == TaskStatus.CLOSED || (t.status == TaskStatus.DISPUTED && !isClient)) {
            revert InvalidTaskStatus(taskId, t.status);
        }
        Milestone storage m = _fundedMilestone(taskId, index);
        uint256 providerId = m.providerId;
        if (providerId == 0) revert ProviderUnassigned(taskId, index);
        ProviderStatus status = registry.statusOf(providerId);
        if (status != ProviderStatus.ACTIVE && status != ProviderStatus.SUSPENDED) {
            revert ProviderNotPayable(providerId, status);
        }
        address payout = registry.payoutOf(providerId);

        uint256 amount = m.amount;
        (uint256 providerAmount, uint256 fee) = _split(amount, t.feeBps);
        m.status = MilestoneStatus.RELEASED;
        _settle(taskId, t, amount);

        emit MilestoneReleased(taskId, index, providerId, providerAmount, fee);
        usdc.safeTransfer(payout, providerAmount);
        if (fee != 0) usdc.safeTransfer(feeDistributor, fee);
    }

    /// @notice Refund a milestone to the client (failed subtask, blocklisted payout, ...). Never blocked by pause.
    function refundMilestone(bytes32 taskId, uint256 index)
        external
        nonReentrant
        onlyRole(OPERATOR_ROLE)
    {
        Task storage t = _task(taskId);
        if (t.status == TaskStatus.CLOSED) revert InvalidTaskStatus(taskId, t.status);
        Milestone storage m = _fundedMilestone(taskId, index);
        uint256 amount = m.amount;
        m.status = MilestoneStatus.REFUNDED;
        _settle(taskId, t, amount);

        emit MilestoneRefunded(taskId, index, amount);
        usdc.safeTransfer(t.client, amount);
    }

    function openDispute(bytes32 taskId) external {
        Task storage t = _task(taskId);
        if (msg.sender != t.client) revert Unauthorized();
        if (t.status != TaskStatus.FUNDED) revert InvalidTaskStatus(taskId, t.status);
        t.status = TaskStatus.DISPUTED;
        emit DisputeOpened(taskId, msg.sender);
    }

    /// @notice Arbiter splits a disputed milestone: `clientShareBps` back to the client, the rest to the
    ///         provider minus the fee (fee applies only to the provider part).
    function resolveDispute(bytes32 taskId, uint256 index, uint16 clientShareBps)
        external
        nonReentrant
        onlyRole(ARBITER_ROLE)
    {
        if (clientShareBps > BPS) revert InvalidShareBps(clientShareBps);
        Task storage t = _task(taskId);
        if (t.status != TaskStatus.DISPUTED) revert InvalidTaskStatus(taskId, t.status);
        Milestone storage m = _fundedMilestone(taskId, index);

        uint256 amount = m.amount;
        uint256 clientAmount = (amount * clientShareBps) / BPS;
        uint256 providerGross = amount - clientAmount;
        address payout;
        if (providerGross != 0) {
            if (m.providerId == 0) revert ProviderUnassigned(taskId, index);
            payout = registry.payoutOf(m.providerId);
        }
        (uint256 providerAmount, uint256 fee) = _split(providerGross, t.feeBps);

        m.status = clientShareBps == BPS ? MilestoneStatus.REFUNDED : MilestoneStatus.RELEASED;
        _settle(taskId, t, amount);

        emit DisputeResolved(taskId, index, clientShareBps, clientAmount, providerAmount, fee);
        if (clientAmount != 0) usdc.safeTransfer(t.client, clientAmount);
        if (providerAmount != 0) usdc.safeTransfer(payout, providerAmount);
        if (fee != 0) usdc.safeTransfer(feeDistributor, fee);
    }

    /// @notice After deadline + grace period, anyone can refund every unreleased milestone to the client.
    ///         Works while paused. Not available while disputed.
    function refundExpired(bytes32 taskId) external nonReentrant {
        Task storage t = _task(taskId);
        if (t.status != TaskStatus.FUNDED) revert InvalidTaskStatus(taskId, t.status);
        uint256 refundableAt = uint256(t.deadline) + gracePeriod;
        if (block.timestamp < refundableAt) revert NotExpired(refundableAt);

        Milestone[] storage ms = _milestones[taskId];
        uint256 refunded;
        for (uint256 i = 0; i < ms.length; ++i) {
            if (ms[i].status == MilestoneStatus.FUNDED) {
                ms[i].status = MilestoneStatus.REFUNDED;
                refunded += ms[i].amount;
                emit MilestoneRefunded(taskId, i, ms[i].amount);
            }
        }
        _settle(taskId, t, refunded);
        usdc.safeTransfer(t.client, refunded);
    }

    // ─── Admin ───────────────────────────────────────────────────────────────

    function setFeeBps(uint16 newFeeBps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newFeeBps > MAX_FEE_BPS) revert InvalidFeeBps(newFeeBps);
        emit FeeUpdated(feeBps, newFeeBps);
        feeBps = newFeeBps;
    }

    function setFeeDistributor(address distributor) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (distributor == address(0)) revert ZeroAddress();
        emit FeeDistributorUpdated(feeDistributor, distributor);
        feeDistributor = distributor;
    }

    /// @notice Blocks new funding and releases. Refunds, refundExpired, disputes and arbitration stay open.
    ///         The admin or a PAUSER_ROLE guardian can pause; only the admin can unpause.
    function pause() external {
        if (!hasRole(PAUSER_ROLE, msg.sender) && !hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) {
            revert Unauthorized();
        }
        _pause();
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    // ─── Views ───────────────────────────────────────────────────────────────

    function getTask(bytes32 taskId) external view returns (Task memory) {
        return _tasks[taskId];
    }

    function getMilestones(bytes32 taskId) external view returns (Milestone[] memory) {
        return _milestones[taskId];
    }

    function getMilestone(bytes32 taskId, uint256 index) external view returns (Milestone memory) {
        if (index >= _milestones[taskId].length) revert InvalidIndex(taskId, index);
        return _milestones[taskId][index];
    }

    /// @notice EIP-712 digest the QUOTER signs for `client`.
    function quoteDigest(Quote calldata quote, address client) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    QUOTE_TYPEHASH,
                    quote.taskId,
                    client,
                    keccak256(abi.encodePacked(quote.providerIds)),
                    keccak256(abi.encodePacked(quote.amounts)),
                    quote.deadline,
                    quote.feeBps,
                    quote.expiry
                )
            )
        );
    }

    // solhint-disable-next-line func-name-mixedcase
    function DOMAIN_SEPARATOR() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    // ─── Internal ────────────────────────────────────────────────────────────

    /// @dev Validates the quote and records the task (effects only). Returns the total to pull.
    function _createTask(Quote calldata quote, bytes calldata quoteSig)
        private
        returns (uint256 total)
    {
        bytes32 taskId = quote.taskId;
        if (_tasks[taskId].status != TaskStatus.NONE) revert TaskExists(taskId);
        uint256 count = quote.amounts.length;
        if (count == 0 || count > MAX_MILESTONES) revert InvalidMilestoneCount(count);
        if (quote.providerIds.length != count) revert LengthMismatch();
        if (quote.deadline <= block.timestamp) revert InvalidDeadline(quote.deadline);
        if (quote.expiry < block.timestamp) revert QuoteExpired(quote.expiry);
        if (quote.feeBps > feeBps) revert QuoteFeeTooHigh(quote.feeBps, feeBps);

        address signer = ECDSA.recover(quoteDigest(quote, msg.sender), quoteSig);
        if (!hasRole(QUOTER_ROLE, signer)) revert InvalidQuoteSigner(signer);

        Milestone[] storage ms = _milestones[taskId];
        for (uint256 i = 0; i < count; ++i) {
            uint128 amount = quote.amounts[i];
            if (amount == 0) revert ZeroAmount();
            total += amount;
            ms.push(
                Milestone({
                    providerId: quote.providerIds[i], amount: amount, status: MilestoneStatus.FUNDED
                })
            );
        }

        _tasks[taskId] = Task({
            client: msg.sender,
            deadline: quote.deadline,
            feeBps: quote.feeBps,
            status: TaskStatus.FUNDED,
            totalAmount: total,
            releasedOrRefunded: 0
        });

        emit TaskFunded(
            taskId,
            msg.sender,
            total,
            quote.feeBps,
            quote.deadline,
            quote.providerIds,
            quote.amounts
        );
    }

    function _task(bytes32 taskId) private view returns (Task storage t) {
        t = _tasks[taskId];
        if (t.status == TaskStatus.NONE) revert UnknownTask(taskId);
    }

    function _fundedMilestone(bytes32 taskId, uint256 index)
        private
        view
        returns (Milestone storage m)
    {
        Milestone[] storage ms = _milestones[taskId];
        if (index >= ms.length) revert InvalidIndex(taskId, index);
        m = ms[index];
        if (m.status != MilestoneStatus.FUNDED) revert MilestoneNotFunded(taskId, index);
    }

    /// @dev Provider amount rounds DOWN; rounding dust goes to the fee.
    function _split(uint256 amount, uint16 bps)
        private
        pure
        returns (uint256 providerAmount, uint256 fee)
    {
        providerAmount = (amount * (BPS - bps)) / BPS;
        fee = amount - providerAmount;
    }

    function _settle(bytes32 taskId, Task storage t, uint256 amount) private {
        t.releasedOrRefunded += amount;
        if (t.releasedOrRefunded == t.totalAmount) {
            t.status = TaskStatus.CLOSED;
            emit TaskClosed(taskId);
        }
    }
}

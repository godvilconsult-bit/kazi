// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IAgentRegistry, IStakingVault, ProviderStatus} from "./interfaces/IKazi.sol";

/// @title StakingVault
/// @notice Two kinds of $KAZI staking with shared USDC fee-sharing rewards:
///         (a) provider bonds per providerId (slashable, 14-day unbond cooldown), and
///         (b) holder staking (7-day unstake cooldown).
///
///         Flash-staking protection: new stake sits in a `pending` bucket and only starts
///         earning once it has been held for WARMUP (1 day) AND the account is touched again
///         (any interaction, or anyone calling `poke`). Unbonding stake never earns.
///
///         Rewards use a reward-per-token accumulator. `notifyReward` distributes instantly to
///         currently active stake; if nothing is active the amount is queued for the next notify.
contract StakingVault is AccessControl, ReentrancyGuard, IStakingVault {
    using SafeERC20 for IERC20;

    bytes32 public constant SLASHER_ROLE = keccak256("SLASHER_ROLE");
    bytes32 public constant REWARD_NOTIFIER_ROLE = keccak256("REWARD_NOTIFIER_ROLE");

    uint256 private constant PRECISION = 1e36; // USDC (6 dec) per KAZI (18 dec) needs headroom
    uint256 private constant BPS = 10_000;
    uint64 public constant WARMUP = 1 days;
    uint64 public constant MAX_COOLDOWN = 60 days;
    uint16 public constant MAX_SLASH_BPS_CAP = 5_000;

    struct Account {
        uint256 active; // earning stake
        uint256 pending; // warming up; counts as bonded, does not earn yet
        uint256 unbonding; // in cooldown; slashable for providers, does not earn
        uint256 rewardPerTokenPaid;
        uint256 rewards; // accrued, unclaimed USDC
        uint64 pendingSince;
        uint64 unbondReadyAt;
    }

    IERC20 public immutable kazi;
    IERC20 public immutable usdc;
    IAgentRegistry public immutable registry;

    address public insurancePool; // receives slashed $KAZI (FeeDistributor)
    uint64 public holderCooldown = 7 days;
    uint64 public providerCooldown = 14 days;
    uint16 public maxSlashBps = 2_000;

    uint256 public rewardPerTokenStored;
    uint256 public totalActive;
    uint256 public totalTracked; // Σ(active + pending + unbonding) — all $KAZI owed to accounts
    uint256 public queuedRewards;
    uint256 public totalRewardsNotified;
    uint256 public totalRewardsClaimed;

    mapping(bytes32 key => Account) private _accounts;

    error ZeroAddress();
    error ZeroAmount();
    error NotProviderOwner(uint256 providerId);
    error ProviderDelisted(uint256 providerId);
    error InsufficientStake(uint256 available, uint256 requested);
    error BelowMinimumStake(uint256 providerId, uint256 remaining, uint256 required);
    error NothingToWithdraw();
    error CooldownActive(uint64 readyAt);
    error SlashTooLarge(uint256 amount, uint256 cap);
    error InvalidCooldown(uint64 cooldown);
    error InvalidSlashBps(uint16 bps);

    event Staked(address indexed holder, uint256 amount);
    event UnstakeRequested(address indexed holder, uint256 amount, uint64 readyAt);
    event Unstaked(address indexed holder, uint256 amount);
    event Bonded(uint256 indexed providerId, address indexed owner, uint256 amount);
    event UnbondRequested(uint256 indexed providerId, uint256 amount, uint64 readyAt);
    event Unbonded(uint256 indexed providerId, address indexed to, uint256 amount);
    event Slashed(uint256 indexed providerId, uint256 amount, bytes32 reasonHash);
    event StakeActivated(bytes32 indexed account, uint256 amount);
    event RewardNotified(uint256 amount, uint256 distributed, uint256 queued);
    event RewardClaimed(bytes32 indexed account, address indexed to, uint256 amount);
    event InsurancePoolUpdated(address oldPool, address newPool);
    event CooldownsUpdated(uint64 holderCooldown, uint64 providerCooldown);
    event MaxSlashBpsUpdated(uint16 oldBps, uint16 newBps);

    constructor(
        address admin,
        IERC20 kazi_,
        IERC20 usdc_,
        IAgentRegistry registry_,
        address insurancePool_
    ) {
        if (
            admin == address(0) || address(kazi_) == address(0) || address(usdc_) == address(0)
                || address(registry_) == address(0) || insurancePool_ == address(0)
        ) revert ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        kazi = kazi_;
        usdc = usdc_;
        registry = registry_;
        insurancePool = insurancePool_;
    }

    // ─── Holder staking ──────────────────────────────────────────────────────

    function stake(uint256 amount) external nonReentrant {
        bytes32 key = holderKey(msg.sender);
        _addPending(key, amount);
        emit Staked(msg.sender, amount);
        kazi.safeTransferFrom(msg.sender, address(this), amount);
    }

    function requestUnstake(uint256 amount) external nonReentrant {
        bytes32 key = holderKey(msg.sender);
        uint64 readyAt = _moveToUnbonding(key, amount, holderCooldown);
        emit UnstakeRequested(msg.sender, amount, readyAt);
    }

    function withdraw() external nonReentrant {
        uint256 amount = _takeUnbonded(holderKey(msg.sender));
        emit Unstaked(msg.sender, amount);
        kazi.safeTransfer(msg.sender, amount);
    }

    function claim() external nonReentrant {
        _claim(holderKey(msg.sender), msg.sender);
    }

    // ─── Provider bonds ──────────────────────────────────────────────────────

    function bond(uint256 providerId, uint256 amount) external nonReentrant {
        _requireProviderOwner(providerId);
        if (registry.statusOf(providerId) == ProviderStatus.DELISTED) {
            revert ProviderDelisted(providerId);
        }
        _addPending(providerKey(providerId), amount);
        emit Bonded(providerId, msg.sender, amount);
        kazi.safeTransferFrom(msg.sender, address(this), amount);
    }

    /// @notice An ACTIVE provider cannot drop below the minimum stake for its kind.
    function requestUnbond(uint256 providerId, uint256 amount) external nonReentrant {
        _requireProviderOwner(providerId);
        bytes32 key = providerKey(providerId);
        if (registry.statusOf(providerId) == ProviderStatus.ACTIVE) {
            Account storage a = _accounts[key];
            uint256 bonded = a.active + a.pending;
            uint256 required = registry.minStake(registry.kindOf(providerId));
            uint256 remaining = bonded > amount ? bonded - amount : 0;
            if (remaining < required) revert BelowMinimumStake(providerId, remaining, required);
        }
        uint64 readyAt = _moveToUnbonding(key, amount, providerCooldown);
        emit UnbondRequested(providerId, amount, readyAt);
    }

    function withdrawUnbonded(uint256 providerId) external nonReentrant {
        _requireProviderOwner(providerId);
        uint256 amount = _takeUnbonded(providerKey(providerId));
        emit Unbonded(providerId, msg.sender, amount);
        kazi.safeTransfer(msg.sender, amount);
    }

    function claimProviderRewards(uint256 providerId) external nonReentrant {
        _requireProviderOwner(providerId);
        _claim(providerKey(providerId), msg.sender);
    }

    /// @notice Slash up to `maxSlashBps` of a provider's total stake, including stake in cooldown.
    ///         Takes from unbonding first, then pending, then active. Slashed $KAZI goes to the insurance pool.
    function slash(uint256 providerId, uint256 amount, bytes32 reasonHash)
        external
        nonReentrant
        onlyRole(SLASHER_ROLE)
    {
        if (amount == 0) revert ZeroAmount();
        bytes32 key = providerKey(providerId);
        _updateAccount(key);
        Account storage a = _accounts[key];

        uint256 cap = ((a.active + a.pending + a.unbonding) * maxSlashBps) / BPS;
        if (amount > cap) revert SlashTooLarge(amount, cap);

        uint256 remaining = amount;
        uint256 fromUnbonding = remaining < a.unbonding ? remaining : a.unbonding;
        a.unbonding -= fromUnbonding;
        remaining -= fromUnbonding;
        uint256 fromPending = remaining < a.pending ? remaining : a.pending;
        a.pending -= fromPending;
        remaining -= fromPending;
        a.active -= remaining;
        totalActive -= remaining;
        totalTracked -= amount;

        emit Slashed(providerId, amount, reasonHash);
        kazi.safeTransfer(insurancePool, amount);
    }

    // ─── Rewards ─────────────────────────────────────────────────────────────

    /// @notice Pulls `amount` USDC from the caller and distributes it to active stake.
    function notifyReward(uint256 amount) external nonReentrant onlyRole(REWARD_NOTIFIER_ROLE) {
        if (amount == 0) revert ZeroAmount();
        totalRewardsNotified += amount;
        uint256 distributable = amount + queuedRewards;
        uint256 distributed;
        if (totalActive == 0) {
            queuedRewards = distributable;
        } else {
            queuedRewards = 0;
            distributed = distributable;
            rewardPerTokenStored += (distributable * PRECISION) / totalActive;
        }
        emit RewardNotified(amount, distributed, queuedRewards);
        usdc.safeTransferFrom(msg.sender, address(this), amount);
    }

    /// @notice Settle rewards and activate matured warm-up stake for any accounts. Callable by anyone (keeper).
    function poke(bytes32[] calldata keys) external {
        for (uint256 i = 0; i < keys.length; ++i) {
            _updateAccount(keys[i]);
        }
    }

    // ─── Admin ───────────────────────────────────────────────────────────────

    function setInsurancePool(address pool) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (pool == address(0)) revert ZeroAddress();
        emit InsurancePoolUpdated(insurancePool, pool);
        insurancePool = pool;
    }

    function setCooldowns(uint64 holderCooldown_, uint64 providerCooldown_)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        if (holderCooldown_ == 0 || holderCooldown_ > MAX_COOLDOWN) {
            revert InvalidCooldown(holderCooldown_);
        }
        if (providerCooldown_ == 0 || providerCooldown_ > MAX_COOLDOWN) {
            revert InvalidCooldown(providerCooldown_);
        }
        holderCooldown = holderCooldown_;
        providerCooldown = providerCooldown_;
        emit CooldownsUpdated(holderCooldown_, providerCooldown_);
    }

    function setMaxSlashBps(uint16 bps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (bps == 0 || bps > MAX_SLASH_BPS_CAP) revert InvalidSlashBps(bps);
        emit MaxSlashBpsUpdated(maxSlashBps, bps);
        maxSlashBps = bps;
    }

    // ─── Views ───────────────────────────────────────────────────────────────

    function holderKey(address holder) public pure returns (bytes32) {
        return bytes32(uint256(uint160(holder)));
    }

    function providerKey(uint256 providerId) public pure returns (bytes32) {
        return keccak256(abi.encode("kazi.provider", providerId));
    }

    function getAccount(bytes32 key) external view returns (Account memory) {
        return _accounts[key];
    }

    /// @notice Bonded stake (active + warming up) used by AgentRegistry for activation. Excludes unbonding.
    function stakedOf(uint256 providerId) external view returns (uint256) {
        Account storage a = _accounts[providerKey(providerId)];
        return a.active + a.pending;
    }

    function stakeOf(address holder) external view returns (uint256) {
        Account storage a = _accounts[holderKey(holder)];
        return a.active + a.pending;
    }

    /// @notice Rewards claimable now (does not include warm-up stake that has not been activated yet).
    function earned(bytes32 key) public view returns (uint256) {
        Account storage a = _accounts[key];
        return a.rewards + (a.active * (rewardPerTokenStored - a.rewardPerTokenPaid)) / PRECISION;
    }

    // ─── Internal ────────────────────────────────────────────────────────────

    /// @dev Settles rewards on current active stake, then activates warm-up stake if matured.
    function _updateAccount(bytes32 key) private {
        Account storage a = _accounts[key];
        a.rewards = earned(key);
        a.rewardPerTokenPaid = rewardPerTokenStored;
        if (a.pending != 0 && block.timestamp >= uint256(a.pendingSince) + WARMUP) {
            uint256 amount = a.pending;
            a.pending = 0;
            a.active += amount;
            totalActive += amount;
            emit StakeActivated(key, amount);
        }
    }

    function _addPending(bytes32 key, uint256 amount) private {
        if (amount == 0) revert ZeroAmount();
        _updateAccount(key);
        Account storage a = _accounts[key];
        a.pending += amount;
        a.pendingSince = uint64(block.timestamp); // topping up restarts the warm-up for the pending bucket
        totalTracked += amount;
    }

    /// @dev Takes from pending (non-earning) first, then active. Restarts the cooldown for the whole unbonding bucket.
    function _moveToUnbonding(bytes32 key, uint256 amount, uint64 cooldown)
        private
        returns (uint64 readyAt)
    {
        if (amount == 0) revert ZeroAmount();
        _updateAccount(key);
        Account storage a = _accounts[key];
        uint256 available = a.active + a.pending;
        if (amount > available) revert InsufficientStake(available, amount);

        uint256 fromPending = amount < a.pending ? amount : a.pending;
        a.pending -= fromPending;
        uint256 fromActive = amount - fromPending;
        a.active -= fromActive;
        totalActive -= fromActive;

        a.unbonding += amount;
        readyAt = uint64(block.timestamp) + cooldown;
        a.unbondReadyAt = readyAt;
    }

    function _takeUnbonded(bytes32 key) private returns (uint256 amount) {
        Account storage a = _accounts[key];
        amount = a.unbonding;
        if (amount == 0) revert NothingToWithdraw();
        if (block.timestamp < a.unbondReadyAt) revert CooldownActive(a.unbondReadyAt);
        a.unbonding = 0;
        a.unbondReadyAt = 0;
        totalTracked -= amount;
    }

    function _claim(bytes32 key, address to) private {
        _updateAccount(key);
        Account storage a = _accounts[key];
        uint256 amount = a.rewards;
        if (amount == 0) revert ZeroAmount();
        a.rewards = 0;
        totalRewardsClaimed += amount;
        emit RewardClaimed(key, to, amount);
        usdc.safeTransfer(to, amount);
    }

    function _requireProviderOwner(uint256 providerId) private view {
        if (registry.ownerOf(providerId) != msg.sender) revert NotProviderOwner(providerId);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IAgentRegistry, IStakingVault, ProviderKind, ProviderStatus} from "./interfaces/IKazi.sol";

/// @title AgentRegistry
/// @notice Onchain identity for Kazi providers (AI agents and human freelancers).
///         Payout address changes are time-delayed so a stolen owner key cannot redirect
///         earnings instantly; registrars can cancel a pending change.
contract AgentRegistry is AccessControl, IAgentRegistry {
    bytes32 public constant REGISTRAR_ROLE = keccak256("REGISTRAR_ROLE");

    uint64 public constant MIN_PAYOUT_DELAY = 1 days;
    uint64 public constant MAX_PAYOUT_DELAY = 30 days;

    struct Provider {
        address owner;
        address payout;
        bytes32 metadataHash;
        string metadataURI;
        ProviderKind kind;
        ProviderStatus status;
        uint64 registeredAt;
    }

    struct PendingPayout {
        address payout;
        uint64 effectiveAt;
    }

    IStakingVault public stakingVault;
    uint64 public payoutDelay = 2 days;
    uint256 public nextProviderId = 1;

    mapping(uint256 providerId => Provider) private _providers;
    mapping(uint256 providerId => PendingPayout) public pendingPayouts;
    mapping(ProviderKind kind => uint256) public override minStake;

    error ZeroAddress();
    error UnknownProvider(uint256 providerId);
    error NotProviderOwner(uint256 providerId);
    error InvalidStatus(uint256 providerId, ProviderStatus status);
    error InsufficientStake(uint256 providerId, uint256 staked, uint256 required);
    error StakingVaultNotSet();
    error NoPendingPayout(uint256 providerId);
    error PayoutChangeNotReady(uint256 providerId, uint64 effectiveAt);
    error InvalidPayoutDelay(uint64 delay);

    event ProviderRegistered(
        uint256 indexed providerId,
        address indexed owner,
        ProviderKind kind,
        address payout,
        string metadataURI,
        bytes32 metadataHash
    );
    event ProviderActivated(uint256 indexed providerId);
    event ProviderUpdated(uint256 indexed providerId, string metadataURI, bytes32 metadataHash);
    event ProviderSuspended(uint256 indexed providerId);
    event ProviderDelisted(uint256 indexed providerId, address indexed by);
    event PayoutChangeRequested(uint256 indexed providerId, address newPayout, uint64 effectiveAt);
    event PayoutChangeConfirmed(uint256 indexed providerId, address oldPayout, address newPayout);
    event PayoutChangeCancelled(uint256 indexed providerId, address indexed by);
    event MinStakeUpdated(ProviderKind kind, uint256 oldMinStake, uint256 newMinStake);
    event PayoutDelayUpdated(uint64 oldDelay, uint64 newDelay);
    event StakingVaultUpdated(address oldVault, address newVault);

    constructor(address admin, uint256 minAgentStake, uint256 minHumanStake) {
        if (admin == address(0)) revert ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        minStake[ProviderKind.AGENT] = minAgentStake;
        minStake[ProviderKind.HUMAN] = minHumanStake;
        emit MinStakeUpdated(ProviderKind.AGENT, 0, minAgentStake);
        emit MinStakeUpdated(ProviderKind.HUMAN, 0, minHumanStake);
    }

    // ─── Provider actions ────────────────────────────────────────────────────

    function register(
        ProviderKind kind,
        address payout,
        string calldata metadataURI,
        bytes32 metadataHash
    ) external returns (uint256 providerId) {
        if (payout == address(0)) revert ZeroAddress();
        providerId = nextProviderId++;
        _providers[providerId] = Provider({
            owner: msg.sender,
            payout: payout,
            metadataHash: metadataHash,
            metadataURI: metadataURI,
            kind: kind,
            status: ProviderStatus.PENDING,
            registeredAt: uint64(block.timestamp)
        });
        emit ProviderRegistered(providerId, msg.sender, kind, payout, metadataURI, metadataHash);
    }

    function updateMetadata(uint256 providerId, string calldata metadataURI, bytes32 metadataHash)
        external
    {
        Provider storage p = _ownedProvider(providerId);
        if (p.status == ProviderStatus.DELISTED) revert InvalidStatus(providerId, p.status);
        p.metadataURI = metadataURI;
        p.metadataHash = metadataHash;
        emit ProviderUpdated(providerId, metadataURI, metadataHash);
    }

    function requestPayoutChange(uint256 providerId, address newPayout) external {
        Provider storage p = _ownedProvider(providerId);
        if (p.status == ProviderStatus.DELISTED) revert InvalidStatus(providerId, p.status);
        if (newPayout == address(0)) revert ZeroAddress();
        uint64 effectiveAt = uint64(block.timestamp) + payoutDelay;
        pendingPayouts[providerId] = PendingPayout(newPayout, effectiveAt);
        emit PayoutChangeRequested(providerId, newPayout, effectiveAt);
    }

    function confirmPayoutChange(uint256 providerId) external {
        Provider storage p = _ownedProvider(providerId);
        PendingPayout memory pending = pendingPayouts[providerId];
        if (pending.payout == address(0)) revert NoPendingPayout(providerId);
        if (block.timestamp < pending.effectiveAt) {
            revert PayoutChangeNotReady(providerId, pending.effectiveAt);
        }
        delete pendingPayouts[providerId];
        address old = p.payout;
        p.payout = pending.payout;
        emit PayoutChangeConfirmed(providerId, old, pending.payout);
    }

    /// @notice Owner or registrar can cancel a pending payout change (e.g. after a key-compromise alert).
    function cancelPayoutChange(uint256 providerId) external {
        Provider storage p = _existingProvider(providerId);
        if (msg.sender != p.owner && !hasRole(REGISTRAR_ROLE, msg.sender)) {
            revert NotProviderOwner(providerId);
        }
        if (pendingPayouts[providerId].payout == address(0)) revert NoPendingPayout(providerId);
        delete pendingPayouts[providerId];
        emit PayoutChangeCancelled(providerId, msg.sender);
    }

    /// @notice Registrar may delist anyone; an owner may only delist their own provider.
    function delist(uint256 providerId) external {
        Provider storage p = _existingProvider(providerId);
        if (msg.sender != p.owner && !hasRole(REGISTRAR_ROLE, msg.sender)) {
            revert NotProviderOwner(providerId);
        }
        if (p.status == ProviderStatus.DELISTED) revert InvalidStatus(providerId, p.status);
        p.status = ProviderStatus.DELISTED;
        emit ProviderDelisted(providerId, msg.sender);
    }

    // ─── Registrar actions ───────────────────────────────────────────────────

    /// @notice Activate after review. Requires the provider's bond to meet the minimum for its kind.
    function activate(uint256 providerId) external onlyRole(REGISTRAR_ROLE) {
        Provider storage p = _existingProvider(providerId);
        if (p.status != ProviderStatus.PENDING && p.status != ProviderStatus.SUSPENDED) {
            revert InvalidStatus(providerId, p.status);
        }
        if (address(stakingVault) == address(0)) revert StakingVaultNotSet();
        uint256 staked = stakingVault.stakedOf(providerId);
        uint256 required = minStake[p.kind];
        if (staked < required) revert InsufficientStake(providerId, staked, required);
        p.status = ProviderStatus.ACTIVE;
        emit ProviderActivated(providerId);
    }

    function suspend(uint256 providerId) external onlyRole(REGISTRAR_ROLE) {
        Provider storage p = _existingProvider(providerId);
        if (p.status != ProviderStatus.ACTIVE && p.status != ProviderStatus.PENDING) {
            revert InvalidStatus(providerId, p.status);
        }
        p.status = ProviderStatus.SUSPENDED;
        emit ProviderSuspended(providerId);
    }

    // ─── Admin ───────────────────────────────────────────────────────────────

    function setMinStake(ProviderKind kind, uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) {
        emit MinStakeUpdated(kind, minStake[kind], amount);
        minStake[kind] = amount;
    }

    function setPayoutDelay(uint64 delay) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (delay < MIN_PAYOUT_DELAY || delay > MAX_PAYOUT_DELAY) revert InvalidPayoutDelay(delay);
        emit PayoutDelayUpdated(payoutDelay, delay);
        payoutDelay = delay;
    }

    function setStakingVault(address vault) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (vault == address(0)) revert ZeroAddress();
        emit StakingVaultUpdated(address(stakingVault), vault);
        stakingVault = IStakingVault(vault);
    }

    // ─── Views ───────────────────────────────────────────────────────────────

    function getProvider(uint256 providerId) external view returns (Provider memory) {
        return _existingProvider(providerId);
    }

    function ownerOf(uint256 providerId) external view returns (address) {
        return _existingProvider(providerId).owner;
    }

    function kindOf(uint256 providerId) external view returns (ProviderKind) {
        return _existingProvider(providerId).kind;
    }

    /// @notice Returns NONE for unknown ids (does not revert) so callers can branch on it.
    function statusOf(uint256 providerId) external view returns (ProviderStatus) {
        return _providers[providerId].status;
    }

    /// @notice The effective payout address (pending changes are not effective until confirmed).
    function payoutOf(uint256 providerId) external view returns (address) {
        return _existingProvider(providerId).payout;
    }

    // ─── Internal ────────────────────────────────────────────────────────────

    function _existingProvider(uint256 providerId) private view returns (Provider storage p) {
        p = _providers[providerId];
        if (p.status == ProviderStatus.NONE) revert UnknownProvider(providerId);
    }

    function _ownedProvider(uint256 providerId) private view returns (Provider storage p) {
        p = _existingProvider(providerId);
        if (p.owner != msg.sender) revert NotProviderOwner(providerId);
    }
}

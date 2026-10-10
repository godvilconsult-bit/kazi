// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

/// @title KaziAirdrop
/// @notice Merkle airdrop of $KAZI with vesting built in (docs/08-TOKENOMICS.md §1): each recipient's
///         allocation unlocks `immediateBps` at `start` and the rest linearly over `vestingDuration`.
///         Recipients claim whatever has vested so far, as often as they like. Leaves follow the
///         OpenZeppelin StandardMerkleTree encoding: keccak256(bytes.concat(keccak256(abi.encode(account, amount)))).
///         After `claimDeadline` the admin (the Safe) can sweep what was never claimed to the treasury.
contract KaziAirdrop is AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 private constant BPS = 10_000;

    IERC20 public immutable token;
    bytes32 public immutable merkleRoot;
    uint64 public immutable start;
    uint64 public immutable vestingDuration;
    uint16 public immutable immediateBps;
    uint64 public immutable claimDeadline;

    /// @notice Tokens already sent to each recipient.
    mapping(address account => uint256) public claimed;
    uint256 public totalClaimed;

    error ZeroAddress();
    error InvalidSchedule();
    error InvalidProof();
    error NothingToClaim();
    error ClaimingNotStarted(uint64 start);
    error ClaimingClosed(uint64 deadline);
    error DeadlineNotReached(uint64 deadline);

    event Claimed(address indexed account, uint256 amount, uint256 totalClaimed);
    event Swept(address indexed to, uint256 amount);

    constructor(
        address admin,
        IERC20 token_,
        bytes32 merkleRoot_,
        uint64 start_,
        uint64 vestingDuration_,
        uint16 immediateBps_,
        uint64 claimDeadline_
    ) {
        if (admin == address(0) || address(token_) == address(0)) {
            revert ZeroAddress();
        }
        if (immediateBps_ > BPS || claimDeadline_ <= uint256(start_) + vestingDuration_) {
            revert InvalidSchedule();
        }
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        token = token_;
        merkleRoot = merkleRoot_;
        start = start_;
        vestingDuration = vestingDuration_;
        immediateBps = immediateBps_;
        claimDeadline = claimDeadline_;
    }

    /// @notice How much of `allocation` has vested at `timestamp`.
    function vested(uint256 allocation, uint64 timestamp) public view returns (uint256) {
        if (timestamp < start) return 0;
        uint256 immediate = (allocation * immediateBps) / BPS;
        uint256 rest = allocation - immediate;
        if (vestingDuration == 0 || timestamp >= uint256(start) + vestingDuration) {
            return allocation;
        }
        return immediate + (rest * (timestamp - start)) / vestingDuration;
    }

    /// @notice What `account` could claim right now for a proven `allocation`.
    function claimable(address account, uint256 allocation) external view returns (uint256) {
        if (block.timestamp > claimDeadline) return 0;
        uint256 v = vested(allocation, uint64(block.timestamp));
        return v > claimed[account] ? v - claimed[account] : 0;
    }

    /// @notice Claim the vested part of the caller's allocation.
    function claim(uint256 allocation, bytes32[] calldata proof) external nonReentrant {
        if (block.timestamp < start) revert ClaimingNotStarted(start);
        if (block.timestamp > claimDeadline) revert ClaimingClosed(claimDeadline);
        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(msg.sender, allocation))));
        if (!MerkleProof.verifyCalldata(proof, merkleRoot, leaf)) revert InvalidProof();

        uint256 v = vested(allocation, uint64(block.timestamp));
        uint256 already = claimed[msg.sender];
        if (v <= already) revert NothingToClaim();
        uint256 amount = v - already;

        claimed[msg.sender] = v;
        totalClaimed += amount;
        emit Claimed(msg.sender, amount, v);
        token.safeTransfer(msg.sender, amount);
    }

    /// @notice After the deadline, send everything left (never claimed) to `to` (the treasury).
    function sweep(address to) external nonReentrant onlyRole(DEFAULT_ADMIN_ROLE) {
        if (to == address(0)) revert ZeroAddress();
        if (block.timestamp <= claimDeadline) revert DeadlineNotReached(claimDeadline);
        uint256 amount = token.balanceOf(address(this));
        if (amount == 0) revert NothingToClaim();
        emit Swept(to, amount);
        token.safeTransfer(to, amount);
    }
}

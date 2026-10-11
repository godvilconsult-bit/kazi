// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title KaziCreditsGate
/// @notice 1:1 exchange between the publicly traded KAZI (launched on Argus) and KAZI Credits
///         (KaziToken, the token every Kazi contract uses for staking and provider bonds).
///
///         `lock` takes KAZI and pays out the same amount of Credits from the gate's reserve;
///         `unlock` takes Credits back and returns the same amount of KAZI. The reserve is the
///         Credits supply deposited into the gate (all of it, so every Credit in circulation came
///         out of the gate against locked KAZI). Nobody — not Kazi, not the admin — can move the
///         locked KAZI or the reserve except through `unlock` / `lock`.
///
///         The guardian can pause `lock` (e.g. if the KAZI token turns out to be compromised);
///         `unlock` is never paused, so Credit holders can always exit. Only the admin unpauses.
///         Tokens that take a fee on transfer are refused: `lock` checks what actually arrived.
contract KaziCreditsGate is AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    IERC20 public immutable kazi; // KAZI on Argus
    IERC20 public immutable credits; // KAZI Credits (KaziToken)

    /// @notice KAZI held for Credit holders: Σ lock − Σ unlock.
    uint256 public totalLocked;
    bool public paused;

    error ZeroAddress();
    error ZeroAmount();
    error SameToken();
    error DecimalsMismatch(uint8 kaziDecimals, uint8 creditsDecimals);
    error LockPaused();
    error InsufficientReserve(uint256 available, uint256 requested);
    error InsufficientLocked(uint256 available, uint256 requested);
    error TransferFeeNotSupported(uint256 received, uint256 expected);

    event Locked(address indexed account, uint256 amount);
    event Unlocked(address indexed account, uint256 amount);
    event Paused(address indexed by);
    event Unpaused(address indexed by);

    constructor(address admin, address pauser, IERC20Metadata kazi_, IERC20Metadata credits_) {
        if (
            admin == address(0) || pauser == address(0) || address(kazi_) == address(0)
                || address(credits_) == address(0)
        ) revert ZeroAddress();
        if (address(kazi_) == address(credits_)) revert SameToken();
        uint8 kd = kazi_.decimals();
        uint8 cd = credits_.decimals();
        if (kd != cd) revert DecimalsMismatch(kd, cd);
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(PAUSER_ROLE, pauser);
        kazi = kazi_;
        credits = credits_;
    }

    /// @notice Lock `amount` KAZI and receive `amount` KAZI Credits.
    function lock(uint256 amount) external nonReentrant {
        if (paused) revert LockPaused();
        if (amount == 0) revert ZeroAmount();
        uint256 available = credits.balanceOf(address(this));
        if (available < amount) revert InsufficientReserve(available, amount);
        totalLocked += amount;
        emit Locked(msg.sender, amount);

        uint256 before = kazi.balanceOf(address(this));
        kazi.safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = kazi.balanceOf(address(this)) - before;
        if (received != amount) revert TransferFeeNotSupported(received, amount);
        credits.safeTransfer(msg.sender, amount);
    }

    /// @notice Return `amount` KAZI Credits and receive `amount` KAZI. Never paused.
    function unlock(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (amount > totalLocked) revert InsufficientLocked(totalLocked, amount);
        totalLocked -= amount;
        emit Unlocked(msg.sender, amount);

        credits.safeTransferFrom(msg.sender, address(this), amount);
        kazi.safeTransfer(msg.sender, amount);
    }

    function pause() external onlyRole(PAUSER_ROLE) {
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        paused = false;
        emit Unpaused(msg.sender);
    }

    // ─── Views (token page) ──────────────────────────────────────────────────

    /// @notice Credits the gate can still hand out.
    function reserve() external view returns (uint256) {
        return credits.balanceOf(address(this));
    }

    /// @notice Credits outside the gate.
    function outstanding() public view returns (uint256) {
        return credits.totalSupply() - credits.balanceOf(address(this));
    }

    /// @notice True when every Credit outside the gate can be exchanged back for locked KAZI.
    function fullyBacked() external view returns (bool) {
        return outstanding() <= totalLocked && kazi.balanceOf(address(this)) >= totalLocked;
    }
}

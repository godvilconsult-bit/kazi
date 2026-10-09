// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IStakingVault} from "./interfaces/IKazi.sol";

/// @title FeeDistributor
/// @notice Receives USDC platform fees from TaskEscrow and splits them on `distribute()`:
///         treasury / stakers (via StakingVault.notifyReward) / buyback reserve.
///         Also holds the insurance pool of slashed $KAZI, paid out by the admin multisig.
contract FeeDistributor is AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 private constant BPS = 10_000;

    IERC20 public immutable usdc;
    IERC20 public immutable kazi;

    address public treasury;
    address public buybackReserve;
    IStakingVault public stakingVault;

    uint16 public treasuryBps;
    uint16 public stakerBps;
    uint16 public buybackBps;

    error ZeroAddress();
    error ZeroAmount();
    error InvalidSplit(uint256 total);
    error StakingVaultNotSet();
    error NothingToDistribute();

    event Distributed(uint256 total, uint256 toTreasury, uint256 toStakers, uint256 toBuyback);
    event SplitUpdated(uint16 treasuryBps, uint16 stakerBps, uint16 buybackBps);
    event TreasuryUpdated(address oldTreasury, address newTreasury);
    event BuybackReserveUpdated(address oldReserve, address newReserve);
    event StakingVaultUpdated(address oldVault, address newVault);
    event Compensated(address indexed to, uint256 amount);

    constructor(
        address admin,
        IERC20 usdc_,
        IERC20 kazi_,
        address treasury_,
        address buybackReserve_,
        uint16 treasuryBps_,
        uint16 stakerBps_,
        uint16 buybackBps_
    ) {
        if (
            admin == address(0) || address(usdc_) == address(0) || address(kazi_) == address(0)
                || treasury_ == address(0) || buybackReserve_ == address(0)
        ) revert ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        usdc = usdc_;
        kazi = kazi_;
        treasury = treasury_;
        buybackReserve = buybackReserve_;
        _setSplit(treasuryBps_, stakerBps_, buybackBps_);
    }

    /// @notice Anyone (or a keeper) can trigger distribution of the full USDC balance.
    /// @dev If stakerBps > 0 the staking vault must be set. Rounding dust goes to the buyback reserve.
    function distribute() external nonReentrant {
        uint256 total = usdc.balanceOf(address(this));
        if (total == 0) revert NothingToDistribute();

        uint256 toTreasury = (total * treasuryBps) / BPS;
        uint256 toStakers = (total * stakerBps) / BPS;
        uint256 toBuyback = total - toTreasury - toStakers;

        if (toStakers != 0 && address(stakingVault) == address(0)) revert StakingVaultNotSet();

        emit Distributed(total, toTreasury, toStakers, toBuyback);

        if (toTreasury != 0) usdc.safeTransfer(treasury, toTreasury);
        if (toBuyback != 0) usdc.safeTransfer(buybackReserve, toBuyback);
        if (toStakers != 0) {
            usdc.forceApprove(address(stakingVault), toStakers);
            stakingVault.notifyReward(toStakers);
        }
    }

    /// @notice Pay compensation to a harmed client from the insurance pool (slashed $KAZI).
    function compensate(address to, uint256 amount)
        external
        nonReentrant
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        emit Compensated(to, amount);
        kazi.safeTransfer(to, amount);
    }

    function setSplit(uint16 treasuryBps_, uint16 stakerBps_, uint16 buybackBps_)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        _setSplit(treasuryBps_, stakerBps_, buybackBps_);
    }

    function setTreasury(address treasury_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (treasury_ == address(0)) revert ZeroAddress();
        emit TreasuryUpdated(treasury, treasury_);
        treasury = treasury_;
    }

    function setBuybackReserve(address reserve) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (reserve == address(0)) revert ZeroAddress();
        emit BuybackReserveUpdated(buybackReserve, reserve);
        buybackReserve = reserve;
    }

    function setStakingVault(address vault) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (vault == address(0)) revert ZeroAddress();
        emit StakingVaultUpdated(address(stakingVault), vault);
        stakingVault = IStakingVault(vault);
    }

    function _setSplit(uint16 treasuryBps_, uint16 stakerBps_, uint16 buybackBps_) private {
        uint256 sum = uint256(treasuryBps_) + stakerBps_ + buybackBps_;
        if (sum != BPS) revert InvalidSplit(sum);
        treasuryBps = treasuryBps_;
        stakerBps = stakerBps_;
        buybackBps = buybackBps_;
        emit SplitUpdated(treasuryBps_, stakerBps_, buybackBps_);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {ERC20Votes} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Votes.sol";
import {Nonces} from "@openzeppelin/contracts/utils/Nonces.sol";

/// @title KaziToken
/// @notice Fixed-supply governance/utility token. The whole supply is minted once in the
///         constructor. There is no mint function, transfer tax, blacklist, pause or owner.
contract KaziToken is ERC20, ERC20Permit, ERC20Votes {
    error ZeroAddress();
    error ZeroSupply();

    constructor(
        string memory name_,
        string memory symbol_,
        address distributor,
        uint256 totalSupply_
    ) ERC20(name_, symbol_) ERC20Permit(name_) {
        if (distributor == address(0)) revert ZeroAddress();
        if (totalSupply_ == 0) revert ZeroSupply();
        _mint(distributor, totalSupply_);
    }

    /// @dev Timestamp-based clock: Arc blocks are 0.5s and block numbers make poor governance periods.
    function clock() public view override returns (uint48) {
        return uint48(block.timestamp);
    }

    // solhint-disable-next-line func-name-mixedcase
    function CLOCK_MODE() public pure override returns (string memory) {
        return "mode=timestamp";
    }

    function _update(address from, address to, uint256 value) internal override(ERC20, ERC20Votes) {
        super._update(from, to, value);
    }

    function nonces(address owner) public view override(ERC20Permit, Nonces) returns (uint256) {
        return super.nonces(owner);
    }
}

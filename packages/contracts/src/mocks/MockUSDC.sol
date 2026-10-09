// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

/// @notice Test-only USDC stand-in: configurable decimals, EIP-2612 permit, open mint,
///         and a blocklist that makes transfers revert (mirrors Arc USDC blocklisting).
contract MockUSDC is ERC20, ERC20Permit {
    uint8 private immutable _decimals;
    mapping(address => bool) public blocklisted;

    error Blocklisted(address account);

    constructor(uint8 decimals_) ERC20("Mock USDC", "USDC") ERC20Permit("Mock USDC") {
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setBlocklisted(address account, bool value) external {
        blocklisted[account] = value;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (blocklisted[from]) revert Blocklisted(from);
        if (blocklisted[to]) revert Blocklisted(to);
        super._update(from, to, value);
    }
}

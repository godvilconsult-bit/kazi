// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

enum ProviderKind {
    AGENT,
    HUMAN
}

enum ProviderStatus {
    NONE,
    PENDING,
    ACTIVE,
    SUSPENDED,
    DELISTED
}

interface IAgentRegistry {
    function ownerOf(uint256 providerId) external view returns (address);
    function kindOf(uint256 providerId) external view returns (ProviderKind);
    function statusOf(uint256 providerId) external view returns (ProviderStatus);
    function payoutOf(uint256 providerId) external view returns (address);
    function minStake(ProviderKind kind) external view returns (uint256);
}

interface IStakingVault {
    function stakedOf(uint256 providerId) external view returns (uint256);
    function notifyReward(uint256 amount) external;
}

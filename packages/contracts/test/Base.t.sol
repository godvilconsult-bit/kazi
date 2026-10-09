// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {KaziToken} from "../src/KaziToken.sol";
import {AgentRegistry} from "../src/AgentRegistry.sol";
import {StakingVault} from "../src/StakingVault.sol";
import {FeeDistributor} from "../src/FeeDistributor.sol";
import {TaskEscrow} from "../src/TaskEscrow.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";
import {IAgentRegistry, ProviderKind} from "../src/interfaces/IKazi.sol";

/// @notice Deploys and wires the full Kazi system the same way script/Deploy.s.sol does.
abstract contract KaziBase is Test {
    uint16 internal constant FEE_BPS = 1_200;
    uint64 internal constant GRACE = 7 days;
    uint256 internal constant SUPPLY = 1_000_000_000e18;
    uint256 internal constant MIN_AGENT = 10_000e18;
    uint256 internal constant MIN_HUMAN = 2_000e18;

    MockUSDC internal usdc;
    KaziToken internal kazi;
    AgentRegistry internal registry;
    StakingVault internal vault;
    FeeDistributor internal distributor;
    TaskEscrow internal escrow;

    address internal admin = makeAddr("admin");
    address internal operator = makeAddr("operator");
    address internal registrar = makeAddr("registrar");
    address internal slasher = makeAddr("slasher");
    address internal arbiter = makeAddr("arbiter");
    address internal treasury = makeAddr("treasury");
    address internal buyback = makeAddr("buyback");
    address internal client = makeAddr("client");
    address internal dev = makeAddr("dev");
    address internal payout = makeAddr("payout");

    uint256 internal quoterPk = 0xA11CE;
    address internal quoter;

    function setUp() public virtual {
        _deploy(6);
    }

    function _deploy(uint8 usdcDecimals) internal {
        quoter = vm.addr(quoterPk);
        usdc = new MockUSDC(usdcDecimals);
        kazi = new KaziToken("Kazi", "KAZI", admin, SUPPLY);
        registry = new AgentRegistry(admin, MIN_AGENT, MIN_HUMAN);
        distributor = new FeeDistributor(admin, usdc, kazi, treasury, buyback, 5_000, 3_000, 2_000);
        vault = new StakingVault(
            admin, kazi, usdc, IAgentRegistry(address(registry)), address(distributor)
        );
        escrow = new TaskEscrow(
            admin, usdc, IAgentRegistry(address(registry)), address(distributor), FEE_BPS, GRACE
        );

        vm.startPrank(admin);
        registry.setStakingVault(address(vault));
        distributor.setStakingVault(address(vault));
        registry.grantRole(registry.REGISTRAR_ROLE(), registrar);
        vault.grantRole(vault.SLASHER_ROLE(), slasher);
        vault.grantRole(vault.REWARD_NOTIFIER_ROLE(), address(distributor));
        escrow.grantRole(escrow.OPERATOR_ROLE(), operator);
        escrow.grantRole(escrow.QUOTER_ROLE(), quoter);
        escrow.grantRole(escrow.ARBITER_ROLE(), arbiter);
        vm.stopPrank();
    }

    function _usd(uint256 whole) internal view returns (uint256) {
        return whole * 10 ** usdc.decimals();
    }

    function _giveKazi(address to, uint256 amount) internal {
        vm.prank(admin);
        kazi.transfer(to, amount);
    }

    /// @dev Registers, bonds the minimum and activates a provider owned by `owner`.
    function _activeProvider(address owner, ProviderKind kind) internal returns (uint256 id) {
        vm.prank(owner);
        id = registry.register(kind, payout, "ipfs://manifest", keccak256("manifest"));
        uint256 bond = registry.minStake(kind);
        _giveKazi(owner, bond);
        vm.startPrank(owner);
        kazi.approve(address(vault), bond);
        vault.bond(id, bond);
        vm.stopPrank();
        vm.prank(registrar);
        registry.activate(id);
    }

    function _quote(bytes32 taskId, uint256[] memory providerIds, uint128[] memory amounts)
        internal
        view
        returns (TaskEscrow.Quote memory q)
    {
        q = TaskEscrow.Quote({
            taskId: taskId,
            providerIds: providerIds,
            amounts: amounts,
            deadline: uint64(block.timestamp + 3 days),
            feeBps: FEE_BPS,
            expiry: uint64(block.timestamp + 30 minutes)
        });
    }

    function _sign(TaskEscrow.Quote memory q, address forClient, uint256 pk)
        internal
        view
        returns (bytes memory)
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, escrow.quoteDigest(q, forClient));
        return abi.encodePacked(r, s, v);
    }

    function _fund(address who, TaskEscrow.Quote memory q) internal {
        uint256 total;
        for (uint256 i = 0; i < q.amounts.length; ++i) {
            total += q.amounts[i];
        }
        usdc.mint(who, total);
        bytes memory sig = _sign(q, who, quoterPk);
        vm.startPrank(who);
        usdc.approve(address(escrow), total);
        escrow.createAndFund(q, sig);
        vm.stopPrank();
    }

    function _single(uint256 providerId, uint128 amount)
        internal
        pure
        returns (uint256[] memory ids, uint128[] memory amounts)
    {
        ids = new uint256[](1);
        amounts = new uint128[](1);
        ids[0] = providerId;
        amounts[0] = amount;
    }

    function _pair(uint256 idA, uint128 amountA, uint256 idB, uint128 amountB)
        internal
        pure
        returns (uint256[] memory ids, uint128[] memory amounts)
    {
        ids = new uint256[](2);
        amounts = new uint128[](2);
        (ids[0], ids[1]) = (idA, idB);
        (amounts[0], amounts[1]) = (amountA, amountB);
    }
}
